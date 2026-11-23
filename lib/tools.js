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
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { checkCommand, guardEnabled } from './guard.js'

const MAX_OUTPUT_BYTES = 120_000
const DEFAULT_EXEC_TIMEOUT_MS = 60_000
const DEFAULT_SCP_TIMEOUT_MS = 600_000
const MAX_TIMEOUT_MS = 30 * 60_000

// ---------------------------------------------------------------- ui tokens
//
// 客户机的桌面 agent 监听 127.0.0.1:9997 且要求 token。loopback 不是安全边界——
// 本机任何进程、任何用户都能连——所以在没有 token 的旧 agent 上，一行
// {"action":"exec",...} 就能以那个 agent 的身份执行命令（Windows 是用户身份，
// Linux 是 root）。
//
// token 由 agent 首次启动时生成，落在固定路径；这里用 ssh 读一次然后缓存。
// 读不到就当旧 agent，不带 token 继续——否则升级顺序稍一错，tunnel_ui 就整个断掉。
const uiTokens = new Map()
const uiTokenAbsent = new Set()

function uiTokenPath(session) {
  return session.clientOs === 'unix'
    ? '/opt/fieldsupport/ui-token.txt'
    : 'C:\\ProgramData\\FieldSupport\\ui-token.txt'
}

async function uiTokenFor(sshBinary, settings, session) {
  const key = session.sessionKey || session.kitId
  if (uiTokens.has(key)) return uiTokens.get(key)
  if (uiTokenAbsent.has(key)) return '' // 已经确认过没有，不必每次再问

  const path = uiTokenPath(session)
  const command = session.clientOs === 'unix'
    ? `cat ${path} 2>/dev/null`
    : `type "${path}" 2>nul`
  try {
    const result = await runProcess(sshBinary, [...sshBase(settings, session), command], { timeoutMs: 10000 })
    const token = String(result.stdout || '').trim()
    if (token && /^[0-9a-f]{16,}$/i.test(token)) {
      uiTokens.set(key, token)
      return token
    }
  } catch {
    // 读不到就当没有，下次（换会话）再试
  }
  uiTokenAbsent.add(key)
  return ''
}


// ---------------------------------------------------------------- ui forward
//
// 每次 tunnel_ui 以前都要：新建一条 ssh（~100ms）+ 在客户机上启动一个 PowerShell
// 去连 9997（~350ms 启动 + 解析脚本），实测一次 3.4 秒。而在客户机上直接测，agent
// 自己只花 2 毫秒（ping 9ms / status 1ms / raise 2ms）。
//
// 所以瓶颈不在 agent，在"每次都重建通道"。这里开一条常驻的
//   ssh -N -L 127.0.0.1:<本地端口>:127.0.0.1:9997 <会话>
// 之后调用方直接连本地端口，一次往返十几毫秒。转发建不起来（sshd 关了 AllowTcpForwarding
// 之类）就退回原来的每次新建 ssh 的路子，功能不受影响。
const uiForwards = new Map() // sessionKey -> { proc, port, ready }

function uiForwardPort(session) {
  // 每个会话一个确定端口：localPort 是 4000N，映射到 2000N，不会和别的会话撞。
  return 20000 + (Number(session.localPort) % 1000)
}

function uiForwardAlive(entry) {
  return Boolean(entry && entry.ready && entry.proc && entry.proc.exitCode === null)
}

function dropUiForward(key, reason = '') {
  const entry = uiForwards.get(key)
  if (!entry) return
  uiForwards.delete(key)
  try { entry.proc?.kill() } catch { /* 已经死了 */ }
  if (reason) {
    audit({ event: 'ui-forward-drop', kitId: key, reason: reason.slice(0, 200) })
  }
}

function waitForPort(port, deadlineMs = 6000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port })
      const done = (ok) => {
        socket.destroy()
        if (ok) return resolve(true)
        if (Date.now() - started > deadlineMs) return resolve(false)
        setTimeout(attempt, 120)
      }
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
    }
    attempt()
  })
}

