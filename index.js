/**
 * support-tunnel — control side only.
 *
 * The tunnel endpoint is a separate process (see ../tunnel-server). This plugin
 * never accepts customer traffic: it discovers connected machines through the
 * server's loopback admin API and reaches them with ssh over the loopback ports
 * the server allocated for each of them.
 *
 * No Config export on purpose: a bundle installed into a profile cannot resolve
 * `@deepseek-ai/schemastery`, and an unresolvable import would leave the plugin
 * fiber undefined. Defaults and normalization live in normalizeConfig() instead.
 */

import { createRemoteBackend } from './lib/remote.js'
import { createVncManager } from './lib/vnc.js'
import { createNoVncProxy } from './lib/novnc-proxy.js'
import { registerTools } from './lib/tools.js'
import { registerUiRoutes } from './lib/ui-api.js'

/** Loader entry id. */
export const name = 'support-tunnel'

/** The tunnel tools need the registry; everything else is self-contained. */
export const inject = ['tools']

function text(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  const trimmed = String(value).trim()
  return trimmed || fallback
}

function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/** A stick may own several kits: accept an array or "a,b,c". */
function parseKitIds(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',')
  return list.map((item) => String(item ?? '').trim()).filter(Boolean)
}

/** Fill defaults for every documented config field; unknown keys are ignored. */
export function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const windows = process.platform === 'win32'
  return {
    // Where the standalone tunnel server's admin API answers. TUNNEL_SERVER_URL
    // wins so a machine can be repointed without editing the patch.
    remoteUrl: text(process.env.TUNNEL_SERVER_URL) || text(raw.remoteUrl, 'http://127.0.0.1:24444'),
    // Required when the admin API is bound beyond loopback (a control side on
    // another machine). Ignored for loopback callers, so local installs need
    // no extra configuration.
    remoteToken: text(process.env.TUNNEL_API_TOKEN) || text(raw.remoteToken),
    // sha256 fingerprint of the server certificate. Needed only when remoteUrl
    // is https with a self-signed cert — the tunnel listener's own certificate.
    remoteFingerprint: text(process.env.TUNNEL_SERVER_FINGERPRINT) || text(raw.remoteFingerprint),
    remoteTimeoutMs: positiveInt(raw.remoteTimeoutMs, 8000),
    // A stick can own several kits (a Windows kit and a Linux kit issued
    // separately). Array or "a,b,c". Empty = show every kit the server knows,
    // which is only useful when debugging.
    kitId: parseKitIds(process.env.TUNNEL_KIT_ID ?? raw.kitId),
    sshBinary: text(raw.sshBinary, windows ? 'ssh.exe' : 'ssh'),
    scpBinary: text(raw.scpBinary, windows ? 'scp.exe' : 'scp'),
    sshKeygen: text(raw.sshKeygen, windows ? 'ssh-keygen.exe' : 'ssh-keygen'),
    // Fallback login account when a client reports the machine account (NAME$),
    // which happens when the agent runs under a SYSTEM scheduled task.
    clientUser: text(raw.clientUser),
    // Advertised address pre-filled into the export form; the server collects
    // it because it cannot know which domain customers will dial.
    publicServer: text(raw.publicServer),
    publicPort: Number.isInteger(Number(raw.publicPort)) && Number(raw.publicPort) > 0
      ? Math.floor(Number(raw.publicPort))
      : 0,
    auditFile: text(raw.auditFile, '~/.dsh/tunnel-audit.jsonl'),
    // Where open VNC forwards are remembered across Host restarts.
    vncForwardsFile: text(raw.vncForwardsFile),
    // How to start the VNC server on the customer machine when 5900 is closed.
    // Empty = platform default (stick's _vnc.ps1 on Windows, x11vnc on Linux).
    vncStartCommand: text(raw.vncStartCommand),
    vncScriptDir: text(raw.vncScriptDir),
    // Loopback port for the bundled noVNC page (WebSocket <-> TCP bridge).
    novncPort: positiveInt(raw.novncPort, 6080),
    // VNC password the customer machine was configured with; appended to the
    // noVNC URL so the browser never prompts. Empty = no password.
    vncPassword: text(raw.vncPassword),
  }
}

