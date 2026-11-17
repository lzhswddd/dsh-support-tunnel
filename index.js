/**
 * support-tunnel 鈥?HTTP/HTTPS reverse tunnel for customer machines.
 *
 * Replaces the SSH `-R` fan-out with one inbound port: every kit opens a single
 * long-lived POST /t/<kitId>, and the Host listens on 127.0.0.1:<basePort+i> for
 * each connected kit so ssh/scp can reach it without a router mapping.
 *
 * No Config export on purpose: a bundle installed into a profile cannot resolve
 * `@deepseek-ai/schemastery`, and an unresolvable import would leave the plugin
 * fiber undefined. Defaults and normalization live in normalizeConfig() instead.
 */

import { createTunnelServer } from './lib/server.js'
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

function port(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback
}

function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/** Fill defaults for every documented config field; unknown keys are ignored. */
export function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const windows = process.platform === 'win32'
  return {
    port: port(raw.port, 24443),
    host: text(raw.host, '0.0.0.0'),
    tls: raw.tls !== false,
    tlsCert: text(raw.tlsCert),
    tlsKey: text(raw.tlsKey),
    certName: text(raw.certName, 'support-tunnel'),
    domain: text(raw.domain),
    basePort: port(raw.basePort, 40001),
    maxClients: positiveInt(raw.maxClients, 20),
    // TUNNEL_KITS_DIR wins so a machine can be moved without editing the patch;
    // an empty value means <DSH_HOME>/support-tunnel/kits.
    kitsDir: text(process.env.TUNNEL_KITS_DIR) || text(raw.kitsDir),
    sshBinary: text(raw.sshBinary, windows ? 'ssh.exe' : 'ssh'),
    scpBinary: text(raw.scpBinary, windows ? 'scp.exe' : 'scp'),
    sshKeygen: text(raw.sshKeygen, windows ? 'ssh-keygen.exe' : 'ssh-keygen'),
    // Advertised address written into generated kits; the settings page collects
    // it because the Host cannot know which domain customers will dial.
    publicServer: text(raw.publicServer),
    publicPort: Number.isInteger(Number(raw.publicPort)) && Number(raw.publicPort) > 0
      ? Math.floor(Number(raw.publicPort))
      : 0,
    auditFile: text(raw.auditFile, '~/.dsh/tunnel-audit.jsonl'),
    idleKillMs: Number.isFinite(Number(raw.idleKillMs)) ? Math.max(0, Math.floor(Number(raw.idleKillMs))) : 0,
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
  const server = createTunnelServer(settings, { onLog: log })
  let stopped = false

  ctx.effect(() => {
    // A busy port must not fail activation: start() resolves with state.error.
    server.start()
      .then((result) => {
        if (stopped) return
        if (result.listening) {
          log(`ready on port ${result.port} (${result.tls ? 'https' : 'http'}), kits dir ${settings.kitsDir}`)
        } else {
          log(`not listening on port ${result.port}: ${result.error}`)
        }
      })
      .catch((err) => {
        log(`start failed: ${err && err.message}`)
      })

    return () => {
      stopped = true
      server.stop()
    }
  }, 'support-tunnel.server()')

  // The settings page talks to the Host over the Web GUI's HTTP server. A
  // headless profile has no webServer, and the tunnel tools still work there.
  ctx.inject(['webServer'], (webCtx) => {
    if (stopped) return
    return registerUiRoutes(webCtx, server, settings)
  })

  registerTools(ctx, server, settings)
}