async function ensureUiForward(sshBinary, settings, session) {
  const key = session.sessionKey || session.kitId
  const port = uiForwardPort(session)
  const existing = uiForwards.get(key)
  if (uiForwardAlive(existing)) return { ok: true, port }

  if (existing) dropUiForward(key, 'stale')

  // sshBase 的最后一个元素是 user@host；-N -L 要插在它前面。
  const base = sshBase(settings, session)
  const destination = base[base.length - 1]
  const argv = [...base.slice(0, -1),
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${port}:127.0.0.1:9997`,
    destination]

  let proc
  try {
    proc = spawn(sshBinary, argv, { stdio: 'ignore', windowsHide: true })
  } catch {
    return { ok: false, port }
  }

  const entry = { proc, port, ready: false }
  uiForwards.set(key, entry)
  // 转发进程自己死掉时把表清掉，下一次调用会重开。
  proc.on('exit', () => {
    if (uiForwards.get(key) === entry) uiForwards.delete(key)
  })

  const ready = await waitForPort(port)
  if (!ready) {
    dropUiForward(key, 'port never opened')
    return { ok: false, port }
  }
  entry.ready = true
  return { ok: true, port }
}

function uiRequest(port, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let buffer = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      socket.destroy()
      fn(value)
    }
    const timer = setTimeout(
      () => finish(reject, new Error(`ui forward 在 ${timeoutMs}ms 内没有回话`)), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index >= 0) {
        clearTimeout(timer)
        finish(resolve, buffer.slice(0, index))
      }
    })
    socket.on('error', (err) => { clearTimeout(timer); finish(reject, err) })
    socket.on('close', () => {
      clearTimeout(timer)
      // agent 回完就关连接是正常的；有半行也算结果，完全没数据才算失败。
      if (buffer.trim()) finish(resolve, buffer.split('\n')[0])
      else finish(reject, new Error('ui forward 关闭了连接却没有回话'))
    })
  })
}


/**
 * 截断输出，并在末尾明说被截断了。
 *
 * 以前只把 truncated:true 塞在返回结构里——那是个布尔字段，模型扫一眼 JSON
 * 很容易忽略，然后基于半截输出下结论（比如以为进程只输出了这么多）。
 * 标记必须出现在文本里，和内容在同一条阅读路径上。
 */
function clipped(text, wasTruncated) {
  const value = String(text ?? '')
  if (!wasTruncated) return value.slice(0, MAX_OUTPUT_BYTES)
  return `${value.slice(0, MAX_OUTPUT_BYTES)}\n`
    + `[...输出被截断，只保留前 ${MAX_OUTPUT_BYTES} 字节。`
    + '要看全量：命令里加过滤条件缩小结果，或重定向到文件再用 tunnel_download 拉回来。]'
}

/**
 * 返回前把值净化成"无损 JSON"。
 *
 * DSH 的输出校验要求返回值能被无损序列化：undefined、NaN、Infinity、-0 里任何
 * 一个出现，整份结果都会被拒掉，报 `value is not lossless JSON`，调用方连一个
 * 字段都拿不到。一个可选字段没探测到就足以毁掉整条结果，而调用方看到的只是
 * 一句和字段毫无关系的错误。
 *
 * 与其在每个工具里逐字段排查，不如在出口统一清一遍：undefined 的键直接丢掉
 * （schema 里本来也不该 required），非有限数变 0，-0 归零。
 */
function sanitizeForOutput(value) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    if (!Number.isFinite(value)) return 0
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(sanitizeForOutput)
  if (type === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = sanitizeForOutput(item)
    }
    return out
  }
  return undefined // 函数 / Symbol / BigInt：丢
}

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
  // batch carries its own sub-actions; the agent runs them on one serial worker so
  // nothing can interleave. continueOnError defaults to false — a click that missed
  // makes the following type land somewhere else.
  batch: ['actions', 'continueOnError'],
  // browser opens a URL; isolated defaults to true (throwaway profile, no cookies).
  // browser_close takes the profileDir it returned and deletes it.
  browser: ['url', 'isolated'],
  browser_close: ['profileDir'],
  windows: ['filter'],
  rect: ['title', 'hwnd'],
  raise: ['title', 'hwnd'],
  focus: ['title', 'hwnd'],
  // hwnd 必须在这里出现。之前 drag/dblclick/rightclick/wheel/move 都没有它，
  // 于是"窗口内相对坐标"根本传不到 agent —— _point 退回绝对坐标，拖拽画到了
  // 屏幕别处，看着像"鼠标动作没生效"。实测在画图上画不出任何东西，就是这一条。
  move: ['x', 'y', 'screen', 'hwnd'],
  click: ['x', 'y', 'screen', 'button', 'count', 'hwnd', 'capture', 'ref', 'observe'],
  dblclick: ['x', 'y', 'screen', 'button', 'count', 'hwnd', 'ref', 'observe'],
  rightclick: ['x', 'y', 'screen', 'button', 'count', 'hwnd', 'ref', 'observe'],
  drag: ['x1', 'y1', 'x2', 'y2', 'screen', 'hwnd'],
  wheel: ['delta', 'screen', 'hwnd'],
  type: ['text', 'ref', 'replace'],
  key: ['keys'],
  paste: ['text', 'hwnd', 'ref'],
  shot: ['screen', 'path', 'hwnd'],
  // One round trip for windows + controls + screenshot. Controls carry refs.
  state: ['hwnd', 'filter', 'text', 'controls', 'limit', 'shot', 'mark'],
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
    // 分开记：stdout 和 stderr 各自独立，提示要能加到正确的那一条上。
    let outTruncated = false
    let errTruncated = false
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
        stdout: clipped(decodeBytes(Buffer.concat(outChunks)), outTruncated),
        stderr: clipped(
          launchError
            ? `${launchError}\n${decodeBytes(Buffer.concat(errChunks))}`
            : decodeBytes(Buffer.concat(errChunks)),
          errTruncated,
        ),
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated: outTruncated || errTruncated,
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
      else outTruncated = true
    })
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes <= MAX_OUTPUT_BYTES) errChunks.push(chunk)
      else errTruncated = true
    })
    child.on('error', (err) => finish(-1, `无法启动 ${binary}：${err.message}`))
    child.on('close', (code) => finish(code))
  })
}

// ---------------------------------------------------------------- background jobs
//
// 有些命令天生要跑很久：robocopy 拷几万个文件、pip install、tar 打包 980 MB。
// 它们以前全部撞上 ssh 通道的超时，返回 "The operation was aborted"，什么都没留下——
// 而命令往往已经跑完了，只是输出还没回来。超时不该等于失败。
//
// 后台任务：立刻返回 jobId，输出直接落临时文件，调用方自己决定什么时候来看。
// 不走 execRemote——那是一条会等结果的 HTTP 请求，没法后台化；后台这条路
// 直接在本机 spawn ssh，目标端口由 resolveSession 已经准备好的 relay 提供。
//
// job 表只在内存里，DSH 重启就丢；但临时文件还在，重建 job 表时读得到内容。

const backgroundJobs = new Map()
let backgroundSeq = 0

function jobTempDir() {
  const dir = path.join(os.tmpdir(), 'support-tunnel-jobs')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* exists */ }
  return dir
}

/** 起一个后台 ssh，stdout/stderr 直接写文件，立刻返回。 */
function startBackgroundJob({ sshBinary, args, meta }) {
  const dir = jobTempDir()
  const jobId = `job-${Date.now().toString(36)}-${(backgroundSeq += 1)}`
  const outFile = path.join(dir, `${jobId}.out`)
  const errFile = path.join(dir, `${jobId}.err`)

  let outFd
  let errFd
  try {
    outFd = fs.openSync(outFile, 'w')
    errFd = fs.openSync(errFile, 'w')
  } catch (err) {
    throw new Error(shortError(`无法创建后台任务的输出文件：${err?.message || err}`))
  }

  let child
  try {
    child = spawn(sshBinary, args, { windowsHide: true, stdio: ['ignore', outFd, errFd] })
  } finally {
    // 子进程拿到 fd 之后父进程就可以关了，否则 fd 泄漏。
    try { fs.closeSync(outFd) } catch { /* already */ }
    try { fs.closeSync(errFd) } catch { /* already */ }
  }

  const job = {
    id: jobId,
    outFile,
    errFile,
    child,
    meta,
    startedAt: Date.now(),
    finishedAt: 0,
    exitCode: null,
    settled: false,
  }
  backgroundJobs.set(jobId, job)

  child.on('close', (code) => {
    job.exitCode = Number.isInteger(code) ? code : -1
    job.settled = true
    job.finishedAt = Date.now()
  })
  child.on('error', (err) => {
    job.exitCode = -1
    job.settled = true
    job.finishedAt = Date.now()
    job.error = `无法启动 ${sshBinary}：${err.message}`
  })

  return job
}

/** 读一个 job 的输出文件尾部。文件可能被同时写入，所以只读最后一段。 */
function readJobOutput(job, tailBytes = MAX_OUTPUT_BYTES) {
  const readTail = (file) => {
    try {
      const size = fs.statSync(file).size
      if (size === 0) return ''
      const start = Math.max(0, size - tailBytes)
      const buf = Buffer.alloc(size - start)
      const fd = fs.openSync(file, 'r')
      try { fs.readSync(fd, buf, 0, buf.length, start) } finally { fs.closeSync(fd) }
      return decodeBytes(buf)
    } catch {
      return ''
    }
  }
  return {
    stdout: readTail(job.outFile),
    stderr: readTail(job.errFile),
    truncated: false,
  }
}

/**
 * 实际用来登录的账户。
 *
 * agent 被 SYSTEM 计划任务拉起时上报的是计算机账户（VISIONFRAME$），而 Windows 不给
 * NAME$ 这类账户交互式登录权，sshd 一律拒绝——哪怕 key 完全正确、端口也通。
 * 这时改用配置里的 clientUser。
 *
 * 只有这一处定义。sshBase、resolveSession、tunnel_list 都从这里取：这个判断以前
 * 抄成了三份，改一处漏两处就是这么来的。
 */
function pickLoginUser(session, settings) {
  const reported = String(session?.user || '').trim()
  if (reported && !reported.endsWith('$')) return reported
  return String(settings.clientUser || '').trim() || 'Administrator'
}

function sshBase(settings, session) {
  // 登录账户走 pickLoginUser，不直接用 session.user——理由见那个函数。
  const user = pickLoginUser(session, settings)
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
    `${user}@127.0.0.1`,
  ]
}

/**
 * 这条命令是不是在驱动 GUI 程序（Office / COM）。
 *
 * tunnel_exec 走 sshd，落在 Windows 的 session 0 —— 那里没有桌面。
 * New-Object -ComObject PowerPoint.Application 能成功，但一旦 Open 文件就报
 * "PowerPoint could not open the file"，看起来像文件损坏，实际只是没有交互式桌面。
 * 现场就因为这个误判过文件坏了，绕了一大圈。
 *
 * 与其给出一个能被解释成"文件问题"的假阴性，不如直接拒绝并指向 tunnel_ui。
 */
const GUI_AUTOMATION = /New-Object\s+-(Com|ComObject)\b|GetActiveObject|\[Type\]::GetTypeFromProgID|Excel\.Application|Word\.Application|PowerPoint\.Application|SldWorks\.Application|Outlook\.Application/i

function looksLikeGuiAutomation(command) {
  return GUI_AUTOMATION.test(String(command ?? ''))
}

/**
 * scp 失败后，把 stderr 里那句没法读的话翻译成能行动的原因。
 *
 * scp 失败时只给一行：
 *   scp.exe: dest open "D:/\351\241\271...": Failure
 * 中文路径被转义成八进制，而且"路径不存在 / 文件被占用 / 权限不足 / 磁盘满"
 * 全都是同一个 Failure。现场只能靠猜。
 *
 * 这里回头 stat 一次目标和它的上级目录，能确定的原因直接说出来。
 * 诊断失败不影响原始错误被抛出——那才是调用方最需要看到的。
 */
async function describeTransferFailure(sshBinary, settings, session, remotePath, stderr, action) {
  const raw = String(stderr || '').trim()
  const head = raw ? `scp ${action}失败：${raw}` : `scp ${action}失败（没有输出）`
  const lines = [head, `目标：${remotePath}`]

  try {
    const dir = remotePath.replace(/[\\/][^\\/]*$/, '')
    if (dir && dir !== remotePath) {
      const dirInfo = await remoteStat(sshBinary, settings, session, dir)
      if (dirInfo && !dirInfo.exists) {
        lines.push(`上级目录不存在：${dir}`)
        lines.push('先在客户机上创建这个目录，或者把文件放到已有的目录里。')
        return lines.join('\n')
      }
    }

    const info = await remoteStat(sshBinary, settings, session, remotePath, { withLock: true })
    if (info && info.exists && info.locked === true) {
      lines.push('目标文件正被占用（Excel / PowerPoint 打开着最常见）。关掉它再传。')
    } else if (info && info.exists) {
      lines.push(`目标已存在，${info.size} 字节。目录在、文件没被占用，那就是权限或磁盘空间的问题。`)
    } else if (info && !info.exists) {
      // 目录在、文件不在，scp 还是失败——多半不是文件本身的问题。
      lines.push('目标不存在、上级目录也在，问题多半在权限或磁盘空间。')
    }
  } catch {
    // 诊断不是主线，别让它掩盖原始错误。
  }

  return lines.join('\n')
}

function shortError(message) {
  return `support-tunnel: ${message}`
}

/**
 * 查一个远端文件的状态，上传前用它判断目标是不是比本地新。
 *
 * 默认覆盖是这个插件里唯一会造成数据丢失的操作：两次上传之间用户对同一个文件的
 * 编辑会被直接抹掉，而 Windows 上 VSS / AutoRecover / 回收站都可能拿不回来
 * （2026-11-21 就这么丢过一次 pptx 的编辑）。
 *
 * 返回 { exists, size, mtimeMs }。查不到（连接失败、命令超时）返回 null，
 * 让调用方按"未知"处理——绝不能当成"不存在"，那等于静默覆盖。
 */
async function remoteStat(sshBinary, settings, session, remotePath, { timeoutMs = 20000, withLock = false } = {}) {
  const isWindows = session.clientOs !== 'unix'
  const raw = String(remotePath)

  let command
  if (isWindows) {
    // 分隔符不能用 '|'：这条命令最终交给远端 cmd.exe，| 在那里是管道符，
    // 会把 '{0}|{1}' 整个拆开，报「'{1}' 不是内部或外部命令」。
    const escaped = raw.replace(/'/g, "''")
    // 锁定探测：以 ReadWrite + None 共享模式打开，成功说明没别人占着。
    // 只在调用方要的时候才加——它会在文件被占用时抛异常，比单纯 stat 慢一点。
    const lockProbe = withLock
      ? "; $l='?'; try { $fs=[IO.File]::Open($p,'Open','ReadWrite','None'); $fs.Close(); $l='0' } catch { $l='1' }"
      : "; $l='?'"
    const script = `$p='${escaped}'; if (Test-Path -LiteralPath $p) { `
      + '$i=Get-Item -LiteralPath $p'
      + lockProbe
      + "; Write-Output ('{0},{1},{2}' -f $i.Length, [int64]($i.LastWriteTimeUtc - [datetime]'1970-01-01').TotalMilliseconds, $l) "
      + "} else { Write-Output 'MISSING' }"
    command = `powershell -NoProfile -Command "${script}"`
  } else {
    // Linux 没有等价的独占探测（任何一个 fd 都能读），所以那边不返回 locked 字段。
    command = `stat -c '%s,%Y' '${raw.replace(/'/g, "'\\''")}' 2>/dev/null || echo MISSING`
  }

  const result = await runProcess(sshBinary, [...sshBase(settings, session), command], { timeoutMs })
  const text = String(result.stdout || '').trim()
  // 文件不存在 / 查不出来时都不带 locked 字段：调用方看到没这个字段就知道没探测过。
  if (!text) return null
  if (text.includes('MISSING')) return { exists: false, size: 0, mtimeMs: 0 }

  const [sizeRaw, mtimeRaw, lockRaw] = text.split(',')
  const size = Number(sizeRaw)
  if (!Number.isFinite(size)) return null
  let mtimeMs = Number(mtimeRaw)
  if (!isWindows) mtimeMs *= 1000 // stat %Y 是秒
  const info = { exists: true, size, mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0 }
  // 布尔，不是字符串。调用方写的是 if (r.locked)，而 "no" 在 JS 里是 truthy——
  // 用字符串枚举会让每一个文件都看起来被锁住。探测不到就不给这个字段。
  if (lockRaw === '0') info.locked = false
  else if (lockRaw === '1') info.locked = true
  return info
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
  loginUser: {
    type: 'string',
    description: '实际用来登录的账户。和 user 不同时，说明客户端上报的是机器账户（NAME$），ssh 会改用它。',
  },
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
    accepted: {
      type: 'boolean',
      description: '这个退出码是否落在调用方给的 accept_exit_codes 里。true 表示虽然 exitCode 不是 0，但属于该工具的正常返回。',
    },
    jobId: { type: 'string', description: 'background:true 时返回，用 tunnel_job_output / tunnel_job_kill 操作它。' },
    background: { type: 'boolean', description: 'true 表示这条命令在后台跑，exitCode 0 只代表启动成功，不代表执行结果。' },
  },
  required: ['target', 'kitId', 'localPort', 'shell', 'exitCode', 'stdout', 'stderr', 'durationMs', 'timedOut', 'truncated', 'blocked', 'reason'],
}

