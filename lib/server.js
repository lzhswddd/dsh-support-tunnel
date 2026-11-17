/**
 * Tunnel server: one HTTPS listener, one loopback port per connected kit.
 *
 * A client holds a single long-lived POST /t/<kitId> request with chunked bodies
 * in both directions. Every local TCP connection accepted on the kit's loopback
 * port becomes a stream inside that request, so several ssh/scp sessions share
 * one inbound port and one router mapping.
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FRAME, FrameDecoder, encodeFrame, encodeDataChunk } from './protocol.js'
import { PortPool } from './ports.js'
import { ensureCertificate, dshHome } from './cert.js'

const PING_INTERVAL_MS = 30_000
const PONG_TIMEOUT_MS = 10_000
const LOOPBACK = '127.0.0.1'
const MAX_STREAM_ID = 0xffffffff
/**
 * Let the kernel-facing buffers absorb this much before throttling a stream.
 * Node's default high-water mark is 16 KiB, so pausing on every `write() ===
 * false` produced one stop/start per frame and capped throughput at roughly a
 * quarter of a plain TCP copy. Overridable for benchmarking only.
 */
const BUFFER_HIGH_WATER = Number(process.env.TUNNEL_HIGH_WATER) || 2 * 1024 * 1024
/** Bytes buffered per stream before forcing a write, see flushBatch(). */
const BATCH_BYTES = 4 * 60 * 1024
const KITS_CACHE_MS = 2000

// ------------------------------------------------------------------ utilities

function asText(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  const text = String(value).trim()
  return text || fallback
}

function asPort(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function firstExisting(...files) {
  for (const file of files) {
    if (file && fs.existsSync(file)) return file
  }
  return ''
}

/** Constant-time token comparison; unequal lengths short-circuit by design. */
function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''))
  const b = Buffer.from(String(right ?? ''))
  if (a.length === 0 || a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function bearerToken(header) {
  const text = Array.isArray(header) ? header[0] : header
  if (typeof text !== 'string') return ''
  const match = /^Bearer\s+(\S+)$/i.exec(text.trim())
  return match ? match[1] : ''
}

function remoteOf(req) {
  const address = req.socket?.remoteAddress || ''
  return address.replace(/^::ffff:/, '')
}

/**
 * Who the client says it is. Older clients send nothing and are treated as
 * Windows, which keeps existing deployments behaving exactly as before.
 */
function normalizeClientOs(raw) {
  const text = asText(raw).toLowerCase()
  if (text === 'unix' || text === 'linux' || text === 'darwin' || text === 'macos' || text === 'bsd') {
    return 'unix'
  }
  return 'win'
}

// ----------------------------------------------------------------- kit index

/**
 * Resolve the kit directory so a deployment can move machines without editing
 * the patch: `~` expands to the user profile, a relative path is taken from
 * DSH_HOME, and an empty value falls back to <DSH_HOME>/support-tunnel/kits.
 */
function resolveKitsDir(raw) {
  const text = asText(raw)
  if (!text) return path.join(dshHome(), 'support-tunnel', 'kits')
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(1).replace(/^[\\/]+/, ''))
  }
  if (path.isAbsolute(text)) return path.resolve(text)
  return path.resolve(dshHome(), text)
}

/**
 * Reads kitsDir for kits that carry a tunnel token.
 *
 * Layout per kit: <kitsDir>/<name>/client/support.json (tunnel edition) or
 * <kitsDir>/<name>/client/kit.json (SSH edition), plus operator/operator_id.
 * Kits without a token are simply not tunnel candidates.
 */
export class KitIndex {
  constructor(dir) {
    this.dir = resolveKitsDir(dir)
    this.entries = new Map()
    this.error = ''
    this.lastRefreshAt = 0
  }

  /** Re-read the kit directory at most once per ttl for repeated listings. */
  refreshIfStale(ttlMs = KITS_CACHE_MS) {
    if (Date.now() - this.lastRefreshAt < ttlMs) return this
    return this.refresh()
  }

