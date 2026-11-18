/**
 * noVNC bridge: serve the web VNC client and translate WebSocket <-> raw TCP.
 *
 * Why this exists: `ssh -L` only opens a port. Watching it still needed a VNC
 * viewer installed on the operator's machine. noVNC runs the VNC client in the
 * browser, so all that is left is the WebSocket-to-TCP conversion websockify
 * normally does — this file instead, with no dependency.
 *
 *   GET  /vnc.html?port=<localPort>   -> the client page
 *   WS   /ws?port=<localPort>         -> frames relayed to 127.0.0.1:<localPort>
 *
 * Only loopback listeners: the target ports belong to ssh forwards on this Host.
 */

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.join(HERE, '..', 'web', 'novnc')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function isLocal(req) {
  const address = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '')
  return address === '' || address === '127.0.0.1' || address === '::1'
}

/** Encode one unmasked server -> client frame. */
function wsFrame(payload, opcode = 0x2) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * Incremental client -> server frame parser. Returns { frames, rest } where
 * frames is [{ opcode, payload }].
 */
function parseFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset]
    const b1 = buffer[offset + 1]
    const fin = (b0 & 0x80) !== 0
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
    frames.push({ opcode, payload, fin })
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

export function createNoVncProxy({ port = 6080, rootDir = DEFAULT_ROOT, onLog } = {}) {
  const log = typeof onLog === 'function' ? onLog : () => {}
  const root = rootDir

  function serveStatic(req, res, pathname) {
    const relative = pathname === '/' ? '/vnc.html' : pathname
    const target = path.join(root, decodeURIComponent(relative))
    // Path traversal guard: the joined path must stay inside root.
    if (!target.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    fs.stat(target, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-length': stat.size,
      })
      fs.createReadStream(target).pipe(res)
    })
  }

  function handleUpgrade(req, socket, head) {
    if (!isLocal(req)) {
      socket.destroy()
      return
    }
    const url = new URL(req.url || '/', 'http://novnc.local')
    const key = String(req.headers['sec-websocket-key'] || '')
    if (!key) {
      socket.destroy()
      return
    }

    // vnc_lite.html builds its URL as ws://host:port/<path>, so the target port
    // rides in the path: /ws/5901. The query form is kept for manual testing.
    const match = /^\/ws\/(\d+)$/.exec(url.pathname)
    const targetPort = match ? Number(match[1]) : Number(url.searchParams.get('port'))
    if (!Number.isInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
      socket.destroy()
      return
    }

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )

    const tcp = net.connect({ host: '127.0.0.1', port: targetPort })
    tcp.setNoDelay(true)
    socket.setNoDelay(true)

    let pending = Buffer.alloc(0)
    if (head && head.length) pending = Buffer.from(head)

    // client -> tcp
    const pumpClient = () => {
      const { frames, rest } = parseFrames(pending)
      pending = Buffer.from(rest)
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          try { socket.end() } catch { /* already closed */ }
          try { tcp.destroy() } catch { /* already closed */ }
          return false
        }
        if (frame.opcode === 0x9) {
          try { socket.write(wsFrame(frame.payload, 0xa)) } catch { return false }
          continue
        }
        if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
          if (!tcp.write(frame.payload)) {
            socket.pause()
            tcp.once('drain', () => socket.resume())
          }
        }
      }
      return true
    }

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      pumpClient()
    })
    if (pending.length) pumpClient()

    // tcp -> client
    tcp.on('data', (chunk) => {
      try {
        if (!socket.write(wsFrame(chunk))) {
          tcp.pause()
          socket.once('drain', () => tcp.resume())
        }
      } catch {
        tcp.destroy()
      }
    })

    const close = (why) => {
      log(`novnc ws closed (${targetPort}): ${why}`)
      try { socket.destroy() } catch { /* ignore */ }
      try { tcp.destroy() } catch { /* ignore */ }
    }
    tcp.on('close', () => close('tcp closed'))
    tcp.on('error', (err) => close(`tcp error ${err.message}`))
    socket.on('close', () => close('ws closed'))
    socket.on('error', () => close('ws error'))
  }

  const server = http.createServer((req, res) => {
    if (!isLocal(req)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden')
      return
    }
    const url = new URL(req.url || '/', 'http://novnc.local')
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      return
    }
    serveStatic(req, res, url.pathname)
  })
  server.on('upgrade', handleUpgrade)

  function start() {
    return new Promise((resolve) => {
      server.once('error', (err) => resolve({ listening: false, error: err.message }))
      server.listen(port, '127.0.0.1', () => {
        log(`novnc bridge on 127.0.0.1:${port} (root ${root})`)
        resolve({ listening: true, port })
      })
    })
  }

  function stop() {
    try { server.close() } catch { /* ignore */ }
  }

  return { start, stop, port }
}
