import https from 'node:https'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createKitRelay } from './kit-relay.js'

/**
 * Remote backend: the same surface `lib/tools.js` expects from the embedded
 * server, but answered by a standalone tunnel server over HTTP.
 *
 * `list()` and `find()` stay synchronous by returning a cached snapshot, so a
 * tool call never blocks on the network twice; `refresh()` is the one call that
 * actually goes out, and every tool awaits it first.
 */

export function createRemoteBackend({ baseUrl, timeoutMs = 8000, kitFilter = '', apiToken = '', accountPassword = '', fingerprint = '', kitsDir = '', onLog } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  /** Operator credential for the server's management routes (local use). */
  const token = String(apiToken || '').trim()
  /** Password for this control side's DSH account; enables login-based access. */
  const password = String(accountPassword || '')
  /**
   * sha256 fingerprint of the server certificate. The tunnel server prints it as
   * `sha256:<base64>`; a hex digest of the same bytes is accepted too. Required
   * to reach an https endpoint with a self-signed certificate: the peer is
   * accepted only when the digest matches, so a man in the middle cannot take
   * over by presenting any certificate. Base64 is case sensitive, so it is kept
   * verbatim.
   */
  const pinnedRaw = String(fingerprint || '').trim().replace(/^sha256:/i, '')
  const pinnedHex = /^[0-9a-fA-F]{64}$/.test(pinnedRaw) ? pinnedRaw.toLowerCase() : ''
  const pinnedB64 = pinnedHex ? '' : pinnedRaw
  /** DSH account id this control side belongs to; set later by the caller. */
  let accountId = ''
  /** Last URL actually fetched, for the diag endpoint. */
  let lastRequestUrl = ''
  // A stick can own more than one kit (for example a Windows kit and a Linux
  // kit issued separately). Accept an array, or a comma separated string, and
  // keep the old "empty means show everything" behaviour.
  const filterList = (Array.isArray(kitFilter) ? kitFilter : String(kitFilter || '').split(','))
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
  const filterSet = new Set(filterList.map((item) => item.toLowerCase()))
  const filter = filterList.join(',')

  let cache = {
    listening: false,
    port: 0,
    host: '',
    tls: false,
    fingerprint: '',
    error: '',
    kitsDir: '',
    basePort: 0,
    maxClients: 0,
    clients: [],
    kits: [],
  }
  let reachable = false
  let lastError = ''

  function note(message) {
    if (typeof onLog === 'function') {
      try {
        onLog(message)
      } catch {
        /* logging must never break a tool call */
      }
    }
  }

  /**
   * Reusable agent for a self-signed https endpoint. Returns null when no
   * fingerprint is pinned, so `fetch` keeps handling plain http and normally
   * trusted https.
   */
  let cachedAgent = null
  function httpsAgentFor(url) {
    if (!pinnedHex && !pinnedB64) return null
    if (cachedAgent) return cachedAgent
    const host = new URL(url).hostname
    cachedAgent = new https.Agent({
      keepAlive: false,
      // Verification happens by hand in send(): with rejectUnauthorized false
      // Node skips the chain check AND swallows checkServerIdentity errors, so
      // the peer digest has to be compared on the response socket.
      rejectUnauthorized: false,
      // Node resumes TLS sessions by default, and a resumed socket reports an
      // empty object from getPeerCertificate() — the pin check would then fail
      // on every request after the first. Force a full handshake each time.
      maxCachedSessions: 0,
    })
    if (!/^[0-9.]+$/.test(host)) cachedAgent.options.servername = host
    return cachedAgent
  }

  /** Peer certificate digests, or empty strings when the socket carries none. */
  function peerFingerprint(socket) {
    try {
      const cert = socket.getPeerCertificate()
      if (!cert || !cert.raw) return { hex: '', base64: '' }
      const digest = crypto.createHash('sha256').update(cert.raw).digest()
      // The tunnel server publishes `sha256:<base64 unpadded>` (lib/cert.js), so
      // the padding has to go before comparing.
      return { hex: digest.toString('hex'), base64: digest.toString('base64').replace(/=+$/, '') }
    } catch {
      return { hex: '', base64: '' }
    }
  }

  /**
   * Perform one HTTP(S) request. `fetch` is used for plain http and for https
   * with a trusted certificate; a self-signed endpoint (the tunnel listener on
   * 24443, which is how a control side reaches the admin API through the port
   * the router already forwards) needs node:https so the peer certificate can be
   * checked against a pinned fingerprint instead of being rejected outright.
   */
  async function send(url, method, headers, controller, body) {
    const agent = url.startsWith('https:') ? httpsAgentFor(url) : null
    if (!agent) {
      const init = { method, headers, signal: controller ? controller.signal : undefined }
      if (body !== undefined) init.body = body
      const response = await fetch(url, init)
      return { status: response.status, ok: response.ok, text: await response.text() }
    }
    return await new Promise((resolve, reject) => {
      const options = { method, headers, agent }
      if (controller) options.signal = controller.signal
      const req = https.request(url, options, (res) => {
        // Pin check happens before reading the body: an impostor must not get a
        // chance to answer, and the caller sees a clear reason instead of a
        // JSON parse error.
        if (pinnedHex || pinnedB64) {
          const actual = peerFingerprint(res.socket)
          const shown = (pinnedHex || pinnedB64).slice(0, 16)
          if (!actual.hex) {
            res.destroy()
            reject(new Error('server presented no certificate'))
            return
          }
          const ok = pinnedHex ? actual.hex === pinnedHex : actual.base64 === pinnedB64
          if (!ok) {
            res.destroy()
            reject(new Error(`server certificate mismatch: got sha256:${actual.hex.slice(0, 16)}… expected sha256:${shown}…`))
            return
          }
        }
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          text: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  // -- account login -------------------------------------------------------
  //
  // The server does not trust a bare account id: it issues a bearer session to
  // a caller that knows that account's password. A shared --api-token is still
  // sent when configured, but only the operator routes need it.

  let sessionToken = ''
  let sessionExpiresAt = 0
  let loginInFlight = null
  let lastLoginError = ''
  let lastVerifiedBy = ''
  /** Optional supplier of the DSH platform token; set by the plugin host. */
  let platformTokenProvider = null
  let platformInfo = null

  function sessionValid() {
    return Boolean(sessionToken) && Date.now() < sessionExpiresAt - 60_000
  }

  async function doLogin() {
    if (!accountId) throw new Error('还没有确定 DSH 账户，无法登录')
    // Prefer the platform token: the server resolves the account from it, so no
    // password has to be provisioned on this machine at all.
    let platformToken = ''
    if (typeof platformTokenProvider === 'function') {
      try { platformToken = String((await platformTokenProvider()) || '') } catch { /* fall through */ }
    }
    if (!platformToken && !password) {
      throw new Error('既没有 DSH 账户凭证，也没有配置 accountPassword')
    }
    const payload = JSON.stringify(
      platformToken ? { platformToken } : { account: accountId, password },
    )
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await send(
        `${base}/api/login`,
        'POST',
        { 'content-type': 'application/json' },
        controller,
        payload,
      )
      const text = response.text
      const body = text ? JSON.parse(text) : {}
      if (!response.ok) {
        const reason = body.error || `HTTP ${response.status}`
        throw new Error(body.hint ? `${reason}：${body.hint}` : reason)
      }
      sessionToken = String(body.session || '')
      lastVerifiedBy = String(body.verifiedBy || '')
      const parsed = Date.parse(body.expiresAt || '')
      sessionExpiresAt = Number.isFinite(parsed)
        ? parsed
        : Date.now() + (Number(body.ttlSeconds) || 3600) * 1000
      lastLoginError = ''
      if (typeof onLog === 'function') {
        try {
          onLog(`login ok via ${lastVerifiedBy || 'password'}: ${accountId.slice(0, 8)}… (until ${new Date(sessionExpiresAt).toISOString()})`)
        } catch { /* ignore */ }
      }
      return sessionToken
    } finally {
      clearTimeout(timer)
    }
  }

  /** Reuse a live session, otherwise log in once (shared across concurrent calls). */
  async function ensureSession(force = false) {
    // A session needs some credential: the platform token supplied by the host,
    // or the password from the config.
    if (!password && typeof platformTokenProvider !== 'function') return ''
    if (!force && sessionValid()) return sessionToken
    if (!loginInFlight) {
      loginInFlight = doLogin().finally(() => { loginInFlight = null })
    }
    try {
      return await loginInFlight
    } catch (err) {
      lastLoginError = err?.message || String(err)
      throw err
    }
  }

  // A remote control side gets the server's absolute operatorKey path, which
  // means nothing on this machine. Resolve to a usable local key instead:
  // <kitsDir>/<kit name or kitId>/operator/operator_id.
  const localKitsDir = String(kitsDir || '').trim()

  function isFile(candidate) {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  }

  function localKeyFor(session) {
    if (!localKitsDir) return ''
    const folders = []
    // The folder on disk is not always the display name: a kit named "U盘" can
    // live in kits/工作机/. Prefer the folder the server's own path reveals, then
    // the display name, then the kitId.
    const reported = String(session.operatorKeySource || session.operatorKey || '')
    const parts = reported.split(/[\\/]+/).filter(Boolean)
    const operatorIndex = parts.lastIndexOf('operator')
    if (operatorIndex > 0) folders.push(parts[operatorIndex - 1])
    folders.push(String(session.name || '').trim(), String(session.kitId || '').trim())
    for (const folder of folders) {
      if (!folder) continue
      for (const file of ['operator_id', 'operator_ed25519', 'id_ed25519']) {
        const candidate = path.join(localKitsDir, folder, 'operator', file)
        if (isFile(candidate)) return candidate
      }
    }
    return ''
  }

  /**
   * Rewrite one session's operatorKey into something ssh can actually open here.
   * Keeps the server-reported path under `operatorKeySource` so a failure can say
   * where the key is supposed to live.
   */
  function withLocalKey(session) {
    const reported = String(session.operatorKey || '')
    if (reported && isFile(reported)) return session
    const local = localKeyFor(session)
    if (local) return { ...session, operatorKey: local, operatorKeySource: reported }
    return { ...session, operatorKey: '', operatorKeySource: reported }
  }

  // -- kit port relay ------------------------------------------------------
  //
  // The tunnel binds a kit's port to the server's loopback. A control side on
  // another machine cannot dial that, so it opens the same port number locally
  // and forwards through the admin port. When this machine *is* the server the
  // port is already taken by the tunnel itself and ensure() is a no-op.

  const localBase = (() => {
    try {
      const host = new URL(base).hostname.replace(/^\[|\]$/g, '')
      return host === '127.0.0.1' || host === '::1' || host === 'localhost'
    } catch {
      return true
    }
  })()

  let relay = null
  const relayedPorts = new Set()

  function relayFor() {
    if (!relay) {
      relay = createKitRelay({
        baseUrl: base,
        getAgent: () => (pinnedHex || pinnedB64 ? httpsAgentFor(base) : null),
        getAuth: async () => {
          const headers = {}
          if (token) headers['X-Api-Token'] = token
          if (password || typeof platformTokenProvider === 'function') {
            const session = await ensureSession()
            if (session) headers.authorization = `Bearer ${session}`
          }
          return { headers }
        },
        onLog: onLog,
      })
    }
    return relay
  }

  /**
   * Make 127.0.0.1:<port> usable for ssh on this machine. Resolves the port to
   * dial (always the same number) plus an optional warning.
   */
  async function ensureRelayPort(session) {
    const port = Number(session?.localPort) || 0
    const kitId = String(session?.kitId || '')
    if (!port || !kitId) return { port }
    if (localBase) return { port }
    if (relayedPorts.has(port)) return { port }
    const result = await relayFor().ensure(kitId, port)
    if (result.ok && !result.local) relayedPorts.add(port)
    return { port, ...result }
  }

  async function request(pathname, init, alreadyRetried = false) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // Identify which DSH account this control side is using. The server keeps
      // kits per account, so every machine signed in with the same account sees
      // the same devices without any local kitId configuration.
      const headers = { ...(init?.headers || {}) }
      if (token) headers['X-Api-Token'] = token
      let url = `${base}${pathname}`
      if (accountId) {
        headers['X-Account-Id'] = encodeURIComponent(accountId)
        url += `${pathname.includes('?') ? '&' : '?'}account=${encodeURIComponent(accountId)}`
      }
      if (password || typeof platformTokenProvider === 'function') {
        try {
          const session = await ensureSession()
          if (session) headers['authorization'] = `Bearer ${session}`
        } catch (err) {
          // Login itself failed (not approved, no password, wrong password).
          // Surface it directly: retrying the data call would just 401 again.
          throw err
        }
      }
      lastRequestUrl = url
      const response = await send(url, init?.method || 'GET', headers, controller, init?.body)
      const text = response.text
      const body = text ? JSON.parse(text) : {}

      // A rejected bearer means the session died (server restart, password
      // reset, account blocked). Log in again exactly once and replay.
      if (response.status === 401 && (password || typeof platformTokenProvider === 'function') && !alreadyRetried) {
        sessionToken = ''
        sessionExpiresAt = 0
        await ensureSession(true)
        return request(pathname, init, true)
      }

      if (!response.ok) {
        // The server answers 403 with { error, hint } when this DSH account has
        // not been approved yet. Keep both parts so the settings page shows
        // something actionable instead of a bare "approval required".
        const reason = body.error || `HTTP ${response.status}`
        throw new Error(body.hint ? `${reason}：${body.hint}` : reason)
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  /** Pull a fresh snapshot; never throws, records the reason instead. */
  async function refresh() {
    try {
      const state = await request('/api/state')
      const allClients = Array.isArray(state.clients) ? state.clients : []
      const allKits = Array.isArray(state.kits) ? state.kits : []
      const keep = (item) => filterSet.size === 0
        || filterSet.has(String(item.kitId || '').toLowerCase())
      cache = {
        listening: Boolean(state.listening),
        port: Number(state.port) || 0,
        host: state.host || '',
        tls: Boolean(state.tls),
        fingerprint: state.fingerprint || '',
        error: state.error || '',
        kitsDir: state.kitsDir || '',
        basePort: Number(state.basePort) || 0,
        maxClients: Number(state.maxClients) || 0,
        clients: allClients.filter(keep).map(withLocalKey),
        kits: allKits.filter(keep),
        // Totals stay available so the page can say "this kit / server total".
        serverClientCount: allClients.length,
        serverKitCount: allKits.length,
        kitFilter: filter,
      }
      reachable = true
      lastError = ''
      return cache
    } catch (err) {
      reachable = false
      lastError = err?.message || String(err)
      note(`remote server unreachable: ${lastError}`)
      // Keep serving the last snapshot; an operator mid-session should not lose
      // the port just because one poll failed.
      return { ...cache, error: lastError }
    }
  }

  function list() {
    return { ...cache, error: cache.error || lastError, reachable }
  }

  /** Same resolution order the embedded server uses, over the cached snapshot. */
  function find(target) {
    const key = String(target ?? '').trim()
    if (!key) return { error: 'target 不能为空' }
    const lower = key.toLowerCase()
    const clients = Array.isArray(cache.clients) ? cache.clients : []
    if (clients.length === 0) {
      return {
        error: lastError
          ? `连不上隧道服务器 ${base}：${lastError}`
          : '没有在线客户机；确认 A 侧客户端已连接隧道服务器',
      }
    }

    const byKey = clients.find((item) => String(item.sessionKey || '').toLowerCase() === lower)
    if (byKey) return { session: byKey }

    const byName = clients.find((item) => String(item.name || '').toLowerCase() === lower)
    if (byName) return { session: byName }

    // An exact hostname beats any substring rule: several machines share one kit,
    // and "vision" is a substring of "VisionFrame".
    const byHost = clients.find((item) => String(item.clientHost || '').toLowerCase() === lower)
    if (byHost) return { session: byHost }

    const byKit = clients.filter((item) => String(item.kitId || '').toLowerCase() === lower)
    if (byKit.length === 1) return { session: byKit[0] }

    const matches = clients.filter((item) =>
      String(item.name || '').toLowerCase().includes(lower)
      || String(item.kitId || '').toLowerCase().includes(lower)
      || String(item.clientHost || '').toLowerCase().includes(lower))
    if (matches.length === 1) return { session: matches[0] }
    if (matches.length > 1) {
      const list = matches.map((s) => `${s.clientHost || '?'}(kit ${s.kitId})`).join('、')
      return { error: `target 匹配到多台在线客户机：${list}；用「kitId|主机名」精确指定，例如 ${matches[0].sessionKey}` }
    }
    return { error: `没有在线客户机匹配 ${key}；先用 tunnel_list 查看` }
  }

  async function disconnect(target) {
    const found = find(target)
    if (found.error) return { error: found.error }
    try {
      const body = await request(`/api/disconnect?target=${encodeURIComponent(target)}`, { method: 'POST' })
      await refresh()
      return body
    } catch (err) {
      return { error: `断开失败：${err?.message || err}` }
    }
  }

  // The standalone server writes its own audit log; nothing to do from here.
  function audit() {}

  /**
   * Transport for one request: node:https with the pinned agent, or node:http.
   * fetch cannot stream a request body or a large response, and file transfer
   * needs both.
   */
  function transportFor(url) {
    if (!url.startsWith('https:')) return { lib: http, agent: null }
    return { lib: https, agent: pinnedHex || pinnedB64 ? httpsAgentFor(url) : null }
  }

  /** Auth headers shared by the streaming routes. */
  async function authHeaders(extra = {}) {
    const headers = { ...extra }
    if (token) headers['X-Api-Token'] = token
    if (password || typeof platformTokenProvider === 'function') {
      const session = await ensureSession()
      if (session) headers.authorization = `Bearer ${session}`
    }
    return headers
  }

  /** Copy one local file to the kit, streaming the body from disk. */
  async function uploadRemote(session, localPath, remotePath) {
    // user 一起带上，理由和 execRemote 相同：服务端有它自己那份 session.user，
    // 那是客户端上报的原始值；控制端这边已经把 NAME$ 换成了能登录的真实账户，
    // 不传过去的话服务器会拿 VISIONFRAME$ 去 scp，传输必然被拒。
    const url = `${base}/api/kit/${encodeURIComponent(session.sessionKey || session.kitId)}/file`
      + `?path=${encodeURIComponent(remotePath)}`
      + `&user=${encodeURIComponent(session.user || '')}`
    const headers = await authHeaders({ 'content-type': 'application/octet-stream' })
    try { headers['content-length'] = String(fs.statSync(localPath).size) } catch { /* stream decides */ }
    const { lib, agent } = transportFor(url)
    return await new Promise((resolve) => {
      const req = lib.request(url, { method: 'POST', headers, agent }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          let body = {}
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* empty */ }
          const ok = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300
          resolve(ok ? { ok: true } : { ok: false, error: body.error || `HTTP ${res.statusCode}` })
        })
      })
      req.on('error', (err) => resolve({ ok: false, error: err?.message || String(err) }))
      const source = fs.createReadStream(localPath)
      source.on('error', (err) => {
        try { req.destroy() } catch { /* gone */ }
        resolve({ ok: false, error: err?.message || String(err) })
      })
      source.pipe(req)
    })
  }

  /** Stream one remote file onto this machine. */
  async function downloadRemote(session, remotePath, localPath) {
    // 同上：账户跟着请求走，否则服务端会拿上报的 NAME$ 去 scp。
    const url = `${base}/api/kit/${encodeURIComponent(session.sessionKey || session.kitId)}/file`
      + `?path=${encodeURIComponent(remotePath)}`
      + `&user=${encodeURIComponent(session.user || '')}`
    const headers = await authHeaders()
    const { lib, agent } = transportFor(url)
    return await new Promise((resolve) => {
      const req = lib.request(url, { method: 'GET', headers, agent }, (res) => {
        const status = res.statusCode || 0
        if (status < 200 || status >= 300) {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            let body = {}
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* empty */ }
            resolve({ ok: false, error: body.error || `HTTP ${status}` })
          })
          return
        }
        const sink = fs.createWriteStream(localPath)
        res.pipe(sink)
        // Report the size actually written. A stream that ends with zero bytes is
        // not success: the server may have died after sending its headers, and a
        // bare `ok: true` hid that for several rounds of debugging.
        sink.on('finish', () => {
          let bytes = 0
          try { bytes = fs.statSync(localPath).size } catch { /* file vanished */ }
          resolve({ ok: true, bytes })
        })
        sink.on('error', (err) => resolve({ ok: false, error: err?.message || String(err) }))
        res.on('error', (err) => resolve({ ok: false, error: err?.message || String(err) }))
        // A destroyed response surfaces as a truncated body, not always as an
        // error, so treat an abnormal end as failure too.
        res.on('aborted', () => resolve({ ok: false, error: 'transfer aborted before completion' }))
      })
      req.on('error', (err) => resolve({ ok: false, error: err?.message || String(err) }))
      req.end()
    })
  }

  return {
    mode: 'client',
    list,
    refresh,
    find,
    disconnect,
    audit,
    /** Tell the server which DSH account this control side acts for. */
    setAccount(value) {
      const next = String(value ?? '').trim()
      if (next !== accountId) {
        accountId = next
        // A session belongs to one account; switching accounts must not reuse it.
        sessionToken = ''
        sessionExpiresAt = 0
        lastLoginError = ''
        cache = { ...cache, clients: [], kits: [] }
      }
    },
    getAccount() {
      return accountId
    },
    /**
     * Prepare the loopback port ssh will dial for this kit. On the tunnel server
     * the port is already live; anywhere else this starts a relay through the
     * admin port, which the router already forwards.
     */
    ensureRelayPort,
    /**
     * Run one command through the server. Used by a control side that cannot
     * reach the kit's loopback port; the server has the key and the port, so it
     * does the ssh and returns the result.
     */
    /**
     * Open a viewer forward on the tunnel server instead of here.
     *
     * A control side cannot `ssh -L` into a kit: the loopback port only exists on
     * the server. The server opens the forward and hands back a WebSocket path;
     * the local noVNC bridge relays the browser to it, so the viewer needs
     * nothing but a browser.
     */
    async vncStartRemote(session, remotePort = 5900) {
      const key = session.sessionKey || session.kitId
      const body = await request(`/api/kit/${encodeURIComponent(key)}/vnc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remotePort }),
      })
      const headers = await authHeaders()
      return {
        sessionId: body.sessionId,
        remotePort,
        streamUrl: `${base}${body.streamPath}`,
        headers,
        agent: transportFor(base).agent,
      }
    },

    /**
     * Viewer forwards currently open on the server. The switch in the settings
     * page is driven by this, not by local memory: the session lives there, and
     * it outlives a restart of this control side.
     */
    /** Save the operator label for a kit. Lives on the server with the kit. */
    async setNotes(session, notes) {
      const key = session?.sessionKey || session?.kitId || ''
      return request(`/api/kit/${encodeURIComponent(key)}/notes`, {
        method: 'POST',
        body: { notes: String(notes ?? '') },
      })
    },

    async vncListRemote() {
      const body = await request('/api/vnc/sessions')
      return Array.isArray(body.sessions) ? body.sessions : []
    },
    async vncStopRemote(session, sessionId) {
      const key = session.sessionKey || session.kitId
      try {
        await request(`/api/kit/${encodeURIComponent(key)}/vnc/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      } catch { /* already gone */ }
      return { ok: true }
    },

    uploadRemote,
    downloadRemote,
    async execRemote(session, { command, shell = 'auto', cwd = '', timeoutMs = 60000 } = {}) {
      const body = await request(`/api/kit/${encodeURIComponent(session.sessionKey || session.kitId)}/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // user 要一起发过去。服务端有它自己那份 session.user，那是客户端上报的原始值；
        // 控制端这边 resolveSession/sshBase 已经把机器账户（NAME$）换成了能在那台机器上
        // 登录的真实账户，不发过去的话服务器会拿 VISIONFRAME$ 去 ssh，一律
        // Permission denied —— 本机算好的结果就白费了。
        body: JSON.stringify({ command, shell, cwd, timeoutMs, user: session.user }),
      })
      return {
        exitCode: body.exitCode,
        stdout: String(body.stdout ?? ''),
        stderr: String(body.stderr ?? ''),
        truncated: Boolean(body.truncated),
        timedOut: Boolean(body.timedOut),
      }
    },
    /** Diagnostics: whether this side is a remote control side. */
    getRelayInfo() {
      return { remote: !localBase, ports: relay ? relay.ports : [] }
    },
    /** For the diag endpoint: whether a login session is live. */
    getSession() {
      return {
        hasPassword: Boolean(password),
        hasPlatformToken: typeof platformTokenProvider === 'function',
        platform: platformInfo,
        loggedIn: sessionValid(),
        verifiedBy: lastVerifiedBy,
        expiresAt: sessionExpiresAt ? new Date(sessionExpiresAt).toISOString() : '',
        lastError: lastLoginError,
      }
    },
    /** Let the host supply the DSH platform token instead of a config password. */
    setPlatformTokenProvider(fn) {
      platformTokenProvider = typeof fn === 'function' ? fn : null
      // A different credential may map to a different account; force a re-login.
      sessionToken = ''
      sessionExpiresAt = 0
    },
    /** Diagnostics only: what the host last saw in its platform session. */
    notePlatformSession(info) {
      platformInfo = info && typeof info === 'object' ? info : null
    },
    getLastRequestUrl() {
      return lastRequestUrl
    },
    getKitFilter() {
      return filter
    },
    auditPath: `${base} (remote audit)`,
    get sessionCount() {
      return cache.clients.length
    },
    status() {
      return {
        listening: cache.listening,
        tls: cache.tls,
        port: cache.port,
        error: cache.error || lastError,
        fingerprint: cache.fingerprint,
        clients: cache.clients.length,
      }
    },
    kits: {
      dir: cache.kitsDir,
      list: () => cache.kits,
      refresh: async () => {
        await refresh()
        return cache.kits
      },
    },
  }
}
