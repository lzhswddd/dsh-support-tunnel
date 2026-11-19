/**
 * Settings-page HTTP routes for the control side.
 *
 * This plugin never owns kits: it reads the standalone tunnel server's snapshot
 * and proxies export requests to it. Everything here is a thin, loopback-only
 * façade over that server's admin API.
 *
 * The browser has no service that can call into the Host, so the settings page
 * reaches these routes through the Web GUI's own HTTP server.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const API_PREFIX = '/api/support-tunnel'
/**
 * Open the viewer as its own window.
 *
 * The settings page cannot do this itself — it runs inside the desktop app,
 * where window.open is refused — and an inline iframe keeps the screen boxed
 * inside a settings dialog, which is not how anyone expects to use a remote
 * desktop. A Chromium app window has no address bar and no tabs, so it reads as
 * a viewer rather than as a web page.
 */
function openViewer(url) {
  try {
    if (process.platform === 'win32') {
      const roots = [
        process.env['PROGRAMFILES'],
        process.env['PROGRAMFILES(X86)'],
        process.env.LOCALAPPDATA,
      ].filter(Boolean)
      const rels = [
        'Google/Chrome/Application/chrome.exe',
        'Microsoft/Edge/Application/msedge.exe',
        'Chromium/Application/chrome.exe',
      ]
      for (const root of roots) {
        for (const rel of rels) {
          const exe = path.join(root, rel)
          try {
            if (!fs.existsSync(exe)) continue
          } catch { continue }
          spawn(exe, [
            `--app=${url}`,
            '--window-size=1440,900',
            '--window-position=80,60',
          ], { detached: true, stdio: 'ignore' }).unref()
          return { opened: true, via: path.basename(exe) }
        }
      }
      // No Chromium-family browser: fall back to whatever handles http.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return { opened: true, via: 'default-browser' }
    }
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref()
    return { opened: true, via: cmd }
  } catch (err) {
    return { opened: false, error: err?.message || String(err) }
  }
}


function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/**
 * The resource contract receives `peer` only when the caller supplies one, and
 * a plain HTTP request does not, so owner identity cannot be checked there.
 * These routes therefore use the handler form and refuse anything that is not a
 * loopback request.
 */