function makeLogger(ctx) {
  let logger
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger('support-tunnel') : undefined
  } catch {
    logger = undefined
  }
  return (line) => {
    try {
      if (logger && typeof logger.info === 'function') logger.info(line)
      else console.log(`[support-tunnel] ${line}`)
    } catch {
      /* logging must never take the tunnel down */
    }
  }
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const log = makeLogger(ctx)
  const backend = createRemoteBackend({
    baseUrl: settings.remoteUrl,
    timeoutMs: settings.remoteTimeoutMs,
    kitFilter: settings.kitId,
    apiToken: settings.remoteToken,
    fingerprint: settings.remoteFingerprint,
    onLog: log,
  })
  let stopped = false

  // VNC forwards are for the human operator; the tools drive ui-agent instead.
  // start() also brings the remote VNC server up, so one click is enough.
  const vnc = createVncManager({
    sshBinary: settings.sshBinary,
    storeFile: settings.vncForwardsFile,
    startCommand: settings.vncStartCommand,
    scriptDir: settings.vncScriptDir,
    onLog: log,
  })

  log(`control side: server ${settings.remoteUrl}, kit ${settings.kitId || '(all)'}`)

  // Identify the DSH account this Host is signed in as, and hand it to the
  // backend. The tunnel server keeps kits per account, so another computer
  // signed in with the same account sees exactly the same devices without any
  // local kit configuration. Everything here is optional: a missing service or
  // a signed-out account simply leaves the account filter empty.
  if (typeof ctx.get === 'function' && ctx.get('deepseekAccount')) {
    const accountService = ctx.get('deepseekAccount')
    const resolveAccount = async () => {
      try {
        const identity = await accountService.getDeviceIdentity()
        if (identity?.userId) return String(identity.userId)
      } catch { /* fall through to the profile read */ }
      try {
        const profile = await accountService.getProfile({
          version: '1', locale: 'zh', timezoneOffsetSeconds: 0,
        })
        if (profile?.status === 'ready' && profile.value?.id) return String(profile.value.id)
      } catch { /* stay anonymous */ }
      return ''
    }
    resolveAccount().then((id) => {
      if (stopped) return
      backend.setAccount(id)
      log(id ? `account: ${id.slice(0, 8)}… (kits scoped to this account)` : 'account: not signed in (kits unscoped)')
      backend.refresh().catch(() => {})
    }).catch(() => {})
  }

  ctx.effect(() => {
    backend.refresh()
      .then((snapshot) => {
        if (stopped) return
        if (snapshot.listening) {
          log(`server up on port ${snapshot.port}, ${snapshot.clients.length} client(s) online`)
        } else {
          log(`server not reachable: ${snapshot.error || 'unknown'}`)
        }
      })
      .catch(() => {})

    return () => {
      stopped = true
    }
  }, 'support-tunnel.remote()')

  // Browser VNC client so the operator does not need a viewer installed.
  const novnc = createNoVncProxy({ port: settings.novncPort, onLog: log })
  ctx.effect(() => {
    let closed = false
    novnc.start().then((result) => {
      if (closed) return
      if (result.listening) log(`novnc page at http://127.0.0.1:${result.port}/vnc.html`)
      else log(`novnc bridge not listening on ${settings.novncPort}: ${result.error}`)
    })
    return () => {
      closed = true
      novnc.stop()
    }
  }, 'support-tunnel.novnc()')

  // The settings page talks to the Host over the Web GUI's HTTP server. A
  // headless profile has no webServer, and the tunnel tools still work there.
  ctx.inject(['webServer'], (webCtx) => {
    if (stopped) return
    return registerUiRoutes(webCtx, backend, settings, vnc)
  })

  registerTools(ctx, backend, settings, vnc)
}
