import https from 'node:https'
import crypto from 'node:crypto'

/**
 * Remote backend: the same surface `lib/tools.js` expects from the embedded
 * server, but answered by a standalone tunnel server over HTTP.
 *
 * `list()` and `find()` stay synchronous by returning a cached snapshot, so a
 * tool call never blocks on the network twice; `refresh()` is the one call that
 * actually goes out, and every tool awaits it first.
 */

export function createRemoteBackend({ baseUrl, timeoutMs = 8000, kitFilter = '', apiToken = '', accountPassword = '', fingerprint = '', onLog } = {}) {
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

  function sessionValid() {
    return Boolean(sessionToken) && Date.now() < sessionExpiresAt - 60_000
  }

  async function doLogin() {
    if (!accountId) throw new Error('还没有确定 DSH 账户，无法登录')
    if (!password) throw new Error('没有配置 accountPassword')
    const payload = JSON.stringify({ account: accountId, password })
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
      const parsed = Date.parse(body.expiresAt || '')
      sessionExpiresAt = Number.isFinite(parsed)
        ? parsed
        : Date.now() + (Number(body.ttlSeconds) || 3600) * 1000
      lastLoginError = ''
      if (typeof onLog === 'function') {
        try { onLog(`login ok: ${accountId.slice(0, 8)}… (session valid until ${new Date(sessionExpiresAt).toISOString()})`) } catch { /* ignore */ }
      }
      return sessionToken
    } finally {
      clearTimeout(timer)
    }
  }

  /** Reuse a live session, otherwise log in once (shared across concurrent calls). */
  async function ensureSession(force = false) {
    if (!password) return ''
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
      if (password) {
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
      if (response.status === 401 && password && !alreadyRetried) {
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
        clients: allClients.filter(keep),
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

    const byKit = clients.filter((item) => String(item.kitId || '').toLowerCase() === lower)
    if (byKit.length === 1) return { session: byKit[0] }

    const matches = clients.filter((item) => String(item.name || '').toLowerCase().includes(lower))
    if (matches.length === 1) return { session: matches[0] }
    if (matches.length > 1) {
      return { error: `target 匹配到多台在线客户机：${matches.map((s) => `${s.name}(${s.kitId})`).join('、')}` }
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
    /** For the diag endpoint: whether a login session is live. */
    getSession() {
      return {
        hasPassword: Boolean(password),
        loggedIn: sessionValid(),
        expiresAt: sessionExpiresAt ? new Date(sessionExpiresAt).toISOString() : '',
        lastError: lastLoginError,
      }
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
