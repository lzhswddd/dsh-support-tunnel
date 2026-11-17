/**
 * Browser-facing routes for the plugin's settings page.
 *
 * The Client half runs in the browser and has no service that can call back into
 * the Host, so configuration and kit export travel over the Web GUI's own HTTP
 * server. Routes are exact-path under /api/support-tunnel/ and only answer the
 * owner principal.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

const API_PREFIX = '/api/support-tunnel'
const OPERATOR_KEY = 'operator_id'

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

function newKitId() {
  return `k${crypto.randomBytes(4).toString('hex')}`
}

function newToken() {
  return crypto.randomBytes(32).toString('hex')
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

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Build the client-side support.json for one kit. */
function buildSupportJson({ kitId, name, token, server, port, fingerprint, localPort }) {
  return {
    kitId,
    name,
    server,
    port,
    token,
    serverFingerprint: fingerprint,
    localHost: '127.0.0.1',
    localPort,
    reconnectDelayMs: 5000,
    insecure: false,
    tls: true,
    connectTimeoutMs: 15000,
  }
}

function ensureOperatorKey(kitDir, sshKeygen) {
  const keyPath = path.join(kitDir, 'operator', OPERATOR_KEY)
  if (fs.existsSync(keyPath)) return Promise.resolve({ created: false, path: keyPath })
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(path.dirname(keyPath), { recursive: true })
    } catch {
      resolve({ created: false, path: keyPath, error: 'mkdir failed' })
      return
    }
    execFile(sshKeygen, ['-t', 'ed25519', '-N', '', '-C', 'operator', '-f', keyPath], (err) => {
      if (err) resolve({ created: false, path: keyPath, error: err.message.split('\n')[0] })
      else resolve({ created: true, path: keyPath })
    })
  })
}

/**
 * @param ctx - scope owning the webServer service
 * @param server - tunnel server from lib/server.js
 * @param settings - normalized plugin config
 */
export function registerUiRoutes(ctx, server, settings) {
  const sshKeygen = settings.sshKeygen || 'ssh-keygen'
  const disposers = []

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
      const status = server.list()
      const kits = server.kits.list().map((entry) => ({
        name: entry.name,
        kitId: entry.kitId,
        hasToken: Boolean(entry.token),
        clientOs: entry.clientOs || '',
        kitDir: entry.kitDir,
      }))
      sendJson(res, 200, {
        listening: status.listening,
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
        publicServer: settings.publicServer || '',
        publicPort: settings.publicPort || status.port,
      })
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

      const name = safeKitName(body?.name)
      if (!name) {
        sendJson(res, 400, { error: 'kit 名不能为空，且不能包含 \\ / : * ? " < > |' })
        return
      }

      const publicServer = asText(body?.server, settings.publicServer)
      if (!publicServer) {
        sendJson(res, 400, { error: '请填写客户机要连的服务端域名或 IP' })
        return
      }

      const parsedPort = Number(body?.port ?? settings.publicPort ?? settings.port)
      const publicPort = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 24443

      const status = server.list()
      const fingerprint = asText(body?.fingerprint, status.fingerprint)

      server.kits.refresh()
      const entry = server.kits.list().find((item) => item.name === name)
      const created = !entry

      const kitRoot = path.join(server.kits.dir, name)
      const clientDir = path.join(kitRoot, 'client')

      const kitId = entry?.kitId || newKitId()
      const token = entry?.token || newToken()
      const localPort = entry?.localPort || 22

      if (created) {
        const key = await ensureOperatorKey(kitRoot, sshKeygen)
        writeJsonFile(path.join(clientDir, 'kit.json'), {
          id: kitId,
          name,
          host: publicServer,
          port: publicPort,
          tunnelUser: '',
          clientUser: asText(body?.clientUser, 'root'),
          sshLocalPort: localPort,
          sshRemotePort: 0,
          rdpLocalPort: 3389,
          rdpRemotePort: 0,
          enableRdp: false,
          isolatedUser: false,
          tenantUser: '',
          pinnedHostKey: false,
          knownHosts: 'known_hosts',
          phone: '',
          token,
          transport: 'http-tunnel',
        })
        if (key.error) {
          // Still usable: the operator key is only needed for ssh/scp from the Host.
          ctx.logger?.('support-tunnel')?.warn?.(`operator key not created: ${key.error}`)
        }
      }

      const support = buildSupportJson({
        kitId,
        name,
        token,
        server: publicServer,
        port: publicPort,
        fingerprint,
        localPort,
      })
      const supportPath = path.join(clientDir, 'support.json')
      writeJsonFile(supportPath, support)
      server.kits.refresh()

      sendJson(res, 200, {
        ok: true,
        created,
        kitId,
        name,
        path: supportPath,
        kitDir: kitRoot,
        fingerprint,
        support,
      })
    },
  }

  // Diagnostic: does the Host actually know about this package's browser half?
  // Answers the "settings page shows nothing" question without a browser session.
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
        graphError,
        graphLength: text.length,
        topKeys: graph && typeof graph === 'object' ? Object.keys(graph) : [],
        hasSupportTunnel: marker >= 0,
        around: marker >= 0 ? text.slice(Math.max(0, marker - 500), marker + 500) : '',
      })
    },
  }

  const routes = [stateRoute, exportRoute, diagRoute]
  for (const route of routes) {
    try {
      const dispose = ctx.webServer.register(route)
      disposers.push(dispose)
    } catch (err) {
      ctx.logger?.('support-tunnel')?.warn?.(`route ${route.path} not registered: ${err.message}`)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already gone */ }
    }
  }
}

export { API_PREFIX }