const JOB_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    jobId: { type: 'string' },
    target: { type: 'string' },
    command: { type: 'string' },
    running: { type: 'boolean', description: '还在跑就是 true；false 时 exitCode 才有意义。' },
    exitCode: { type: 'integer', description: '任务没结束时是 -1。' },
    stdout: { type: 'string', description: '到目前为止的输出尾部。' },
    stderr: { type: 'string' },
    durationMs: { type: 'integer' },
    error: { type: 'string', description: '进程都没启动起来时的原因。' },
  },
  required: ['jobId', 'running', 'exitCode', 'stdout', 'stderr', 'durationMs'],
}

const JOB_KILL_SCHEMA = {
  type: 'object',
  properties: {
    jobId: { type: 'string' },
    killed: { type: 'boolean', description: 'true 表示这次调用确实把它停了；false 表示它本来就结束了。' },
    exitCode: { type: 'integer' },
  },
  required: ['jobId', 'killed'],
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

const STAT_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string' },
    kitId: { type: 'string' },
    path: { type: 'string' },
    exists: { type: 'boolean' },
    size: { type: 'integer' },
    mtime: { type: 'string', description: 'ISO 时间；文件不存在时为空串。' },
    mtimeMs: { type: 'integer' },
    locked: {
      type: 'boolean',
      description: '是否被别的进程占着（无法以独占方式打开）。只在真的探测过时才出现——非 Windows 机器上这个字段不存在，不要把"缺省"当成 false。',
    },
  },
  required: ['target', 'kitId', 'path', 'exists', 'size'],
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

  /**
   * 记一条审计：本地一份，服务端一份。
   *
   * remote 模式下 server.audit 只是把记录发给服务端，本机什么都不留，
   * 于是 tunnel_audit 永远返回空——现场的原话是"本次所有排障只能靠猜"。
   * 审计的价值就在事后，事后查不到等于没有。
   *
   * 写本地时吞掉所有异常：日志写不进去不该让业务操作失败。
   */
  const localAuditFile = path.join(os.tmpdir(), 'support-tunnel-audit.jsonl')
  function audit(entry) {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
      fs.appendFileSync(localAuditFile, `${line}\n`, 'utf8')
      // 简单封顶：超过 4 MB 就只留后一半，免得无限长。
      const size = fs.statSync(localAuditFile).size
      if (size > 4 * 1024 * 1024) {
        const lines = fs.readFileSync(localAuditFile, 'utf8').split('\n').filter(Boolean)
        fs.writeFileSync(localAuditFile, `${lines.slice(-2000).join('\n')}\n`, 'utf8')
      }
    } catch { /* 写日志失败不影响主流程 */ }
    try { server.audit?.(entry) } catch { /* 服务端那份丢了也不影响 */ }
  }
  // tunnel_audit 读这个文件，不受 remote 模式影响。
  const auditFile = server.auditPath && !/^https?:/i.test(server.auditPath)
    ? server.auditPath
    : localAuditFile
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
    // 账户判断统一走 pickLoginUser：上报的是机器账户（NAME$）时换成 clientUser。
    session.user = pickLoginUser(session, settings)
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
      const status = server.list()
      // 服务端给的 user 和 sshCommand 用的是客户端上报的原始账户，可能是
      // VISIONFRAME$ 这种登不进去的机器账户。真正登录用的是 pickLoginUser
      // 算出来的那个。不把它标出来，人会照着 sshCommand 抄一条注定失败的命令，
      // 然后以为隧道坏了——以为功能有问题，其实只是显示得不对。
      const clients = (status.clients || []).map((client) => {
        const loginUser = pickLoginUser(client, settings)
        let sshCommand = client.sshCommand
        if (sshCommand) {
          // 形如 `ssh -p N -i "KEY" USER@127.0.0.1`。按结尾的 loopback 地址替换，
          // 而不是去 replace client.user——客户端没上报账户时那里是空的，
          // 用字面值去匹配会静默不替换，留下一条 `@127.0.0.1` 这种跑不通的命令。
          sshCommand = sshCommand.replace(/\S*@127\.0\.0\.1\s*$/, `${loginUser}@127.0.0.1`)
        }
        return { ...client, loginUser, sshCommand }
      })
      return { ...status, clients }
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
            'paste', 'shot', 'find', 'ocrText',
            'batch', 'browser', 'browser_close', 'state'],
          description: 'status/apps/libs answer from the agent without queueing, so they work when everything else is stuck. exec runs in the interactive session, unlike tunnel_exec which runs over ssh in session 0 — use exec for anything that must see the user\'s open applications. com reaches a running COM server the user already has open. windows/rect locate; raise/focus bring forward; shot captures; click/move/drag/wheel/type/key/paste act; find searches the control tree; ocrText reads pixels when that tree is unavailable. batch runs a list of actions as one uninterrupted sequence (one round trip instead of one per step, and nothing can interleave). browser opens a URL in an isolated throwaway profile by default; browser_close kills it and deletes that profile.',
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
        actions: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          description: 'For action=batch: the steps to run in order, each shaped like a normal tunnel_ui call ({action, ...}) but without target. At most 20. Runs on one worker so nothing interleaves — a click-then-type sequence lands in the same window it started in.',
        },
        continueOnError: {
          type: 'boolean',
          description: 'For action=batch: keep going after a failed step. Default false, because a click that missed makes the following type land somewhere else.',
        },
        url: { type: 'string', description: 'For action=browser: the URL to open.' },        isolated: {
          type: 'boolean',
          description: 'For action=browser: open in a throwaway profile with no cookies or history. Default true. Set false only when the page must use the user\'s existing login session.',
        },
        profileDir: { type: 'string', description: 'For action=browser_close: the profileDir that action=browser returned. Only paths under the agent\'s own browser root are accepted.' },
        ref: {
          type: 'string',
          description: 'For click/type/paste: the ref string that find or state returned for a control. The agent re-reads that element\'s rectangle at action time, so this keeps working after the window moves — a coordinate read from an earlier reply does not. An expired ref reports so instead of clicking somewhere stale.',
        },
        observe: {
          type: 'boolean',
          description: 'For action=click: add a `changed` boolean saying whether the window looked different afterwards. Default on; costs one extra capture.',
        },
        replace: {
          type: 'boolean',
          description: 'For action=type with a ref: allow the UIA value pattern to replace the field contents. Without it, UIA set-value is used only when the field is already empty — overwriting text the user had typed is worse than a slower keystroke path.',
        },
        controls: {
          type: 'boolean',
          description: 'For action=state: include the active window\'s controls with refs. Default true.',
        },
        mark: {
          type: 'boolean',
          description: 'For action=state: mark every interactive control on the screenshot with a numbered red box, and return each control with that number. Point at a number instead of estimating pixels — measured, eyeballed coordinates were off by 40px while the UIA rectangle was exact. Implies controls: true.',
        },
        limit: {
          type: 'integer',
          description: 'For action=state: how many controls to return, 1-100. Default 30. All descendants of a browser window can run to five figures, which is why the default is the direct children only unless you pass text.',
        },
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

      // 计时从现在开始。execRemote 不返回 durationMs，以前直接 `?? 0` 落了个 0，
      // 于是"这一步为什么慢"变成了没法回答的问题——数字必须先可信。
      const startedAt = Date.now()
      const tokenStart = Date.now()

      // agent 要求 token 时带上。没有这一层，客户机上任何本地进程连 9997 都能执行
      // 任意命令；读不到就说明那台跑的是不带认证的旧 agent，也就不带。
      const token = await uiTokenFor(sshBinary, settings, session)
      if (token) request.token = token
      const tokenMs = Date.now() - tokenStart

      // exec is the one action where the agent enforces its own deadline and answers
      // with timedOut. The transport has to outlive that deadline, otherwise ssh gives
      // up first and the caller gets an empty result instead of the command's outcome.
      const agentTimeout = clampTimeout(args.timeoutMs, action === 'exec' ? 60_000 : 45_000)
      const timeoutMs = action === 'exec' ? clampTimeout(agentTimeout + 15_000, 60_000) : agentTimeout

      // 优先走常驻转发：省掉 ssh 握手和 PowerShell 启动，实测 3.4 秒 → 十几毫秒。
      // 转发不可用就退回每次新建 ssh 的老路，功能一样，只是慢。
      const execStart = Date.now()
      let remoteStdout = ''
      let remoteExit = 0
      let remoteTimedOut = false
      let viaForward = false
      try {
        const forward = await ensureUiForward(sshBinary, settings, session)
        if (forward.ok) {
          remoteStdout = await uiRequest(forward.port, request, timeoutMs)
          viaForward = true
        }
      } catch (err) {
        // 走到这里说明转发本身有问题；记录一次，退回 ssh 路径。
        audit({ event: 'ui-forward-fallback', kitId: session.kitId,
          reason: String(err?.message || err).slice(0, 200) })
      }

      let result = null
      if (!viaForward) {
        result = await server.execRemote(session, {
          command: isUnix ? buildUiScriptUnix(request) : buildUiScript(request),
          shell: isUnix ? 'bash' : 'powershell',
          timeoutMs,
        })
        remoteStdout = String(result?.stdout ?? '')
        remoteExit = result?.exitCode ?? 0
        remoteTimedOut = result?.timedOut ?? false
      }
      const execMs = Date.now() - execStart

      // The agent answers with a single JSON line; surface its own fields so the
      // caller sees ok/items/path rather than having to parse stdout.
      const raw = String(remoteStdout ?? '').trim()
      let parsed = null
      try {
        parsed = JSON.parse(raw.split(/\r?\n/).filter(Boolean).pop() || '')
      } catch { parsed = null }

      const base = {
        target: String(args.target),
        kitId: session.kitId,
        localPort: session.localPort,
        action,
        durationMs: Date.now() - startedAt,
        timedOut: remoteTimedOut,
        // 分项计时：token 是第一次读文件（之后走缓存），exec 是 ssh + 客户机上真正
        // 干活的时间。两者加起来对不上 durationMs 就说明还有别的开销。
        timing: { tokenMs, execMs },
      }

      if (!parsed) {
        return {
          ...base,
          ok: false,
          error: '客户机的 UI 代理没有返回可解析的结果',
          stdout: raw.slice(0, 2000),
          stderr: '',
          exitCode: remoteExit ?? -1,
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

      return { ...base, ...parsed, exitCode: remoteExit ?? 0 }
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
        accept_exit_codes: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Exit codes to treat as success. robocopy returns 1 when it copied files, and many diff tools return 1 for "differences found" — both are normal, not failures. The result then carries accepted:true.',
        },
        confirm: { type: 'boolean', description: 'true runs a command that the dangerous-command guard would otherwise refuse.' },
        background: {
          type: 'boolean',
          description: 'Run detached and return a jobId immediately instead of waiting for the result. Use for anything that takes minutes — robocopy over many files, pip install, tar on a large tree. A foreground call that times out does NOT mean the command failed; in background mode you poll with tunnel_job_output and get the real exit code.',
        },
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

      // robocopy 复制成功返回 1，diff 类工具发现差异返回 1——把它们当成失败会
      // 让调用方误判，然后去"修"一个其实已经成功的结果。
      const acceptCodes = new Set(
        (Array.isArray(args.accept_exit_codes) ? args.accept_exit_codes : [])
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n)),
      )
      const isAccepted = (code) => acceptCodes.has(Number(code))

      // cmd 下含非 ASCII 的命令不可靠，直接拒绝。
      //
      // 实测：`chcp & echo test-utf8-中文` 里代码页确实显示 65001，但中文仍然是乱码。
      // 原因是命令按 UTF-8 字节经 ssh 送到 sshd，而 cmd 解析同一行里的参数时用的还是
      // 旧的 936 代码页——chcp 只改之后新启动的命令，改不了已经切好的参数。
      // 输出侧 chcp 是有用的（dir 的中文名能正常出来），坏的是输入。
      //
      // 与其让人对着乱码猜"是不是路径写错了"，不如在进入之前说清楚。
      if (shell === 'cmd' && /[^\x00-\x7F]/.test(command)) {
        throw new Error(shortError(
          '这条命令含中文（或其它非 ASCII 字符），cmd 下必然乱码：代码页是 936，'
          + '而命令按 UTF-8 字节传进去，chcp 只能改之后的命令、改不了同一行的参数。\n'
          + '改用 shell: "powershell"（不指定 shell 时 Windows 默认就是它）；'
          + '纯 ASCII 的 cmd 命令不受影响。'))
      }

      const blockedBy = checkCommand(command, { confirm, enabled: guardOn })

      // session 0 没有桌面，GUI 自动化在这里只会给出假阴性。还没到 guard，
      // 因为这不是"危险"，是"这条通道根本做不到"。
      if (session.clientOs !== 'unix' && looksLikeGuiAutomation(command)) {
        throw new Error(shortError(
          '这条命令在驱动 Office / COM 这类需要桌面的程序，但 tunnel_exec 跑在 session 0'
          + '（没有交互式桌面）：COM 对象能创建，打开文件却会报「文件损坏」——那是假阴性。\n'
          + '改用 tunnel_ui { action: "exec", 同一段命令 }，它在用户的会话里执行；\n'
          + '或者用 hub 里的应用：tunnel_ui { action: "call", app: "excel" | "solidworks", op: ... }。'))
      }
      const base = {
        target: String(args.target),
        kitId: session.kitId,
        localPort: session.localPort,
        shell,
        timedOut: false,
        truncated: false,
      }

      if (blockedBy) {
        audit({
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

      // 后台模式：本机 spawn 一个 ssh 就撒手，输出直接落文件。
      // 走 execRemote 不行——那是一条等结果的 HTTP 请求，没法后台化。
      if (args.background === true) {
        const remote = buildRemoteCommand(command, shell, args.cwd)
        const job = startBackgroundJob({
          sshBinary,
          args: [...sshBase(settings, session), remote],
          meta: {
            target: String(args.target),
            kitId: session.kitId,
            localPort: session.localPort,
            command: command.slice(0, 2000),
            shell,
          },
        })
        audit({
          event: 'exec-background',
          kitId: session.kitId,
          name: session.name,
          jobId: job.id,
          cmd: command.slice(0, 2000),
          shell,
          confirmed: confirm,
        })
        return {
          ...base,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 0,
          timedOut: false,
          truncated: false,
          blocked: false,
          reason: '',
          accepted: false,
          jobId: job.id,
          background: true,
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
        audit({
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
          accepted: isAccepted(result.exitCode),
        }
      }

      const remote = buildRemoteCommand(command, shell, args.cwd)
      const result = await runProcess(sshBinary, [...sshBase(settings, session), remote], { timeoutMs })

      audit({
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
        accepted: isAccepted(result.exitCode),
      }
    },
    presentCall: (args) => presentCard(args?.command ? `Run on ${args.target}: ${String(args.command).slice(0, 60)}` : `Run on ${args?.target}`, 'execute'),
  })

  ctx.tools.register({
    name: 'tunnel_job_output',
    description: 'Read a background command started with tunnel_exec { background: true }: output so far, whether it is still running, and its exit code once it finishes. Poll this instead of waiting inside tunnel_exec — a foreground timeout does not mean the command failed.',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The jobId that tunnel_exec returned.' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    output: { schema: JOB_RESULT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args) {
      const job = backgroundJobs.get(String(args.jobId ?? ''))
      if (!job) {
        throw new Error(shortError(
          `没有这个后台任务：${args.jobId}。任务表在 DSH 重启后会清空；`
          + `如果它已经跑完，输出文件还在 ${jobTempDir()} 下（<jobId>.out / .err）。`))
      }
      const { stdout, stderr } = readJobOutput(job)
      return {
        jobId: job.id,
        target: job.meta?.target || '',
        command: job.meta?.command || '',
        running: !job.settled,
        exitCode: job.exitCode === null ? -1 : job.exitCode,
        stdout,
        stderr,
        durationMs: (job.finishedAt || Date.now()) - job.startedAt,
        error: job.error || '',
      }
    },
    presentCall: (args) => presentCard(`Job ${args?.jobId || ''}`, 'read'),
  })

  ctx.tools.register({
    name: 'tunnel_job_kill',
    description: 'Stop a background command started with tunnel_exec { background: true }. Kills the local ssh process, which also drops the command running on the customer machine.',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The jobId that tunnel_exec returned.' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    output: { schema: JOB_KILL_SCHEMA, render: renderJson },
    async execute(args) {
      const job = backgroundJobs.get(String(args.jobId ?? ''))
      if (!job) {
        throw new Error(shortError(`没有这个后台任务：${args.jobId}`))
      }
      const wasRunning = !job.settled
      if (wasRunning) {
        try { job.child.kill('SIGKILL') } catch { /* already gone */ }
      }
      return {
        jobId: job.id,
        killed: wasRunning,
        exitCode: job.exitCode === null ? -1 : job.exitCode,
      }
    },
    presentCall: (args) => presentCard(`Kill job ${args?.jobId || ''}`, 'execute'),
  })

  ctx.tools.register({
    name: 'tunnel_upload',
    description: 'Copy one local file to a connected customer machine with scp over the tunnel. Refuses to overwrite a file that changed on the remote side more recently than the local copy — pass overwrite:true to force it.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'kitId or kit name.' },
        localPath: { type: 'string', description: 'File on this Host.' },
        remotePath: { type: 'string', description: 'Destination path on the customer machine.' },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite even when the remote file is newer than the local one. Default false: a newer remote file means someone edited it after your local copy was made, and overwriting silently destroys that work.',
        },
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

      // 覆盖检查。默认拒绝，因为上传是这个插件里唯一会不可逆地毁掉别人工作的操作：
      // 用户在两次上传之间编辑了目标文件，直接盖上去就没了，Windows 上往往无法恢复。
      // 只有远端比本地新才算冲突——远端更旧或不存在都照常覆盖。
      if (args.overwrite !== true) {
        const remote = await remoteStat(sshBinary, settings, session, remotePath)
        if (remote === null) {
          throw new Error(shortError(
            `无法确认 ${remotePath} 的远端状态（stat 没有返回可解析的结果），为避免误覆盖已中止。`
            + '确认目标可以覆盖后重试并带 overwrite:true。'))
        }
        if (remote.exists) {
          let localMtime = 0
          try { localMtime = fs.statSync(localPath).mtimeMs } catch { /* 刚 existsSync 过 */ }
          if (remote.mtimeMs > localMtime) {
            throw new Error(shortError(
              `目标 ${remotePath} 在远端更新（${new Date(remote.mtimeMs).toISOString()}，`
              + `${remote.size} 字节），比本地这份（${new Date(localMtime).toISOString()}）新。`
              + '直接覆盖会抹掉那次改动。确认要覆盖请带 overwrite:true；'
              + '想保留远端版本就换个 remotePath。'))
          }
        }
      }

      // Remote control side: the server holds the key and the port, so it copies.
      if (typeof server.uploadRemote === 'function') {
        const startedAt = Date.now()
        const uploaded = await server.uploadRemote(session, localPath, remotePath)
        let bytes = 0
        try { bytes = fs.statSync(localPath).size } catch { /* gone */ }
        audit({
          event: 'upload',
          kitId: session.kitId,
          name: session.name,
          localPath,
          remotePath,
          bytes,
          exitCode: uploaded.ok ? 0 : -1,
          via: 'server',
        })
        // 走服务端这条分支时，错误是服务端那句 scp 原文——中文路径是八进制转义，
        // 而且"父目录不存在 / 被占用 / 权限不足"全说成 Failure。和本机 scp 分支
        // 一样回头 stat 一次再抛，否则现场只能看到一个读不懂的 Failure。
        if (!uploaded.ok) {
          throw new Error(shortError(await describeTransferFailure(
            sshBinary, settings, session, remotePath, uploaded.error || '', '上传')))
        }
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

      audit({
        event: 'upload',
        kitId: session.kitId,
        name: session.name,
        localPath,
        remotePath,
        bytes,
        exitCode: result.exitCode,
      })

      // 这条分支以前直接 return，所以 scp 失败也当成功返回，只留一句读不懂的
      // "dest open ... Failure" 在 stderr 里。
      if (result.exitCode !== 0) {
        throw new Error(shortError(await describeTransferFailure(
          sshBinary, settings, session, remotePath, result.stderr, '上传')))
      }

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
        audit({
          event: 'download',
          kitId: session.kitId,
          name: session.name,
          localPath,
          remotePath,
          bytes,
          exitCode: got.ok ? 0 : -1,
          via: 'server',
        })
        if (!got.ok) {
          throw new Error(shortError(await describeTransferFailure(
            sshBinary, settings, session, remotePath, got.error || '', '下载')))
        }
        // 0 字节可能是个真的空文件，也可能是流在途中断了却仍然返回成功
        // （2026-11-21 实测到过一次：exitCode 0 / bytes 0 / 无 stderr，重试就正常）。
        // 只在 0 字节时才去问远端，正常下载不付这次往返的代价。
        if (bytes === 0) {
          const remote = await remoteStat(sshBinary, settings, session, remotePath)
          if (remote && remote.size > 0) {
            throw new Error(shortError(
              `远端 ${remotePath} 有 ${remote.size} 字节，但只拉到 0 字节——传输中途失败了。`
              + '重试一次；反复失败就改用 tunnel_ui action=exec 分段读取。'))
          }
        }
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

      audit({
        event: 'download',
        kitId: session.kitId,
        name: session.name,
        localPath,
        remotePath,
        bytes,
        exitCode: result.exitCode,
      })

      // scp 的退出码非 0 就是失败，这里以前直接 return 了——调用方拿到的是
      // "exitCode 0 / bytes 0 / stderr 空"，和真正下载成功看起来一样。
      if (result.exitCode !== 0) {
        throw new Error(shortError(await describeTransferFailure(
          sshBinary, settings, session, remotePath, result.stderr, '下载')))
      }
      if (bytes === 0) {
        const remote = await remoteStat(sshBinary, settings, session, remotePath)
        if (remote && remote.size > 0) {
          throw new Error(shortError(
            `远端 ${remotePath} 有 ${remote.size} 字节，但只拉到 0 字节——传输中途失败了。`
            + '重试一次；反复失败就改用 tunnel_ui action=exec 分段读取。'))
        }
      }

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
    name: 'tunnel_stat',
    description: 'Stat one file on a customer machine: existence, size, modification time, and (on Windows) whether another process holds it locked. Use this instead of running Get-Item through tunnel_exec — it is one round trip and returns structured fields.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'kitId or kit name.' },
        path: { type: 'string', description: 'File path on the customer machine.' },
      },
      required: ['target', 'path'],
      additionalProperties: false,
    },
    output: { schema: STAT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args) {
      const found = await resolveSession(args.target)
      if (found.error) throw new Error(shortError(found.error))
      const { session } = found
      const remotePath = String(args.path ?? '')
      if (!remotePath) throw new Error(shortError('path 不能为空'))

      const info = await remoteStat(sshBinary, settings, session, remotePath, { withLock: true })
      if (info === null) {
        throw new Error(shortError(
          `查不到 ${remotePath} 的状态：命令没有返回可解析的结果（ssh 不通，或远端没有 powershell/stat）。`))
      }
      // locked 只在真的探测过时才写进去。
      //
      // 显式写 `locked: info.locked` 在没探测时会变成 `locked: undefined`，而带
      // undefined 的对象不是"无损 JSON"——DSH 的输出校验在序列化之前就把它拒了，
      // 表现为整个工具返回 "value is not lossless JSON"，连字段都拿不到。
      const result = {
        target: String(args.target),
        kitId: session.kitId,
        path: remotePath,
        exists: info.exists,
        size: info.size,
        mtime: info.exists && info.mtimeMs ? new Date(info.mtimeMs).toISOString() : '',
        mtimeMs: info.mtimeMs,
      }
      if (info.locked !== undefined) result.locked = info.locked
      // 出口净化：任何 undefined / NaN / -0 都会让整份结果被 DSH 拒掉。
      return sanitizeForOutput(result)
    },
    presentCall: (args) => presentCard(`Stat on ${args?.target}`, 'read'),
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
      // 读本地那份。remote 模式以前直接用 server.auditPath，那是个 https URL，
      // 于是每次都返回空——等于没有审计。
      const auditPath = auditFile
      if (!auditPath || !fs.existsSync(auditPath)) {
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

      audit({
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
    // 先把输出编码钉成 UTF-8，并关掉进度流。
    //
    // 编码：Windows PowerShell 的 stdout 默认走 OEM 代码页（中文机器上是 936/GBK），
    // Node 这边按 UTF-8 解码，中文全成乱码——现场因此养成"中文必须 base64 一遍"的
    // 习惯。在脚本最前面设一次，比让每个调用方自己处理省事，而且只影响本进程。
    //
    // 进度流：ssh 把 stderr 重定向走之后，PowerShell 会把 Progress 记录序列化成
    // CLIXML（"#< CLIXML\n<Objs ...><AV>正在准备首次使用模块。</AV>"）混进 stderr。
    // 那不是错误，却会被当成错误读，而且足以淹没真正的报错。SilentlyContinue 关掉。
    const preamble = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;'
      + '$ProgressPreference="SilentlyContinue";'
    const prefix = directory
      ? `${preamble}Set-Location -LiteralPath '${directory.replace(/'/g, "''")}';`
      : preamble
    return powershellEncoded(`${prefix}${command}`)
  }

  if (shell === 'cmd') {
    // cmd 同理：65001 是 UTF-8 代码页。>nul 是为了别把 "Active code page" 那行
    // 混进 stdout 里，那会让调用方以为命令自己输出了奇怪的东西。
    const encoding = 'chcp 65001 >nul & '
    const inner = directory ? `cd /d ${quoteForShell(directory)} && ${command}` : command
    return `${encoding}${inner}`
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