  refresh() {
    this.lastRefreshAt = Date.now()
    this.entries.clear()
    this.error = ''
    if (!this.dir) {
      this.error = 'kitsDir 未配置'
      return this
    }
    let children = []
    try {
      children = fs.readdirSync(this.dir, { withFileTypes: true })
    } catch (err) {
      this.error = `kitsDir 不可读：${err.code || err.message}`
      return this
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const kitDir = path.join(this.dir, child.name)
      const support = readJsonFile(path.join(kitDir, 'client', 'support.json'))
      const kit = readJsonFile(path.join(kitDir, 'client', 'kit.json'))
      if (!support && !kit) continue
      // Merge, not either/or: the tunnel edition writes support.json while the
      // SSH edition keeps clientUser and sshLocalPort in kit.json.
      const meta = { ...(kit ?? {}), ...(support ?? {}) }
      if (typeof meta !== 'object') continue

      const kitId = asText(meta.kitId ?? meta.id)
      if (!kitId) continue

      this.entries.set(kitId, {
        kitId,
        name: asText(meta.name, child.name),
        token: asText(meta.token ?? meta.tunnelToken),
        // Hostname the client reports at handshake time wins; this is a fallback.
        clientHost: asText(meta.clientHost),
        user: asText(meta.clientUser ?? meta.user, 'Administrator'),
        localPort: asPort(meta.localPort ?? meta.sshLocalPort, 22),
        server: asText(meta.server ?? meta.host),
        serverPort: asPort(meta.port, 0),
        operatorKey: firstExisting(
          path.join(kitDir, 'operator', 'operator_id'),
          path.join(kitDir, 'operator', 'operator_ed25519'),
          path.join(kitDir, 'operator', 'id_ed25519'),
        ),
        kitDir,
      })
    }
    return this
  }

  get(kitId) {
    return this.entries.get(asText(kitId))
  }

  /** Exact kitId, exact name, then unique substring match. */
  resolve(target) {
    const key = asText(target)
    if (!key) return { error: 'target 不能为空' }

    const exact = this.entries.get(key)
    if (exact) return { entry: exact }

    for (const entry of this.entries.values()) {
      if (entry.name === key) return { entry }
    }

    const lowered = key.toLowerCase()
    const matches = [...this.entries.values()].filter((entry) =>
      entry.name.toLowerCase().includes(lowered)
      || entry.kitId.toLowerCase().includes(lowered)
      || (entry.clientHost || '').toLowerCase().includes(lowered))
    if (matches.length === 1) return { entry: matches[0] }
    if (matches.length > 1) {
      return { error: `target 匹配到多台：${matches.map((entry) => `${entry.name}(${entry.kitId})`).join('、')}` }
    }
    return { error: `没有 kit 匹配 ${key}` }
  }

  list() {
    return [...this.entries.values()]
  }
}

// --------------------------------------------------------------------- server

