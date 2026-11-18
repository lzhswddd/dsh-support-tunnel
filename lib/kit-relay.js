/**
 * Kit stream relay, client half.
 *
 * The tunnel server gives every connected kit a loopback port on the server
 * machine. A control side running there can ssh to 127.0.0.1:<port> directly; a
 * control side on another network cannot, because those ports are never exposed.
 *
 * For that case we open the same port number locally and forward each accepted
 * connection through the admin port the router already forwards. Nothing above
 * this layer changes: ssh still dials 127.0.0.1:<port>, the bytes just take a
 * longer route.
 */

import net from 'node:net'
import https from 'node:https'
import crypto from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Encode one masked client -> server frame. */
function maskedFrame(payload, opcode = 0x2) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  const mask = crypto.randomBytes(4)
  const body = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i += 1) body[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, body])
}

/** Incremental server -> client parser; these frames are unmasked. */
function parseFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset]
    const b1 = buffer[offset + 1]
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let length = b1 & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let mask
    if (masked) {
      if (cursor + 4 > buffer.length) break
      mask = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (cursor + length > buffer.length) break
    let payload = buffer.subarray(cursor, cursor + length)
    if (masked) {
      const out = Buffer.allocUnsafe(length)
      for (let i = 0; i < length; i += 1) out[i] = payload[i] ^ mask[i % 4]
      payload = out
    }
    frames.push({ opcode, payload })
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

/**
 * @param baseUrl    the admin API base, e.g. https://host:24444
 * @param getAgent   () => https.Agent | null   (the pinned agent from remote.js)
 * @param getAuth    () => Promise<{ headers }> (bearer token, resolved lazily)
 * @param onLog      (message) => void
 */
export function createKitRelay({ baseUrl, getAgent, getAuth, onLog } = {}) {
  const log = typeof onLog === 'function' ? onLog : () => {}
  const debug = process.env.TUNNEL_RELAY_DEBUG === '1'
  const trace = (m) => { if (debug) log('relay ' + m) }
  /** port -> { server, kitId, connections } */
  const listeners = new Map()
  let closed = false

  const wsBase = String(baseUrl || '')
    .replace(/\/+$/, '')
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:')

  /** Open one upgraded connection to the relay endpoint for a kit. */
  async function openStream(tcpSocket, kitId) {
    let auth
    try {
      auth = await getAuth()
    } catch (err) {
      tcpSocket.destroy()
      log(`kit relay: no credentials (${err?.message || err})`)
      return
    }
    const agent = typeof getAgent === 'function' ? getAgent() : null
    const url = new URL(`${wsBase}/api/kit/${encodeURIComponent(kitId)}/stream`)
    const options = {
      method: 'GET',
      host: url.hostname,
      port: url.port || (url.protocol === 'wss:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        ...(auth?.headers || {}),
      },
    }
    if (agent) options.agent = agent
    const lib = url.protocol === 'wss:' ? https : (await import('node:http')).default

    const req = lib.request(options)
    let upstream = null
    let pending = Buffer.alloc(0)
    let done = false

    /**
     * Close gracefully. Destroying here would cut the tail that the peer is still
     * reading, and ssh would sit waiting for a disconnect that never arrives.
     */
    const finish = () => {
      if (done) return
      done = true
      try {
        if (upstream && upstream.writable) {
          upstream.write(maskedFrame(Buffer.alloc(0), 0x8))
          upstream.end()
        }
      } catch { /* gone */ }
      try { tcpSocket.end() } catch { /* gone */ }
      const reaper = setTimeout(() => {
        try { if (upstream) upstream.destroy() } catch { /* gone */ }
        try { tcpSocket.destroy() } catch { /* gone */ }
      }, 2000)
      if (typeof reaper.unref === 'function') reaper.unref()
    }

    req.on('upgrade', (res, socket, head) => {
      upstream = socket
      tcpSocket.setNoDelay(true)
      upstream.setNoDelay(true)
      pending = head && head.length ? Buffer.from(head) : Buffer.alloc(0)

      // WebSocket has no half-close, so a zero-length binary frame means "this
      // side will send no more". ssh half-closes when it finishes writing and
      // expects to keep reading; treating that as a full close loses the reply.
      let localDone = false
      let remoteDone = false
      const sendEof = () => {
        try {
          if (upstream && upstream.writable) upstream.write(maskedFrame(Buffer.alloc(0), 0x2))
        } catch { /* gone */ }
      }

      const drain = () => {
        if (!pending.length) return
        const { frames, rest } = parseFrames(pending)
        pending = Buffer.from(rest)
        for (const frame of frames) {
          trace('frame opcode=' + frame.opcode + ' len=' + frame.payload.length)
          if (frame.opcode === 0x8) { finish(); return }
          if (frame.opcode === 0x9) { try { upstream.write(maskedFrame(frame.payload, 0xa)) } catch { /* gone */ } ; continue }
          if (frame.opcode === 0xa) continue
          if (!frame.payload.length) {
            remoteDone = true
            try { tcpSocket.end() } catch { /* gone */ }
            if (localDone) finish()
            continue
          }
          if (tcpSocket.writable) tcpSocket.write(frame.payload)
        }
      }

      upstream.on('data', (chunk) => { pending = Buffer.concat([pending, chunk]); drain() })
      upstream.on('end', () => { trace('ws end'); finish() })
      upstream.on('error', (e) => { trace('ws error ' + e.message); finish() })
      upstream.on('close', () => { trace('ws close'); finish() })
      tcpSocket.on('data', (chunk) => {
        if (!upstream || !upstream.writable) return
        try { upstream.write(maskedFrame(chunk)) } catch { finish() }
      })
      // Forward a local FIN as a half-close, not as a full close.
      tcpSocket.on('end', () => {
        trace('tcp end')
        localDone = true
        sendEof()
        if (remoteDone) finish()
      })
      tcpSocket.on('close', () => { trace('tcp close'); finish() })
      drain()
    })

    req.on('response', (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        log(`kit relay ${kitId}: HTTP ${res.statusCode} ${Buffer.concat(chunks).toString('utf8').slice(0, 120)}`)
        finish()
      })
    })
    req.on('error', (err) => {
      if (!upstream) log(`kit relay ${kitId}: ${err?.message || err}`)
      finish()
    })
    req.end()
  }

  /**
   * Make sure 127.0.0.1:<port> accepts connections here and forwards them to the
   * kit. Idempotent; resolves once the port is known to be ours. If the port is
   * already in use by something else we leave it alone — that is the case when
   * this machine is the tunnel server itself.
   */
  async function ensure(kitId, port) {
    if (closed) return { ok: false, error: 'relay closed' }
    const wanted = Number(port) || 0
    if (!kitId || wanted <= 0) return { ok: false, error: 'kitId and port are required' }

    const existing = listeners.get(wanted)
    if (existing) {
      // A kit reconnects on the same port; keep the listener, retarget it.
      existing.kitId = kitId
      return { ok: true, port: wanted, reused: true }
    }

    return await new Promise((resolve) => {
      const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        socket.on('error', () => { /* client went away */ })
        const target = listeners.get(wanted)
        openStream(socket, target?.kitId || kitId).catch((err) => {
          log(`kit relay ${kitId}: ${err?.message || err}`)
          socket.destroy()
        })
      })
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // Something on this machine already owns the port — most likely the
          // tunnel server itself, which is the correct situation.
          listeners.delete(wanted)
          resolve({ ok: true, port: wanted, local: true })
          return
        }
        log(`kit relay ${kitId}: ${err.code || err.message}`)
        resolve({ ok: false, error: err.message })
      })
      server.listen(wanted, '127.0.0.1', () => {
        listeners.set(wanted, { server, kitId })
        log(`kit relay ${kitId}: 127.0.0.1:${wanted} → server`)
        resolve({ ok: true, port: wanted })
      })
    })
  }

  function close() {
    closed = true
    for (const { server } of listeners.values()) {
      try { server.close() } catch { /* gone */ }
    }
    listeners.clear()
  }

  return {
    ensure,
    close,
    get ports() {
      return [...listeners.keys()]
    },
  }
}
