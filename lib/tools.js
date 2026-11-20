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
import os from 'node:os'
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

// Drives the UI agent that lives on the client (127.0.0.1:9997, in the user's own
// session). Reaching it from this Host means going through the client's sshd, so
// the request is base64-encoded and decoded on the far side: that avoids every
// quoting problem Chinese text, quotes and backslashes would otherwise cause.
function buildUiScript(request) {
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
  return [
    "$ErrorActionPreference = 'Stop'",
    `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))`,
    'try {',
    '  $tc = New-Object Net.Sockets.TcpClient',
    '  $tc.Connect("127.0.0.1", 9997)',
    '  $st = $tc.GetStream()',
    '  $st.ReadTimeout = 90000',
    '  $wr = New-Object IO.StreamWriter($st)',
    '  $wr.AutoFlush = $true',
    '  $rd = New-Object IO.StreamReader($st)',
    '  $wr.WriteLine($payload)',
    '  $reply = $rd.ReadLine()',
    '  $tc.Close()',
    '  if ($reply) { Write-Output $reply }',
    "  else { Write-Output '{\"ok\":false,\"error\":\"ui agent closed the connection\"}' }",
    '} catch {',
    '  Write-Output (([ordered]@{ ok = $false; error = "ui agent unreachable: $($_.Exception.Message)" }) | ConvertTo-Json -Compress)',
    '}',
  ].join('\r\n')
}

// Same idea for a unix client: its agent listens on the same loopback port and
// speaks the same JSON, so only the wrapper differs. A heredoc keeps the Python
// clear of shell quoting, and the request rides in as base64 too.
function buildUiScriptUnix(request) {
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
  return [
    'python3 - ' + payload + " <<'PYEOF'",
    'import sys, json, socket, base64',
    'req = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))',
    "s = socket.create_connection(('127.0.0.1', 9997), 5)",
    's.settimeout(90)',
    's.sendall((json.dumps(req) + "\\n").encode())',
    'data = b""',
    'while b"\\n" not in data:',
    '    chunk = s.recv(65536)',
    '    if not chunk:',
    '        break',
    '    data += chunk',
    's.close()',
    'sys.stdout.write(data.decode("utf-8", "replace").strip())',
    'PYEOF',
  ].join('\n')
}


