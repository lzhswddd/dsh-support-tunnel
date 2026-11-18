/**
 * Model-facing tunnel tools.
 *
 * Definitions are written as plain ToolDefinition objects instead of importing
 * `defineTool` from '@deepseek-ai/dsh-tools': a profile-installed bundle cannot
 * resolve that package, and the registry only requires `output.schema` plus
 * `output.render`. Schemas below therefore use standard JSON Schema.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { checkCommand, guardEnabled } from './guard.js'

const MAX_OUTPUT_BYTES = 120_000
const DEFAULT_EXEC_TIMEOUT_MS = 60_000
const DEFAULT_SCP_TIMEOUT_MS = 600_000
const MAX_TIMEOUT_MS = 30 * 60_000

// -------------------------------------------------------------------- helpers

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function presentCard(title, kind, rawInput) {
  return rawInput === undefined
    ? { card: 'generic', title, kind }
    : { card: 'generic', title, kind, rawInput }
}

/** SSH prints the console code page on Windows; fall back to GBK when UTF-8 fails. */
function decodeBytes(buffer) {
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}

function clampTimeout(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), MAX_TIMEOUT_MS)
}

function knownHostsNull() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

function quoteForShell(text) {
  return `"${String(text).replace(/"/g, '\\"')}"`
}

