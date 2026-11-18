/**
 * Remote backend: the same surface `lib/tools.js` expects from the embedded
 * server, but answered by a standalone tunnel server over HTTP.
 *
 * `list()` and `find()` stay synchronous by returning a cached snapshot, so a
 * tool call never blocks on the network twice; `refresh()` is the one call that
 * actually goes out, and every tool awaits it first.
 */

export function createRemoteBackend({ baseUrl, timeoutMs = 8000, kitFilter = '', onLog } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
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

  async function request(pathname, init) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // Identify which DSH account this control side is using. The server keeps
      // kits per account, so every machine signed in with the same account sees
      // the same devices without any local kitId configuration. Sent both as a
      // header and as a query parameter: headers survive proxies better, query
      // parameters survive fetch options being replaced by a caller.
      const headers = { ...(init?.headers || {}) }
      let url = `${base}${pathname}`
      if (accountId) {
        headers['X-Account-Id'] = encodeURIComponent(accountId)
        url += `${pathname.includes('?') ? '&' : '?'}account=${encodeURIComponent(accountId)}`
      }
      lastRequestUrl = url
      const response = await fetch(url, { ...init, headers, signal: controller.signal })
      const text = await response.text()
      const body = text ? JSON.parse(text) : {}
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
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
        cache = { ...cache, clients: [], kits: [] }
      }
    },
    getAccount() {
      return accountId
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