// Which flat tool arguments belong to which agent action.
const UI_ACTION_KEYS = {
  ping: [],
  screens: [],
  info: [],
  // The agent's own commands, not desktop actions. status and apps answer from
  // memory without queueing, which is what makes status usable when everything else
  // is stuck. exec runs in the interactive session — the difference that matters for
  // COM, since sshd lands in session 0 and cannot see the user's open applications.
  // stop with restart is how a deployed agent change is picked up.
  status: [],
  apps: [],
  libs: [],
  exec: ['command', 'shell', 'cwd', 'timeoutMs'],
  call: ['app', 'op', 'args'],
  // com binds the instance the user already has open rather than starting a new one,
  // and runs on the agent's dedicated COM worker so it cannot block general work.
  com: ['progid', 'member', 'args'],
  stop: ['restart', 'task'],
  windows: ['filter'],
  rect: ['title', 'hwnd'],
  raise: ['title', 'hwnd'],
  focus: ['title', 'hwnd'],
  move: ['x', 'y', 'screen'],
  click: ['x', 'y', 'screen', 'button', 'count', 'hwnd', 'capture'],
  dblclick: ['x', 'y', 'screen'],
  rightclick: ['x', 'y', 'screen'],
  drag: ['x1', 'y1', 'x2', 'y2', 'screen'],
  wheel: ['delta', 'screen'],
  type: ['text'],
  key: ['keys'],
  paste: ['text', 'hwnd'],
  shot: ['screen', 'path', 'hwnd'],
  find: ['text', 'hwnd'],
  ocrText: ['text', 'hwnd', 'scale', 'screen'],
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
        // spawnfile/cwd identify what actually ran: several scp builds live on
        // this machine, and a bare name resolves differently per process.
        spawnfile: child?.spawnfile || binary,
        spawnargs: args,
        cwd: process.cwd(),
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

// The UI agent answers with whatever the action produced — a window list, a
// screenshot path, OCR lines, coordinates. Enumerating all of that would make
// every new action a schema change, so only the envelope is pinned down here and
// the agent's own fields ride along untouched.
const UI_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string' },
    kitId: { type: 'string' },
    localPort: { type: 'integer' },
    action: { type: 'string' },
    ok: { type: 'boolean' },
    durationMs: { type: 'integer' },
    timedOut: { type: 'boolean' },
    exitCode: { type: 'integer' },
    error: { type: 'string' },
    items: { type: 'array' },
    windows: { type: 'array' },
    screens: { type: 'array' },
    count: { type: 'integer' },
    path: { type: 'string' },
    localPath: { type: 'string' },
    localBytes: { type: 'integer' },
    localError: { type: 'string' },
    hwnd: { type: 'integer' },
    ms: { type: 'integer' },
    scale: { type: 'number' },
    caveat: { type: 'string' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
  },
  required: ['target', 'kitId', 'localPort', 'action', 'ok'],
  additionalProperties: true,
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
    spawnfile: { type: 'string' },
    spawnargs: { type: 'array' },
    cwd: { type: 'string' },
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
    name: 'tunnel_ui',
    description: 'Drive a customer machine through its desktop agent. Desktop: list windows, capture a screenshot (a covered or even minimized window works), click, type, paste, find a control by its label, read text with OCR. Agent itself: status to see what it is doing right now, exec to run a command in the interactive session, apps and call for the application hub, stop to reload it after a deploy. Coordinates are per-screen pixels, or window-relative when hwnd is given.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'kitId or kit name, as shown by tunnel_list.' },
        action: {
          type: 'string',
          enum: ['ping', 'screens', 'info', 'status', 'apps', 'libs', 'exec', 'call', 'com', 'stop',
            'windows', 'rect', 'raise', 'focus', 'move',
            'click', 'dblclick', 'rightclick', 'drag', 'wheel', 'type', 'key',
            'paste', 'shot', 'find', 'ocrText'],
          description: 'status/apps/libs answer from the agent without queueing, so they work when everything else is stuck. exec runs in the interactive session, unlike tunnel_exec which runs over ssh in session 0 — use exec for anything that must see the user\'s open applications. com reaches a running COM server the user already has open. windows/rect locate; raise/focus bring forward; shot captures; click/move/drag/wheel/type/key/paste act; find searches the control tree; ocrText reads pixels when that tree is unavailable.',
        },
        hwnd: { type: 'integer', description: 'Window handle from windows/rect. Makes coordinates window-relative; for shot it selects the window to capture.' },
        title: { type: 'string', description: 'Window title fragment for rect/raise/focus when hwnd is unknown.' },
        filter: { type: 'string', description: 'For action=windows: only titles containing this text.' },
        command: { type: 'string', description: 'For action=exec: the command line to run in the interactive session.' },
        shell: { type: 'string', enum: ['powershell', 'cmd', 'python'], description: 'For action=exec: interpreter. Defaults to powershell.' },
        cwd: { type: 'string', description: 'For action=exec: working directory applied before the command.' },
        app: { type: 'string', description: 'For action=call: application id, as listed by action=apps.' },
        op: { type: 'string', description: 'For action=call: operation name within that application.' },
        progid: { type: 'string', description: 'For action=com: ProgID of a running COM server, such as SldWorks.Application or Excel.Application. Binds the instance the user already has open, not a new one.' },
        member: { type: 'string', description: 'For action=com: the member to read or call. Omit it to only report that binding succeeded.' },
        // Shape differs by action, so no type here: call takes a mapping of operation
        // arguments, com takes positional arguments for the member.
        args: { description: 'For action=call: an object of operation arguments. For action=com: an array of positional arguments for the member.' },
        restart: { type: 'boolean', description: 'For action=stop: start the agent again after stopping. This is how a deployed code change is picked up, because the restarted process reads the files on disk.' },
        task: { type: 'string', description: 'For action=stop: the scheduled task used to restart it; defaults to _session1_agent.' },
        text: { type: 'string', description: 'For type/paste the text to enter; for find/ocrText what to look for.' },
        keys: { type: 'string', description: 'For action=key: SendKeys syntax such as {ENTER} or ^s.' },
        x: { type: 'integer', description: 'Target X for move/click.' },
        y: { type: 'integer', description: 'Target Y for move/click.' },
        x1: { type: 'integer', description: 'Drag start X.' },
        y1: { type: 'integer', description: 'Drag start Y.' },
        x2: { type: 'integer', description: 'Drag end X.' },
        y2: { type: 'integer', description: 'Drag end Y.' },
        screen: { type: 'integer', description: 'Screen index; -1 captures the whole desktop for shot. Defaults to the primary screen.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click.' },
        count: { type: 'integer', description: 'Click count.' },
        capture: { type: 'boolean', description: 'For click: also capture before/after screenshots of hwnd, so one call shows whether the click landed.' },
        delta: { type: 'integer', description: 'Wheel delta; negative scrolls down.' },
        path: { type: 'string', description: 'For action=shot: where to write the PNG on the customer machine. Defaults to %TEMP%.' },
        scale: { type: 'number', description: 'For ocrText: upscale factor before recognition; 2 is a good default.' },
        timeoutMs: { type: 'integer', description: 'Wall-clock limit in milliseconds; defaults to 45000.' },
      },
      required: ['target', 'action'],
      additionalProperties: false,
    },
    output: { schema: UI_RESULT_SCHEMA, render: renderJson },
    async execute(args) {
      const found = await resolveSession(args.target)
      if (found.error) throw new Error(shortError(found.error))
      const { session } = found

      const action = String(args.action || '')
      const allowed = UI_ACTION_KEYS[action]
      if (!allowed) throw new Error(`unknown action: ${action}`)
      // Both platforms have an agent on 127.0.0.1:9997. What each can
      // do differs — the Linux one has no clipboard tool and no OCR —
      // and the agent reports that itself, which beats guessing here.
      const isUnix = session.clientOs === 'unix'

      const request = { action }
      for (const key of allowed) {
        const value = args[key]
        if (value !== undefined && value !== null && value !== '') request[key] = value
      }

      // exec is the one action where the agent enforces its own deadline and answers
      // with timedOut. The transport has to outlive that deadline, otherwise ssh gives
      // up first and the caller gets an empty result instead of the command's outcome.
      const agentTimeout = clampTimeout(args.timeoutMs, action === 'exec' ? 60_000 : 45_000)
      const timeoutMs = action === 'exec' ? clampTimeout(agentTimeout + 15_000, 60_000) : agentTimeout
      const result = await server.execRemote(session, {
        command: isUnix ? buildUiScriptUnix(request) : buildUiScript(request),
        shell: isUnix ? 'bash' : 'powershell',
        timeoutMs,
      })

      // The agent answers with a single JSON line; surface its own fields so the
      // caller sees ok/items/path rather than having to parse stdout.
      const raw = String(result?.stdout ?? '').trim()
      let parsed = null
      try {
        parsed = JSON.parse(raw.split(/\r?\n/).filter(Boolean).pop() || '')
      } catch { parsed = null }

      const base = {
        target: String(args.target),
        kitId: session.kitId,
        localPort: session.localPort,
        action,
        durationMs: result?.durationMs ?? 0,
        timedOut: result?.timedOut ?? false,
      }

      if (!parsed) {
        return {
          ...base,
          ok: false,
          error: '客户机的 UI 代理没有返回可解析的结果',
          stdout: raw.slice(0, 2000),
          stderr: String(result?.stderr ?? '').slice(0, 2000),
          exitCode: result?.exitCode ?? -1,
        }
      }
      // A screenshot is only useful once it is here. Pulling it back inside
      // the same call removes a whole round trip: without this, looking at a
      // screen is shot -> download -> read, three calls for one picture.
      if (action === 'shot' && parsed.ok && parsed.path) {
        try {
          const local = path.join(
            os.tmpdir(),
            `ui-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
          )
          const got = typeof server.downloadRemote === 'function'
            ? await server.downloadRemote(session, String(parsed.path), local)
            : null
          if (!got || got.error) {
            parsed.localPath = ''
            parsed.localError = got?.error || 'download unavailable'
          } else {
            parsed.localPath = local
            try { parsed.localBytes = fs.statSync(local).size } catch { parsed.localBytes = 0 }
          }
        } catch (err) {
          parsed.localPath = ''
          parsed.localError = err?.message || String(err)
        }
      }

      return { ...base, ...parsed, exitCode: result?.exitCode ?? 0 }
    },
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

      // A control side that is not the tunnel server cannot dial the kit's
      // loopback port, so it asks the server to run the command instead. Same
      // guard and same result shape either way.
      if (typeof server.execRemote === 'function') {
        const startedAt = Date.now()
        let result
        try {
          result = await server.execRemote(session, { command, shell, cwd: args.cwd, timeoutMs })
        } catch (err) {
          throw new Error(shortError(`服务器执行失败：${err?.message || err}`))
        }
        server.audit({
          event: 'exec',
          kitId: session.kitId,
          name: session.name,
          localPort: session.localPort,
          cmd: command.slice(0, 2000),
          shell,
          exitCode: result.exitCode,
          durationMs: Date.now() - startedAt,
          confirmed: confirm,
          via: 'server',
        })
        return {
          ...base,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: Date.now() - startedAt,
          timedOut: Boolean(result.timedOut),
          truncated: Boolean(result.truncated),
          blocked: false,
          reason: '',
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

      // Remote control side: the server holds the key and the port, so it copies.
      if (typeof server.uploadRemote === 'function') {
        const startedAt = Date.now()
        const uploaded = await server.uploadRemote(session, localPath, remotePath)
        let bytes = 0
        try { bytes = fs.statSync(localPath).size } catch { /* gone */ }
        server.audit({
          event: 'upload',
          kitId: session.kitId,
          name: session.name,
          localPath,
          remotePath,
          bytes,
          exitCode: uploaded.ok ? 0 : -1,
          via: 'server',
        })
        if (!uploaded.ok) throw new Error(shortError(uploaded.error || '服务器复制失败'))
        return {
          target: String(args.target),
          kitId: session.kitId,
          localPort: session.localPort,
          direction: 'upload',
          localPath,
          remotePath,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: Date.now() - startedAt,
          bytes,
          timedOut: false,
        }
      }

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

      // Remote control side: stream the file from the server instead of scp.
      if (typeof server.downloadRemote === 'function') {
        const startedAt = Date.now()
        const got = await server.downloadRemote(session, remotePath, localPath)
        let bytes = 0
        try { bytes = fs.statSync(localPath).size } catch { /* not downloaded */ }
        server.audit({
          event: 'download',
          kitId: session.kitId,
          name: session.name,
          localPath,
          remotePath,
          bytes,
          exitCode: got.ok ? 0 : -1,
          via: 'server',
        })
        if (!got.ok) throw new Error(shortError(got.error || '服务器读取失败'))
        return {
          target: String(args.target),
          kitId: session.kitId,
          localPort: session.localPort,
          direction: 'download',
          localPath,
          remotePath,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: Date.now() - startedAt,
          bytes,
          timedOut: false,
        }
      }

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
        spawnfile: result.spawnfile,
        spawnargs: result.spawnargs,
        cwd: result.cwd,
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

  // 一个实现，两个名字。
  //
  // 这本来就是通用的 SSH 端口转发：任何 TCP 都能转，叫 tunnel_vnc 只因为第一个
  // 用途是 VNC。RDP 走 3389、Web 管理页走 80/443、数据库走各自的端口，都该用同一个入口，
  // 而不是每加一种协议就再写一个工具。
  const forwardSpec = {
    description: 'Forward one TCP port from a connected machine to this Host so a person, not the tools, can reach it: a VNC viewer on 5900, an RDP client on 3389, a web admin page, any TCP service. Returns a local address such as 127.0.0.1:5902 to connect to. This is separate from the ui-agent channel the tools use.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'kitId or kit name, as shown by tunnel_list.' },
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status', 'password'],
          description: 'start opens the forward, stop closes it, status lists them all. password is VNC-only: it rewrites the password on that machine, which an RDP target does not use.',
        },
        remotePort: { type: 'integer', description: 'Port on the customer machine. VNC is 5900, RDP is 3389; defaults to 5900.' },
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
        hint: `连 ${result.address}（VNC 用查看器，RDP 用 mstsc，Web 用浏览器）`,
      }
    },
    presentCall: (args) => presentCard(`Forward ${args?.action || 'start'} ${args?.target}`, 'execute'),
  }

  ctx.tools.register({ name: 'tunnel_forward', ...forwardSpec })

  // 旧名字留着。已有会话、文档和肌肉记忆都在用 tunnel_vnc，删掉只会换来一串
  // "unknown tool"。描述里点明是别名，让模型知道该优先用新名字。
  ctx.tools.register({
    ...forwardSpec,
    name: 'tunnel_vnc',
    description: 'tunnel_forward 的别名，行为完全相同。'
      + '新代码请用 tunnel_forward——它不限 VNC，RDP 和任意 TCP 端口都能转发。',
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