function isLocalRequest(req) {
  const address = req.socket?.remoteAddress || ''
  const normalized = address.replace(/^::ffff:/, '')
  return normalized === '' || normalized === '127.0.0.1' || normalized === '::1'
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

function asText(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  const text = String(value).trim()
  return text || fallback
}

/** Path-traversal guard: kit names come from the browser. */
function safeKitName(raw) {
  const name = asText(raw)
  if (!name) return ''
  if (name === '.' || name === '..') return ''
  if (/[\\/:*?"<>|]/.test(name)) return ''
  return name
}

function remoteBaseOf(settings) {
  const base = asText(settings?.remoteUrl)
  return base ? base.replace(/\/+$/, '') : ''
}

/**
 * @param ctx - scope owning the webServer service
 * @param backend - remote backend from lib/remote.js
 * @param settings - normalized plugin config
 */
export function registerUiRoutes(ctx, backend, settings, vnc, remoteVnc) {
  // remoteVnc maps a virtual local port -> { url, headers, agent }. The noVNC
  // bridge looks a port up here before falling back to a local TCP dial, which
  // is how a control side watches a desktop without any ssh of its own.
  const remoteForwards = remoteVnc instanceof Map ? remoteVnc : new Map()
  let remoteSeq = 0
  const nextRemotePort = () => 6100 + ((remoteSeq += 1) % 100)
  const remoteBase = remoteBaseOf(settings)

  const stateRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: async (req, res) => {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: 'only loopback requests are accepted' })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      if (typeof backend.refresh === 'function') await backend.refresh()

      const status = backend.list()
      const kits = backend.kits.list().map((entry) => ({
        name: entry.name,
        kitId: entry.kitId,
        hasToken: Boolean(entry.token),
        clientOs: entry.clientOs || '',
        kitDir: entry.kitDir,
        notes: entry.notes || '',
      }))

      // Join kits against live sessions so the page can show, per kit, whether
      // anything is online right now and on which machine.
      const online = new Map()
      for (const client of status.clients || []) {
        const key = String(client.kitId || '')
        const list = online.get(key) || []
        list.push({
          sessionKey: client.sessionKey || `${client.kitId}|${client.clientHost || 'unknown'}`,
          clientHost: client.clientHost || '',
          clientOs: client.clientOs || '',
          user: client.user || '',
          localPort: client.localPort,
          streams: client.streams || 0,
          idleSeconds: client.idleSeconds || 0,
          // sshd answering on the landing port. The tunnel being up does not mean
          // the machine is workable: sshd can be dead while the agent stays connected.
          sshUp: client.sshUp === true,
          sshDetail: client.sshDetail || '',
        })
        online.set(key, list)
      }

      const devices = [
        ...kits.map((kit) => ({
          ...kit,
          online: online.has(kit.kitId),
          sessions: online.get(kit.kitId) || [],
        })),
        // A connected client whose kit directory is gone still deserves a row.
        ...[...online.entries()]
          .filter(([kitId]) => !kits.some((kit) => kit.kitId === kitId))
          .map(([kitId, sessions]) => ({
            name: sessions[0]?.clientHost || kitId,
            kitId,
            hasToken: false,
            clientOs: sessions[0]?.clientOs || '',
            kitDir: '',
            online: true,
            sessions,
          })),
      ]

        // Which machines have a viewer open right now. Asked of the server, not
        // remembered locally: the session lives there, outlives this process, and
        // a browser closed without clicking stop leaves nothing behind that the
        // server is not already reclaiming.
        let vncSessions = []
        if (typeof backend.vncListRemote === 'function') {
          try {
            const open = await backend.vncListRemote()
            vncSessions = open.map((entry) => {
              const local = [...remoteForwards.entries()].find(([, v]) => v.sessionId === entry.id)
              const port = local ? local[0] : null
              return {
                sessionId: entry.id,
                kitId: entry.kitId,
                remotePort: entry.remotePort,
                ageSeconds: entry.ageSeconds,
                localPort: port,
                webUrl: port
                  ? 'http://127.0.0.1:' + settings.novncPort + '/vnc.html'
                    + '?host=127.0.0.1&port=' + settings.novncPort
                    + '&path=ws/' + port + '&scale=true'
                    + (settings.vncPassword ? '&password=' + encodeURIComponent(settings.vncPassword) : '')
                  : '',
              }
            })
          } catch { /* leave it empty; the switch just reads as off */ }
        }

        sendJson(res, 200, {
          vncSessions,
        mode: 'client',
        remoteUrl: remoteBase,
        listening: status.listening,
        reachable: status.reachable !== false,
        port: status.port,
        host: status.host,
        tls: status.tls,
        fingerprint: status.fingerprint,
        error: status.error,
        kitsDir: status.kitsDir,
        basePort: status.basePort,
        maxClients: status.maxClients,
        clients: status.clients,
        kits,
        devices,
        publicServer: settings.publicServer || '',
        publicPort: settings.publicPort || status.port,
      })
    },
  }

  // Operator label for a kit. Kept on the server beside the kit so every control
  // side sees the same text, and so reinstalling a stick does not lose it.
  const notesRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/notes`,
    handler: async (req, res) => {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: 'only loopback requests are accepted' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      if (typeof backend.setNotes !== 'function') {
        sendJson(res, 400, { error: '这个版本的后端不支持备注' })
        return
      }
      let body = {}
      try { body = await readJson(req) } catch { body = {} }
      const kitId = String(body?.kitId || '').trim()
      if (!kitId) {
        sendJson(res, 400, { error: 'kitId 不能为空' })
        return
      }
      const session = typeof backend.find === 'function' ? backend.find(kitId) : null
      if (!session || session.error) {
        sendJson(res, 404, { error: session?.error || `找不到 ${kitId}` })
        return
      }
      try {
        const result = await backend.setNotes(session, body?.notes ?? '')
        sendJson(res, 200, { ok: true, kitId, notes: result?.notes ?? String(body?.notes ?? '') })
      } catch (err) {
        sendJson(res, 500, { error: `保存备注失败：${err?.message || err}` })
      }
    },
  }

  const exportRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/export`,
    handler: async (req, res) => {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: 'only loopback requests are accepted' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { error: `请求体无效：${err.message}` })
        return
      }

      if (!safeKitName(body?.name)) {
        sendJson(res, 400, { error: 'kit 名不能为空，且不能包含 \\ / : * ? " < > |' })
        return
      }
      if (!asText(body?.server)) {
        sendJson(res, 400, { error: '请填写客户机要连的服务端域名或 IP' })
        return
      }

      // The kit is written where kitsDir lives — always on the tunnel server.
      if (!remoteBase) {
        sendJson(res, 500, { error: 'remoteUrl 未配置，无法导出' })
        return
      }

      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), settings.remoteTimeoutMs || 15000)
        let remoteResponse
        try {
          remoteResponse = await fetch(`${remoteBase}/api/export`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
        } finally {
          clearTimeout(timer)
        }
        const text = await remoteResponse.text()
        const parsed = text ? JSON.parse(text) : {}
        if (!remoteResponse.ok) {
          sendJson(res, remoteResponse.status, { error: parsed.error || `HTTP ${remoteResponse.status}` })
          return
        }
        sendJson(res, 200, parsed)
      } catch (err) {
        sendJson(res, 502, { error: `隧道服务器不可达：${err?.message || err}` })
      }
    },
  }

  // VNC is the operator's own channel: the page opens a forward, then the
  // operator points a VNC viewer at 127.0.0.1:<port>.
  const vncRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/vnc`,
    handler: async (req, res) => {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: 'only loopback requests are accepted' })
        return
      }
      if (!vnc) {
        sendJson(res, 500, { error: 'VNC 转发不可用（插件未初始化）' })
        return
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, { forwards: vnc.list() })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }

      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, 400, { error: `请求体无效：${err.message}` })
        return
      }

      const action = String(body?.action || 'start')
      const target = asText(body?.target)
      if (!target) {
        sendJson(res, 400, { error: 'target 不能为空' })
        return
      }

      if (typeof backend.refresh === 'function') await backend.refresh()
      const found = backend.find(target)
      if (found.error) {
        sendJson(res, 404, { error: found.error, forwards: vnc.list() })
        return
      }
      const session = found.session

      if (action === 'stop') {
        // A remote session lives on the server, so there is nothing local to
        // stop — vnc.stop() would answer "no such forward" for a viewer that is
        // very much open. Close them there and drop our virtual-port records.
        if (typeof backend.vncListRemote === 'function') {
          try {
            const open = await backend.vncListRemote()
            let closed = 0
            for (const entry of open) {
              if (String(entry.kitId) !== String(session.kitId)) continue
              await backend.vncStopRemote(session, entry.id)
              closed += 1
              for (const [port, info] of [...remoteForwards.entries()]) {
                if (info.sessionId === entry.id) remoteForwards.delete(port)
              }
            }
            sendJson(res, 200, { ok: true, stopped: true, closed, forwards: [] })
          } catch (err) {
            sendJson(res, 400, { error: `关闭远程查看失败：${err?.message || err}` })
          }
          return
        }

        const result = vnc.stop(session)
        if (result.error) {
          sendJson(res, 400, { error: result.error, forwards: vnc.list() })
          return
        }
        sendJson(res, 200, { ok: true, stopped: true, localPort: result.localPort, forwards: vnc.list() })
        return
      }

      if (action === 'stopAll') {
        vnc.stopAll()
        sendJson(res, 200, { ok: true, forwards: [] })
        return
      }

      if (action === 'password') {
        const changed = await vnc.setPassword(session, body?.password)
        if (!changed.ok) {
          sendJson(res, 400, { error: changed.error, forwards: vnc.list() })
          return
        }
        sendJson(res, 200, {
          ok: true,
          changed: true,
          target,
          kitId: session.kitId,
          clientHost: session.clientHost,
          password: changed.password,
          forwards: vnc.list(),
        })
        return
      }

      // Remote control side: it holds no operator key and the kit's loopback port
      // is on the server, so `ssh -L` here could never work. The server opens the
      // forward; we point the local bridge at the resulting WebSocket.
      if (typeof backend.vncStartRemote === 'function') {
        let started
        try {
          started = await backend.vncStartRemote(session, Number(body?.remotePort) || 5900)
        } catch (err) {
          sendJson(res, 400, { error: `服务器打开 VNC 转发失败：${err?.message || err}` })
          return
        }
        const localPort = nextRemotePort()
        remoteForwards.set(localPort, {
          url: started.streamUrl,
          headers: started.headers,
          agent: started.agent,
          sessionId: started.sessionId,
          kitId: session.kitId,
          clientHost: session.clientHost,
        })
        const effectivePassword = (typeof vnc.getPassword === 'function' ? vnc.getPassword(session) : null)
          || settings.vncPassword
          || ''
        const viewerUrl = `http://127.0.0.1:${settings.novncPort}/vnc.html`
          + `?host=127.0.0.1&port=${settings.novncPort}`
          + `&path=ws/${localPort}&scale=true`
          + (effectivePassword ? `&password=${encodeURIComponent(effectivePassword)}` : '')
        // Open it here rather than asking the page to: the page is sandboxed
        // inside the desktop app and cannot create windows.
        const viewer = openViewer(viewerUrl)
        sendJson(res, 200, {
          ok: true,
          target,
          kitId: session.kitId,
          clientHost: session.clientHost,
          address: `127.0.0.1:${localPort}`,
          localPort,
          remoteSession: started.sessionId,
          reused: false,
          serverStarted: false,
          webUrl: viewerUrl,
          viewer,
          forwards: vnc.list(),
        })
        return
      }

      const result = await vnc.start(session, {
        remotePort: body?.remotePort,
        localPort: body?.localPort,
        // A control side on another machine needs the kit port relayed here
        // before ssh can forward anything from it.
        ensureRelay: typeof backend.ensureRelayPort === 'function'
          ? (s) => backend.ensureRelayPort(s)
          : undefined,
      })
      if (!result.ok) {
        sendJson(res, 400, { error: result.error, forwards: vnc.list() })
        return
      }
      // Per-machine password (set via action=password) wins over the global default.
      const effectivePassword = (typeof vnc.getPassword === 'function' ? vnc.getPassword(session) : null)
        || settings.vncPassword
        || ''
      sendJson(res, 200, {
        ok: true,
        target,
        kitId: session.kitId,
        clientHost: session.clientHost,
        address: result.address,
        localPort: result.localPort,
        reused: Boolean(result.reused),
        serverStarted: Boolean(result.serverStarted),
        // One click: open this in a browser, no VNC viewer needed.
        webUrl: `http://127.0.0.1:${settings.novncPort}/vnc.html`
          + `?host=127.0.0.1&port=${settings.novncPort}`
          + `&path=ws/${result.localPort}&scale=true`
          + (effectivePassword ? `&password=${encodeURIComponent(effectivePassword)}` : ''),
        forwards: vnc.list(),
      })
    },
  }

  // Diagnostic: does the Host actually know about this package's browser half?
  const diagRoute = {
    kind: 'exact',
    path: `${API_PREFIX}/diag`,
    handler: async (req, res) => {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { error: 'only loopback requests are accepted' })
        return
      }
      let graph
      let graphError = ''
      try {
        const clientModules = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
        graph = clientModules?.graph?.()
      } catch (err) {
        graphError = err?.message || String(err)
      }
      let text = ''
      try {
        text = graph === undefined ? '' : JSON.stringify(graph)
      } catch {
        text = ''
      }
      const marker = text.indexOf('support-tunnel')
      sendJson(res, 200, {
        mode: 'client',
        remoteUrl: remoteBase,
        // What the server is being told about the signed-in DSH account; empty
        // means the plugin could not resolve a userId and kits stay unscoped.
        account: typeof backend.getAccount === 'function' ? backend.getAccount() : '',
        lastRequestUrl: typeof backend.getLastRequestUrl === 'function' ? backend.getLastRequestUrl() : '',
        session: typeof backend.getSession === 'function' ? backend.getSession() : null,
        kitFilter: typeof backend.getKitFilter === 'function' ? backend.getKitFilter() : '',
        graphError,
        graphLength: text.length,
        topKeys: graph && typeof graph === 'object' ? Object.keys(graph) : [],
        hasSupportTunnel: marker >= 0,
        around: marker >= 0 ? text.slice(Math.max(0, marker - 500), marker + 500) : '',
      })
    },
  }

  const routes = [stateRoute, exportRoute, notesRoute, vncRoute, diagRoute]
  const disposers = []
  for (const route of routes) {
    disposers.push(ctx.webServer.register(route))
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* closing a route twice is harmless */
      }
    }
  }
}