export function createTunnelServer(config = {}, options = {}) {
  const settings = {
    port: asPort(config.port, 24443),
    host: asText(config.host, '0.0.0.0'),
    tls: config.tls !== false,
    tlsCert: asText(config.tlsCert),
    tlsKey: asText(config.tlsKey),
    certName: asText(config.certName, 'support-tunnel'),
    basePort: asPort(config.basePort, 40001),
    maxClients: Number.isFinite(Number(config.maxClients)) ? Math.max(1, Math.floor(Number(config.maxClients))) : 20,
    kitsDir: asText(config.kitsDir),
    auditFile: asText(config.auditFile),
    idleKillMs: Number.isFinite(Number(config.idleKillMs)) ? Math.max(0, Math.floor(Number(config.idleKillMs))) : 0,
  }

  const onLog = typeof options.onLog === 'function' ? options.onLog : () => {}
  const kits = new KitIndex(settings.kitsDir).refresh()
  const pool = new PortPool({ base: settings.basePort, max: settings.maxClients })
  const sessions = new Map()

  const state = {
    listening: false,
    tls: false,
    port: settings.port,
    host: settings.host,
    error: '',
    fingerprint: '',
    certFile: '',
    keyFile: '',
    startedAt: '',
    connectionsAccepted: 0,
    rejected: 0,
    unknownKits: 0,
  }

  let httpServer
  let certificate
  let tickTimer

  const auditPath = (() => {
    const raw = settings.auditFile
    if (!raw) return path.join(dshHome(), 'tunnel-audit.jsonl')
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
      return path.join(os.homedir(), raw.slice(1).replace(/^[\\/]+/, ''))
    }
    return path.resolve(raw)
  })()

  function log(message) {
    try { onLog(String(message)) } catch { /* host logging must never break the tunnel */ }
  }

  function audit(entry) {
    try {
      fs.mkdirSync(path.dirname(auditPath), { recursive: true })
      fs.appendFileSync(auditPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8')
    } catch { /* auditing is best effort */ }
  }

  // -- frame plumbing -------------------------------------------------------

  function writeFrame(session, frame) {
    if (session.closed || session.res.writableEnded) return false
    try {
      return session.res.write(frame)
    } catch {
      teardown(session, 'write-failed')
      return false
    }
  }

  function allocateStreamId(session) {
    for (let attempt = 0; attempt <= MAX_STREAM_ID; attempt += 1) {
      const id = session.nextStreamId
      session.nextStreamId = id >= MAX_STREAM_ID ? 1 : id + 1
      if (id > 0 && !session.streams.has(id)) return id
    }
    return 1
  }

  /** Throttle the client->machine direction once its socket buffer runs deep. */
  function holdUpstream(session, socket) {
    if (socket.upstreamHeld) return
    socket.upstreamHeld = true
    session.backpressured += 1
    if (typeof session.req.pause === 'function') session.req.pause()
    socket.once('drain', () => releaseUpstream(session, socket))
  }

  function releaseUpstream(session, socket) {
    if (!socket.upstreamHeld) return
    socket.upstreamHeld = false
    session.backpressured = Math.max(0, session.backpressured - 1)
    if (session.backpressured === 0 && !session.closed) {
      try { session.req.resume() } catch { /* already closed */ }
    }
  }

  /** Throttle the machine->client direction once the response buffer runs deep. */
  function holdDownstream(session, socket) {
    if (socket.downstreamHeld) return
    socket.downstreamHeld = true
    socket.pause()
    session.res.once('drain', () => {
      if (!socket.downstreamHeld) return
      socket.downstreamHeld = false
      if (!socket.destroyed && !session.closed) socket.resume()
    })
  }

  /**
   * The operator side sent FIN: no more data flows local -> tunnel. Tell the
   * client this direction is done, but keep the stream alive — the service on
   * the far side may still be sending its reply.
   */
  function endUpstream(session, streamId, socket) {
    if (socket.upstreamDone) return
    socket.upstreamDone = true
    writeFrame(session, encodeFrame(FRAME.CLOSE, streamId))
    finishStreamIfDone(session, streamId, socket)
  }

  /** The client sent CLOSE: half-close the write side, keep reading. */
  function endDownstream(session, streamId, socket) {
    if (socket.downstreamDone) return
    socket.downstreamDone = true
    releaseUpstream(session, socket)
    if (!socket.destroyed) socket.end()
    finishStreamIfDone(session, streamId, socket)
  }

  /**
   * Drop the stream from the table once both directions finished. The socket
   * itself closes on its own: end() was already called and the peer's FIN
   * arrives through the normal sequence, so destroying here would discard
   * whatever is still sitting in the kernel send buffer.
   */
  function finishStreamIfDone(session, streamId, socket) {
    if (!socket.upstreamDone || !socket.downstreamDone) return
    if (session.streams.get(streamId) === socket) session.streams.delete(streamId)
    releaseUpstream(session, socket)
  }

  function onLocalConnection(session, socket) {
    if (session.closed) {
      socket.destroy()
      return
    }
    const streamId = allocateStreamId(session)
    session.streams.set(streamId, socket)
    session.lastActivityAt = Date.now()
    socket.upstreamDone = false
    socket.downstreamDone = false

    socket.setNoDelay(true)
    try { socket.setKeepAlive(true, 30_000) } catch { /* platform dependent */ }

    if (!writeFrame(session, encodeFrame(FRAME.NEW, streamId))) {
      session.streams.delete(streamId)
      socket.destroy()
      return
    }

    // Coalesce reads into one write. Each res.write carries a chunked-encoding
    // header and a writev, so batching four frames roughly quarters that cost;
    // setImmediate keeps small interactive writes from waiting for a full batch.
    const batch = []
    let batchBytes = 0
    let batchScheduled = false

    const flushBatch = () => {
      batchScheduled = false
      if (batchBytes === 0) return
      const body = batch.length === 1 ? batch[0] : Buffer.concat(batch, batchBytes)
      batch.length = 0
      batchBytes = 0
      if (session.closed) return
      const flushed = writeFrame(session, encodeDataChunk(streamId, body))
      if (!flushed && session.res.writableLength > BUFFER_HIGH_WATER) {
        holdDownstream(session, socket)
      }
    }

    socket.on('data', (chunk) => {
      session.bytesOut += chunk.length
      session.lastActivityAt = Date.now()
      batch.push(chunk)
      batchBytes += chunk.length
      if (batchBytes >= BATCH_BYTES) {
        flushBatch()
        return
      }
      if (!batchScheduled) {
        batchScheduled = true
        setImmediate(flushBatch)
      }
    })

    socket.on('end', () => {
      // Half-close from the operator side. Flush what is buffered first, then
      // announce the direction; the stream stays open for the reply.
      flushBatch()
      endUpstream(session, streamId, socket)
    })

    socket.on('error', () => {
      // 'close' follows an error, which finishes both directions.
      flushBatch()
    })

    socket.on('close', () => {
      flushBatch()
      endUpstream(session, streamId, socket)
      endDownstream(session, streamId, socket)
    })
  }

  function onFrame(session, frame) {
    session.lastActivityAt = Date.now()
    // Any inbound frame proves the link is alive: it counts as a PONG too.
    session.pingSentAt = 0
    switch (frame.type) {
      case FRAME.DATA: {
        const socket = session.streams.get(frame.streamId)
        if (!socket || socket.destroyed) {
          writeFrame(session, encodeFrame(FRAME.CLOSE, frame.streamId))
          return
        }
        // After the client's CLOSE this direction is closed; trailing frames are
        // a protocol slip, drop them instead of writing to a half-closed socket.
        if (socket.downstreamDone) return
        if (frame.payload.length === 0) return
        if (!socket.write(frame.payload) && socket.writableLength > BUFFER_HIGH_WATER) {
          holdUpstream(session, socket)
        }
        return
      }
      case FRAME.CLOSE: {
        const socket = session.streams.get(frame.streamId)
        if (socket) endDownstream(session, frame.streamId, socket)
        return
      }
      case FRAME.PING:
        session.lastPongAt = Date.now()
        writeFrame(session, encodeFrame(FRAME.PING, 0))
        return
      case FRAME.NEW:
      default:
        return
    }
  }

  // -- session lifecycle ----------------------------------------------------

  function teardown(session, reason) {
    if (!session || session.closed) return
    session.closed = true
    if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey)

    for (const socket of session.streams.values()) {
      try { socket.destroy() } catch { /* gone */ }
    }
    const openStreams = session.streams.size
    session.streams.clear()

    try { session.tcpServer?.close() } catch { /* already closed */ }
    pool.release(session.localPort)

    try { if (!session.res.writableEnded) session.res.end() } catch { /* gone */ }
    try { session.req.destroy() } catch { /* gone */ }

    log(`client disconnected kitId=${session.kitId} reason=${reason} streams=${openStreams}`)
    audit({
      event: 'client_disconnected',
      kitId: session.kitId,
      name: session.name,
      localPort: session.localPort,
      reason,
      streams: openStreams,
      bytesIn: session.bytesIn,
      bytesOut: session.bytesOut,
      connectedAt: session.connectedAt,
      durationMs: Date.now() - session.connectedAtMs,
    })
  }

  function sendPing(session, now) {
    session.pingSentAt = now
    session.lastPingAt = now
    writeFrame(session, encodeFrame(FRAME.PING, 0))
  }

  function tick() {
    const now = Date.now()
    for (const session of [...sessions.values()]) {
      if (session.closed) continue
      if (session.pingSentAt && now - session.pingSentAt > PONG_TIMEOUT_MS) {
        teardown(session, 'ping-timeout')
        continue
      }
      if (!session.pingSentAt && now - session.lastPingAt >= PING_INTERVAL_MS) {
        sendPing(session, now)
        continue
      }
      if (settings.idleKillMs > 0 && session.streams.size === 0 && now - session.lastActivityAt > settings.idleKillMs) {
        teardown(session, 'idle')
      }
    }
  }

  // -- HTTP entry -----------------------------------------------------------

  function replyText(res, status, text, extraHeaders = {}) {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(text),
      ...extraHeaders,
    })
    res.end(text)
  }

  async function handleTunnel(req, res, kitId) {
    kits.refresh()

    const entry = kits.get(kitId)
    if (!entry) {
      state.unknownKits += 1
      state.rejected += 1
      audit({ event: 'unknown_kit', kitId, remote: remoteOf(req) })
      replyText(res, 404, 'not found')
      return
    }

    const presented = bearerToken(req.headers.authorization)
    if (!entry.token || !presented || !safeEqual(entry.token, presented)) {
      state.rejected += 1
      audit({ event: 'auth_failed', kitId, remote: remoteOf(req) })
      log(`auth failed kitId=${kitId}`)
      replyText(res, 401, 'auth failed')
      return
    }

    // One stick = one kit, but the same stick is expected to serve several
    // machines at once: the session identity is (kit, machine), not kit alone.
    // Reconnecting from the *same* machine still replaces its old session.
    const clientHost = asText(decodeHeader(req.headers['x-client-host']), entry.clientHost)
    const sessionKey = `${kitId}|${clientHost || 'unknown'}`

    if (sessions.size >= settings.maxClients && !sessions.has(sessionKey)) {
      state.rejected += 1
      replyText(res, 503, 'too many clients')
      return
    }

    const previous = sessions.get(sessionKey)
    if (previous) {
      log(`kitId=${kitId} host=${clientHost} reconnected, dropping previous session`)
      teardown(previous, 'replaced')
    }

    const localPort = await pool.allocate()
    if (!localPort) {
      state.rejected += 1
      audit({ event: 'no_free_port', kitId })
      replyText(res, 503, 'no free local port')
      return
    }

    const session = {
      kitId,
      sessionKey,
      name: entry.name,
      clientHost,
      clientOs: normalizeClientOs(decodeHeader(req.headers['x-client-os'])),
      clientShell: asText(decodeHeader(req.headers['x-client-shell'])),
      user: asText(decodeHeader(req.headers['x-client-user']), entry.user),
      localPort,
      operatorKey: entry.operatorKey,
      req,
      res,
      streams: new Map(),
      nextStreamId: 1,
      bytesIn: 0,
      bytesOut: 0,
      backpressured: 0,
      connectedAt: new Date().toISOString(),
      connectedAtMs: Date.now(),
      lastActivityAt: Date.now(),
      lastPingAt: Date.now(),
      pingSentAt: 0,
      lastPongAt: Date.now(),
      closed: false,
      tcpServer: undefined,
    }

    // allowHalfOpen keeps the socket writable after the operator sends FIN, so a
    // service that answers only after EOF still gets its reply delivered.
    const tcpServer = net.createServer({ allowHalfOpen: true }, (socket) => onLocalConnection(session, socket))
    tcpServer.on('error', (err) => {
      log(`local port error port=${localPort} ${err.code || err.message}`)
      teardown(session, `local-port:${err.code || 'error'}`)
    })
    const bound = await new Promise((resolve) => {
      let settled = false
      const settle = (ok) => { if (!settled) { settled = true; resolve(ok) } }
      tcpServer.once('error', () => settle(false))
      try {
        tcpServer.listen(localPort, LOOPBACK, () => settle(true))
      } catch {
        settle(false)
      }
    })
    if (!bound) {
      pool.release(localPort)
      state.rejected += 1
      try { tcpServer.close() } catch { /* not listening */ }
      replyText(res, 503, 'local port busy')
      return
    }

    session.tcpServer = tcpServer
    sessions.set(sessionKey, session)
    state.connectionsAccepted += 1

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()

    log(`client connected kitId=${kitId} name=${session.name} localPort=${localPort}`)
    audit({
      event: 'client_connected',
      kitId,
      name: session.name,
      clientHost: session.clientHost,
      user: session.user,
      localPort,
      remote: remoteOf(req),
      tls: state.tls,
    })

    const decoder = new FrameDecoder()
    req.on('data', (chunk) => {
      session.bytesIn += chunk.length
      session.lastActivityAt = Date.now()
      let frames
      try {
        frames = decoder.push(chunk)
      } catch (err) {
        teardown(session, `decode:${err.message}`)
        return
      }
      for (const frame of frames) {
        if (session.closed) break
        onFrame(session, frame)
      }
    })
    req.on('error', () => teardown(session, 'request-error'))
    req.on('close', () => {
      if (!session.closed) teardown(session, 'request-closed')
    })
    res.on('close', () => {
      if (!session.closed) teardown(session, 'response-closed')
    })
    res.on('error', () => teardown(session, 'response-error'))
  }

  function decodeHeader(value) {
    const text = Array.isArray(value) ? value[0] : value
    if (typeof text !== 'string' || !text) return ''
    try {
      return decodeURIComponent(text)
    } catch {
      return text
    }
  }

  function onRequest(req, res) {
    const url = new URL(req.url || '/', 'http://tunnel.local')
    const tunnel = /^\/t\/([^/]+)$/.exec(url.pathname)

    if (!tunnel) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        replyText(res, 200, 'ok')
        return
      }
      replyText(res, 404, 'not found')
      return
    }

    if (req.method !== 'POST') {
      replyText(res, 405, 'method not allowed', { Allow: 'POST' })
      return
    }

    let kitId = tunnel[1]
    try { kitId = decodeURIComponent(kitId) } catch { /* keep raw */ }

    handleTunnel(req, res, kitId).catch((err) => {
      log(`tunnel handler failed: ${err && err.message}`)
      replyText(res, 500, 'internal error')
    })
  }

  // -- public surface -------------------------------------------------------

  async function start() {
    if (settings.tls) {
      try {
        certificate = ensureCertificate({
          certPath: settings.tlsCert,
          keyPath: settings.tlsKey,
          commonName: settings.certName,
          sans: [...new Set(['localhost', settings.certName, asText(config.domain)].filter(Boolean))],
        })
        state.tls = true
        state.fingerprint = certificate.fingerprint
        state.certFile = certificate.certFile
        state.keyFile = certificate.keyFile
        if (certificate.generated) log(`generated self-signed certificate at ${certificate.certFile}`)
      } catch (err) {
        state.error = `tls-unavailable: ${err && err.message}`
        state.tls = false
        log(`TLS setup failed, falling back to plain HTTP: ${err && err.message}`)
      }
    }

    const handler = (req, res) => onRequest(req, res)
    httpServer = state.tls
      ? https.createServer({ cert: certificate.certPem, key: certificate.keyPem, minVersion: 'TLSv1.2' }, handler)
      : http.createServer(handler)

    // A tunnel request stays open for the whole session: no idle/request timeouts.
    httpServer.requestTimeout = 0
    httpServer.headersTimeout = 0
    httpServer.keepAliveTimeout = 0
    httpServer.timeout = 0
    httpServer.on('connection', (socket) => socket.setNoDelay(true))
    httpServer.on('clientError', (err, socket) => {
      try { socket.destroy() } catch { /* gone */ }
    })

    await new Promise((resolve) => {
      let settled = false
      const settle = () => { if (!settled) { settled = true; resolve() } }
      httpServer.once('error', (err) => {
        state.error = `${err.code || 'error'}: ${err.message}`
        state.listening = false
        settle()
      })
      httpServer.once('listening', () => {
        state.listening = true
        state.error = ''
        state.startedAt = new Date().toISOString()
        settle()
      })
      try {
        httpServer.listen(settings.port, settings.host)
      } catch (err) {
        state.error = `${err.code || 'error'}: ${err.message}`
        settle()
      }
    })

    if (state.listening) {
      log(`listening on ${state.tls ? 'https' : 'http'}://${settings.host}:${settings.port} fingerprint=${state.fingerprint || '-'}`)
    } else {
      log(`listener unavailable on port ${settings.port}: ${state.error}`)
    }

    tickTimer = setInterval(tick, 1000)
    tickTimer.unref?.()
    return { listening: state.listening, error: state.error, tls: state.tls, fingerprint: state.fingerprint }
  }

  function stop() {
    for (const session of [...sessions.values()]) teardown(session, 'shutdown')
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = undefined
    try { httpServer?.close() } catch { /* already closed */ }
    httpServer = undefined
    state.listening = false
  }

  function list() {
    try { kits.refreshIfStale() } catch { /* keep the last good index */ }
    const clients = []
    for (const session of sessions.values()) {
      clients.push({
        kitId: session.kitId,
        name: session.name,
        clientHost: session.clientHost,
        clientOs: session.clientOs,
        clientShell: session.clientShell,
        user: session.user,
        localPort: session.localPort,
        connectedAt: session.connectedAt,
        streams: session.streams.size,
        bytesIn: session.bytesIn,
        bytesOut: session.bytesOut,
        idleSeconds: Math.floor((Date.now() - session.lastActivityAt) / 1000),
        sshCommand: `ssh -p ${session.localPort} -i "${session.operatorKey || '<operator_id>'}" ${session.user}@127.0.0.1`,
      })
    }
    clients.sort((a, b) => a.localPort - b.localPort)
    return {
      listening: state.listening,
      tls: state.tls,
      port: state.port,
      host: state.host,
      fingerprint: state.fingerprint,
      error: state.error,
      startedAt: state.startedAt,
      basePort: settings.basePort,
      maxClients: settings.maxClients,
      kitsDir: kits.dir,
      kitsWithToken: kits.list().filter((entry) => entry.token).length,
      accepted: state.connectionsAccepted,
      rejected: state.rejected,
      clients,
    }
  }

  /** Exact kitId, exact name, then unique substring, limited to live sessions. */
  function find(target) {
    const key = asText(target)
    if (!key) return { error: 'target 不能为空' }
    // Keys are (kit|host) now, so an exact kitId lookup has to scan. Several
    // machines can share one kit, hence the ambiguity note below.
    let byKit = 0
    for (const session of sessions.values()) {
      if (session.sessionKey === key) return { session }
    }
    for (const session of sessions.values()) {
      if (session.name === key) return { session }
    }
    for (const session of sessions.values()) {
      if (session.kitId === key) byKit += 1
    }
    if (byKit === 1) {
      for (const session of sessions.values()) if (session.kitId === key) return { session }
    }
    const lowered = key.toLowerCase()
    // A stick can carry pool slots, so several live sessions may share one kit
    // name; the machine hostname is what tells them apart.
    const matches = [...sessions.values()].filter((session) =>
      session.name.toLowerCase().includes(lowered)
      || session.kitId.toLowerCase().includes(lowered)
      || (session.clientHost || '').toLowerCase().includes(lowered))
    if (matches.length === 1) return { session: matches[0] }
    if (matches.length > 1) {
      return { error: `target 匹配到多台在线客户机：${matches.map((s) => `${s.name}(${s.kitId})`).join('、')}` }
    }
    return { error: `没有在线客户机匹配 ${key}；先用 tunnel_list 查看` }
  }

  function disconnect(target, reason = 'requested') {
    const found = find(target)
    if (found.error) return found
    const { session } = found
    const snapshot = { kitId: session.kitId, name: session.name, localPort: session.localPort }
    audit({ event: 'disconnected_by_operator', kitId: session.kitId, name: session.name, reason })
    teardown(session, reason)
    return { disconnected: snapshot }
  }

  function status() {
    return { listening: state.listening, tls: state.tls, port: state.port, error: state.error, fingerprint: state.fingerprint, clients: sessions.size }
  }

  return {
    start,
    stop,
    list,
    find,
    disconnect,
    status,
    audit,
    kits,
    settings,
    auditPath,
    get sessionCount() { return sessions.size },
  }
}