/** PowerShell through EncodedCommand so quoting never reaches a shell parser. */
function powershellEncoded(script) {
  const body = `$ProgressPreference='SilentlyContinue';${script}`
  const encoded = Buffer.from(body, 'utf16le').toString('base64')
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -EncodedCommand ${encoded}`
}

function runProcess(binary, args, { timeoutMs = DEFAULT_EXEC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let timedOut = false
    let truncated = false
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const outChunks = []
    const errChunks = []

    const finish = (exitCode, launchError) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : -1,
        stdout: decodeBytes(Buffer.concat(outChunks)).slice(0, MAX_OUTPUT_BYTES),
        stderr: launchError
          ? `${launchError}\n${decodeBytes(Buffer.concat(errChunks))}`.slice(0, MAX_OUTPUT_BYTES)
          : decodeBytes(Buffer.concat(errChunks)).slice(0, MAX_OUTPUT_BYTES),
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated,
      })
    }

    let child
    try {
      child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      finish(-1, `无法启动 ${binary}：${err.message}`)
      return
    }

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      setTimeout(() => finish(-1), 2000).unref?.()
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= MAX_OUTPUT_BYTES) outChunks.push(chunk)
      else truncated = true
    })
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= MAX_OUTPUT_BYTES) errChunks.push(chunk)
      else truncated = true
    })
    child.on('error', (err) => finish(-1, `无法启动 ${binary}：${err.message}`))
    child.on('close', (code) => finish(code))
  })
}

function sshBase(settings, session) {
  return [
    '-n', '-T',
    '-i', session.operatorKey,
    '-p', String(session.localPort),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', `UserKnownHostsFile=${knownHostsNull()}`,
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'LogLevel=ERROR',
    '-o', 'GlobalKnownHostsFile=' + knownHostsNull(),
    `${session.user}@127.0.0.1`,
  ]
}

function shortError(message) {
  return `support-tunnel: ${message}`
}

/**
 * A kit copied out of a zip usually loses the tight ACL ssh-keygen wrote, and
 * OpenSSH then refuses the key with a wall of @@@ noise. Append what to run.
 */
function withKeyHint(stderr, operatorKey) {
  const text = String(stderr ?? '')
  if (!text.includes('UNPROTECTED PRIVATE KEY FILE')) return text
  return `${text}
[support-tunnel] operator_id 的 ACL 太宽，OpenSSH 拒绝加载私钥。收紧后重试：
  icacls "${operatorKey}" /inheritance:r /grant:r "%USERNAME%:(F)"`
}

// -------------------------------------------------------------------- schemas

const CLIENT_SCHEMA = {
  type: 'object',
  properties: {
    kitId: { type: 'string' },
    name: { type: 'string' },
    clientHost: { type: 'string' },
    clientOs: { type: 'string', description: 'win or unix, as reported by the client.' },
    clientShell: { type: 'string', description: 'Login shell path the client reported.' },
    user: { type: 'string' },
    localPort: { type: 'integer' },
    connectedAt: { type: 'string' },
    streams: { type: 'integer' },
    bytesIn: { type: 'integer' },
    bytesOut: { type: 'integer' },
    idleSeconds: { type: 'integer' },
    sshCommand: { type: 'string' },
  },
  required: ['kitId', 'name', 'localPort', 'user', 'streams', 'bytesIn', 'bytesOut'],
}

const LIST_SCHEMA = {
  type: 'object',
  properties: {
    listening: { type: 'boolean' },
    tls: { type: 'boolean' },
    port: { type: 'integer' },
    host: { type: 'string' },
    fingerprint: { type: 'string' },
    error: { type: 'string' },
    startedAt: { type: 'string' },
    basePort: { type: 'integer' },
    maxClients: { type: 'integer' },
    kitsDir: { type: 'string' },
    kitsWithToken: { type: 'integer' },
    accepted: { type: 'integer' },
    rejected: { type: 'integer' },
    clients: { type: 'array', items: CLIENT_SCHEMA },
  },
  required: ['listening', 'tls', 'port', 'clients'],
}

const EXEC_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string' },
    kitId: { type: 'string' },
    localPort: { type: 'integer' },
    shell: { type: 'string' },
    exitCode: { type: 'integer' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    durationMs: { type: 'integer' },
    timedOut: { type: 'boolean' },
    truncated: { type: 'boolean' },
    blocked: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['target', 'kitId', 'localPort', 'shell', 'exitCode', 'stdout', 'stderr', 'durationMs', 'timedOut', 'truncated', 'blocked', 'reason'],
}

const TRANSFER_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string' },
    kitId: { type: 'string' },
    localPort: { type: 'integer' },
    direction: { type: 'string' },
    localPath: { type: 'string' },
    remotePath: { type: 'string' },
    exitCode: { type: 'integer' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    durationMs: { type: 'integer' },
    bytes: { type: 'integer' },
    timedOut: { type: 'boolean' },
  },
  required: ['target', 'kitId', 'localPort', 'direction', 'localPath', 'remotePath', 'exitCode', 'stdout', 'stderr', 'durationMs', 'bytes', 'timedOut'],
}

const DISCONNECT_SCHEMA = {
  type: 'object',
  properties: {
    disconnected: { type: 'boolean' },
    kitId: { type: 'string' },
    name: { type: 'string' },
    localPort: { type: 'integer' },
    error: { type: 'string' },
  },
  required: ['disconnected'],
}

// A VNC forward either reports one target (start/stop) or the whole list (status),
// so every field is optional and the schema stays flat.
const VNC_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    target: { type: 'string' },
    kitId: { type: 'string' },
    clientHost: { type: 'string' },
    localPort: { type: 'integer' },
    remotePort: { type: 'integer' },
    address: { type: 'string' },
    reused: { type: 'boolean' },
    serverStarted: { type: 'boolean' },
    stopped: { type: 'boolean' },
    password: { type: 'string' },
    changed: { type: 'boolean' },
    hint: { type: 'string' },
    forwards: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
  },
}

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    total: { type: 'integer' },
    returned: { type: 'integer' },
    items: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
    error: { type: 'string' },
  },
  required: ['path', 'total', 'returned', 'items'],
}

// ----------------------------------------------------------------------- tools

/**
 * Register every tunnel tool against the owning Host scope.
 * @param ctx - scope whose `tools` registry receives the definitions
 * @param server - backend exposing list/find/disconnect/audit: the remote
 *   backend in lib/remote.js (the tunnel server itself runs separately)
 * @param settings - normalized plugin config (sshBinary, scpBinary, ...)
 */
export function registerTools(ctx, server, settings, vnc) {
  const sshBinary = settings.sshBinary || 'ssh.exe'
  const scpBinary = settings.scpBinary || (process.platform === 'win32' ? 'scp.exe' : 'scp')
  const guardOn = guardEnabled()

  // Remote mode answers from a cached snapshot, so refresh first. A local server
  // has no refresh() and its find() is already current.
  //
  // Also guards the account name: an agent started by a SYSTEM scheduled task
  // reports the machine account (`NAME$`), which sshd refuses. Fall back to the
  // configured clientUser, then to Administrator.
  const resolveSession = async (target) => {
    if (typeof server.refresh === 'function') await server.refresh()
    const found = server.find(target)
    if (found.error) return { error: found.error }
    const session = found.session
    // On a remote control side the kit port exists only on the tunnel server;
    // open a local relay for it before ssh is spawned.
    if (typeof server.ensureRelayPort === 'function') {
      const relayed = await server.ensureRelayPort(session)
      if (relayed && relayed.ok === false) {
        return { error: `无法为本机建立 kit「${session.name || session.kitId}」的数据通道：${relayed.error}` }
      }
    }
    const reported = String(session.user || '').trim()
    if (!reported || reported.endsWith('$')) {
      session.user = String(settings.clientUser || '').trim() || 'Administrator'
    }
    // A control side that is not the tunnel server receives an absolute key path
    // that only exists there. Refuse early with the path it looked for instead of
    // letting ssh fail with a bare "Identity file not accessible".
    if (!session.operatorKey) {
      const name = session.name || session.kitId || target
      const kitsDir = String(settings.kitsDir || '').trim()
      const where = kitsDir
        ? `${kitsDir}\\${name}\\operator\\operator_id`
        : '（未配置 kitsDir）'
      return {
        error: `这台机器上没有 kit「${name}」的 operator 私钥，无法通过 ssh 登录它。
  服务器上的路径：${session.operatorKeySource || '(未提供)'}
  本机期望的位置：${where}
把服务器 kits 目录下的「${name}」整个拷到本机，然后在插件配置里把 kitsDir 指向那个目录。`,
      }
    }
    return { session }
  }

  ctx.tools.register({
    name: 'tunnel_list',
    description: 'List connected customer machines on this Host: which kit, its loopback ssh port, live stream count and traffic. Use it before tunnel_exec to learn the target and check whether the local port is free.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: LIST_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    async execute() {
      if (typeof server.refresh === 'function') await server.refresh()
      return server.list()
    },
    presentCall: () => presentCard('List tunnel clients', 'read'),
  })

  ctx.tools.register({
    name: 'tunnel_exec',
    description: 'Run one command on a connected customer machine over the tunnel, returning exit code, stdout and stderr. Destructive commands are refused unless confirm is true.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'kitId or kit name, as shown by tunnel_list.' },
        command: { type: 'string', description: 'Command line to run on the customer machine.' },
        shell: {
          type: 'string',
          enum: ['auto', 'cmd', 'powershell', 'sh', 'bash'],
          description: 'Remote shell. auto picks sh on unix clients and powershell on windows ones, using the OS the client reported at handshake; cmd passes the command straight to the sshd command processor.',
        },
        cwd: { type: 'string', description: 'Working directory applied before the command.' },
        timeoutMs: { type: 'integer', description: 'Wall-clock limit in milliseconds; defaults to 60000.' },
        confirm: { type: 'boolean', description: 'true runs a command that the dangerous-command guard would otherwise refuse.' },
      },
      required: ['target', 'command'],
      additionalProperties: false,
    },
    output: { schema: EXEC_RESULT_SCHEMA, render: renderJson },
    async execute(args) {
      const found = await resolveSession(args.target)
      if (found.error) throw new Error(shortError(found.error))
      const { session } = found

      const command = String(args.command ?? '')
      const requestedShell = String(args.shell ?? 'auto')
      // auto resolves against what the client reported, not against this Host's
      // platform: a Windows hostname can hide a WSL guest running Linux.
      const shell = requestedShell === 'auto'
        ? (session.clientOs === 'unix' ? 'sh' : 'powershell')
        : requestedShell
      const timeoutMs = clampTimeout(args.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS)
      const confirm = args.confirm === true

      const blockedBy = checkCommand(command, { confirm, enabled: guardOn })
      const base = {
        target: String(args.target),
        kitId: session.kitId,
        localPort: session.localPort,
        shell,
        timedOut: false,
        truncated: false,
      }

      if (blockedBy) {
        server.audit({
          event: 'blocked',
          kitId: session.kitId,
          name: session.name,
          reason: blockedBy,
          cmd: command.slice(0, 500),
        })
        return {
          ...base,
          exitCode: -1,
          stdout: '',
          stderr: `已拦截：这条命令命中高危规则「${blockedBy}」，没有执行。确认确实要这么做，请再调用一次并带 confirm=true。`,
          durationMs: 0,
          blocked: true,
          reason: blockedBy,
        }
      }

      const remote = buildRemoteCommand(command, shell, args.cwd)
      const result = await runProcess(sshBinary, [...sshBase(settings, session), remote], { timeoutMs })

      server.audit({
        event: 'exec',
        kitId: session.kitId,
        name: session.name,
        localPort: session.localPort,
        cmd: command.slice(0, 2000),
        shell,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        confirmed: confirm,
      })

      return {
        ...base,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: withKeyHint(result.stderr, session.operatorKey),
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        truncated: result.truncated,
        blocked: false,
        reason: '',
      }
    },
    presentCall: (args) => presentCard(args?.command ? `Run on ${args.target}: ${String(args.command).slice(0, 60)}` : `Run on ${args?.target}`, 'execute'),
  })

  ctx.tools.register({
    name: 'tunnel_upload',
    description: 'Copy one local file to a connected customer machine with scp over the tunnel.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'kitId or kit name.' },
        localPath: { type: 'string', description: 'File on this Host.' },
        remotePath: { type: 'string', description: 'Destination path on the customer machine.' },
        timeoutMs: { type: 'integer', description: 'Wall-clock limit in milliseconds; defaults to 600000.' },
      },
      required: ['target', 'localPath', 'remotePath'],
      additionalProperties: false,
    },
    output: { schema: TRANSFER_RESULT_SCHEMA, render: renderJson },
    async execute(args) {
      const found = await resolveSession(args.target)
      if (found.error) throw new Error(shortError(found.error))
      const { session } = found
      const localPath = String(args.localPath ?? '')
      const remotePath = String(args.remotePath ?? '')
      if (!fs.existsSync(localPath)) throw new Error(shortError(`本地文件不存在：${localPath}`))

      const argv = [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=no',
        '-o', `UserKnownHostsFile=${knownHostsNull()}`,
        '-o', 'LogLevel=ERROR',
        '-P', String(session.localPort),
        '-i', session.operatorKey,
        localPath,
        `${session.user}@127.0.0.1:${remotePath}`,
      ]
      const result = await runProcess(scpBinary, argv, { timeoutMs: clampTimeout(args.timeoutMs, DEFAULT_SCP_TIMEOUT_MS) })
      let bytes = 0
      try { bytes = fs.statSync(localPath).size } catch { /* gone */ }

      server.audit({
        event: 'upload',
        kitId: session.kitId,
        name: session.name,
        localPath,
        remotePath,
        bytes,
        exitCode: result.exitCode,
      })

      return {
        target: String(args.target),
        kitId: session.kitId,
        localPort: session.localPort,
        direction: 'upload',
        localPath,
        remotePath,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: withKeyHint(result.stderr, session.operatorKey),
        durationMs: result.durationMs,
        bytes,
        timedOut: result.timedOut,
      }
    },
    presentCall: (args) => presentCard(`Upload to ${args?.target}`, 'edit'),
  })

  ctx.tools.register({
    name: 'tunnel_download',
    description: 'Copy one file from a connected customer machine to this Host with scp over the tunnel.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'kitId or kit name.' },
        remotePath: { type: 'string', description: 'File on the customer machine.' },
        localPath: { type: 'string', description: 'Destination path on this Host; its directory is created when missing.' },
        timeoutMs: { type: 'integer', description: 'Wall-clock limit in milliseconds; defaults to 600000.' },
      },
      required: ['target', 'remotePath', 'localPath'],
      additionalProperties: false,
    },
    output: { schema: TRANSFER_RESULT_SCHEMA, render: renderJson },
    async execute(args) {
      const found = await resolveSession(args.target)
      if (found.error) throw new Error(shortError(found.error))
      const { session } = found
      const remotePath = String(args.remotePath ?? '')
      const localPath = String(args.localPath ?? '')
      const targetDir = path.dirname(path.resolve(localPath))
      try { fs.mkdirSync(targetDir, { recursive: true }) } catch { /* exists or denied below */ }

      const argv = [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=no',
        '-o', `UserKnownHostsFile=${knownHostsNull()}`,
        '-o', 'LogLevel=ERROR',
        '-P', String(session.localPort),
        '-i', session.operatorKey,
        `${session.user}@127.0.0.1:${remotePath}`,
        localPath,
      ]
      const result = await runProcess(scpBinary, argv, { timeoutMs: clampTimeout(args.timeoutMs, DEFAULT_SCP_TIMEOUT_MS) })
      let bytes = 0
      try { bytes = fs.statSync(localPath).size } catch { /* not downloaded */ }

      server.audit({
        event: 'download',
        kitId: session.kitId,
        name: session.name,
        localPath,
        remotePath,
        bytes,
        exitCode: result.exitCode,
      })

      return {
        target: String(args.target),
        kitId: session.kitId,
        localPort: session.localPort,
        direction: 'download',
        localPath,
        remotePath,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: withKeyHint(result.stderr, session.operatorKey),
        durationMs: result.durationMs,
        bytes,
        timedOut: result.timedOut,
      }
    },
    presentCall: (args) => presentCard(`Download from ${args?.target}`, 'edit'),
  })

  ctx.tools.register({
    name: 'tunnel_disconnect',
    description: 'Drop one connected kit and release its loopback port. The client reconnects on its own unless it was stopped.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'kitId or kit name.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: { schema: DISCONNECT_SCHEMA, render: renderJson },
    async execute(args) {
      const outcome = await server.disconnect(args.target, 'requested')
      if (outcome.error) {
        return { disconnected: false, error: outcome.error }
      }
      return { disconnected: true, ...outcome.disconnected }
    },
    presentCall: (args) => presentCard(`Disconnect ${args?.target}`, 'delete'),
  })

  ctx.tools.register({
    name: 'tunnel_audit',
    description: 'Read the newest tunnel activity records: connects, disconnects, exec, transfers and blocked commands.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many recent records to return; defaults to 20, at most 200.' },
      },
      additionalProperties: false,
    },
    output: { schema: AUDIT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    execute(args) {
      const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 200)
      const auditPath = server.auditPath
      // Remote mode keeps the log on the tunnel server; there is no local file.
      if (!auditPath || /^https?:/i.test(auditPath) || !fs.existsSync(auditPath)) {
        return { path: auditPath, total: 0, returned: 0, items: [] }
      }
      let lines = []
      try {
        lines = fs.readFileSync(auditPath, 'utf8').split(/\r?\n/).filter((line) => line.trim())
      } catch (err) {
        return { path: auditPath, total: 0, returned: 0, items: [], error: err.message }
      }
      const items = []
      for (const line of lines.slice(-limit).reverse()) {
        try {
          items.push(JSON.parse(line))
        } catch {
          items.push({ raw: line.slice(0, 200) })
        }
      }
      return { path: auditPath, total: lines.length, returned: items.length, items }
    },
    presentCall: () => presentCard('Read tunnel audit log', 'read'),
  })

  ctx.tools.register({
    name: 'tunnel_reboot',
    description: 'Restart a connected customer machine. This is the only explicit path past the shutdown guard; the tunnel drops for the reboot and the client reconnects by itself.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'kitId or kit name.' },
        delaySeconds: { type: 'integer', description: 'Countdown before restart; defaults to 5.' },
        timeoutMs: { type: 'integer', description: 'Wall-clock limit in milliseconds; defaults to 30000.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: { schema: EXEC_RESULT_SCHEMA, render: renderJson },
    async execute(args) {
      const found = await resolveSession(args.target)
      if (found.error) throw new Error(shortError(found.error))
      const { session } = found
      const delay = Math.min(Math.max(Number(args.delaySeconds) || 5, 0), 600)
      const command = session.clientOs === 'unix'
        ? `shutdown -r +${Math.max(0, Math.round(delay / 60))}`
        : `shutdown /r /t ${delay} /f`

      const result = await runProcess(
        sshBinary,
        [...sshBase(settings, session), command],
        { timeoutMs: clampTimeout(args.timeoutMs, 30_000) },
      )

      server.audit({
        event: 'reboot',
        kitId: session.kitId,
        name: session.name,
        delay,
        exitCode: result.exitCode,
      })

      return {
        target: String(args.target),
        kitId: session.kitId,
        localPort: session.localPort,
        shell: 'system',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        truncated: result.truncated,
        blocked: false,
        reason: '',
      }
    },
    presentCall: (args) => presentCard(`Restart ${args?.target}`, 'execute'),
  })

  ctx.tools.register({
    name: 'tunnel_vnc',
    description: 'Open or close a VNC forward for a connected machine, so a person (not the tools) can watch and control that desktop in a VNC viewer. Returns a local address such as 127.0.0.1:5901 to connect to. This is separate from the ui-agent channel the tools use.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'kitId or kit name, as shown by tunnel_list.' },
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status', 'password'],
          description: 'start opens the forward, stop closes it, status lists them all, password rewrites the VNC password on that machine.',
        },
        remotePort: { type: 'integer', description: 'VNC port on the customer machine; defaults to 5900.' },
        localPort: { type: 'integer', description: 'Local listener port on this Host; picked automatically when omitted.' },
        password: { type: 'string', description: 'With action=password: new VNC password, at most 8 characters.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    output: { schema: VNC_SCHEMA, render: renderJson },
    async execute(args) {
      if (!vnc) throw new Error('VNC 转发不可用（插件未初始化）')

      const action = String(args.action || 'start')
      if (action === 'status') {
        return { action, forwards: vnc.list() }
      }

      const found = await resolveSession(args.target)
      if (found.error) throw new Error(shortError(found.error))
      const { session } = found

      if (action === 'stop') {
        const result = vnc.stop(session)
        if (result.error) throw new Error(shortError(result.error))
        return { action, target: String(args.target), kitId: session.kitId, localPort: result.localPort, stopped: true }
      }

      if (action === 'password') {
        const result = await vnc.setPassword(session, args.password)
        if (!result.ok) throw new Error(shortError(result.error))
        return {
          action,
          target: String(args.target),
          kitId: session.kitId,
          clientHost: session.clientHost,
          password: result.password,
          changed: true,
          hint: '密码已写入客户机并重启服务；下次「远程查看」会用新密码',
        }
      }

      const result = await vnc.start(session, {
        remotePort: args.remotePort,
        localPort: args.localPort,
        ensureRelay: typeof server.ensureRelayPort === 'function'
          ? (s) => server.ensureRelayPort(s)
          : undefined,
      })
      if (!result.ok) throw new Error(shortError(result.error))

      return {
        action: 'start',
        target: String(args.target),
        kitId: session.kitId,
        clientHost: session.clientHost,
        localPort: result.localPort,
        address: result.address,
        remotePort: result.remotePort,
        reused: Boolean(result.reused),
        serverStarted: Boolean(result.serverStarted),
        hint: `VNC 查看器连 ${result.address}`,
      }
    },
    presentCall: (args) => presentCard(`VNC ${args?.action || 'start'} ${args?.target}`, 'execute'),
  })
}

/**
 * Compose the remote command line for the requested shell and working directory.
 *
 * The string this returns travels through two shell parsers: sshd hands it to the
 * login shell, which then runs whatever we put there. POSIX single-quote escaping
 * survives both because each layer strips one level of the same quoting.
 */
function buildRemoteCommand(command, shell, cwd) {
  const directory = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : ''

  if (shell === 'powershell') {
    const prefix = directory ? `Set-Location -LiteralPath '${directory.replace(/'/g, "''")}';` : ''
    return powershellEncoded(`${prefix}${command}`)
  }

  if (shell === 'cmd') {
    return directory ? `cd /d ${quoteForShell(directory)} && ${command}` : command
  }

  if (shell === 'sh' || shell === 'bash') {
    const inner = directory ? `cd ${shQuote(directory)} && ${command}` : command
    return `${shell} -c ${shQuote(inner)}`
  }

  // Unknown shell: leave it to the remote login shell.
  return directory ? `cd ${shQuote(directory)} && ${command}` : command
}

/** POSIX single-quote escaping: close, escaped quote, reopen. */
function shQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`
}
