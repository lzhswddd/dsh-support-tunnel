/**
 * VNC forward manager — this is for the human operator, not for the AI tools.
 *
 * The customer machine runs a VNC server bound to 127.0.0.1:5900. That port is
 * only reachable through the tunnel, so we open a local listener with `ssh -L`
 * and hand the operator `127.0.0.1:<localPort>`.
 *
 * The server itself is started on demand: one click must be enough, so `start()`
 * first checks whether 5900 is already listening on the customer machine, runs
 * the platform's start command when it is not, waits for the port, and only then
 * opens the forward.
 *
 * Deliberately separate from ui-agent (127.0.0.1:9997): that channel is what
 * the tools drive; this one exists so a person can look and type themselves.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const DEFAULT_REMOTE_PORT = 5900
const FIRST_LOCAL_PORT = 5901
const PORT_WAIT_MS = 15_000

function storePath(custom) {
  if (custom) return custom
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'support-tunnel', 'vnc-forwards.json')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } catch {
    /* a failed bookkeeping write must not break the forward itself */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** ssh flags shared by the forwarding connection and one-shot commands. */
function sshCommon(session) {
  return [
    '-i', session.operatorKey,
    '-p', String(session.localPort),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', `UserKnownHostsFile=${os.devNull}`,
    '-o', `GlobalKnownHostsFile=${os.devNull}`,
    '-o', 'ConnectTimeout=15',
    '-o', 'LogLevel=ERROR',
    `${session.user || 'root'}@127.0.0.1`,
  ]
}

/** Run one command on the customer machine and collect its output. */
function runRemote(sshBinary, session, command, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(sshBinary, ['-n', '-T', ...sshCommon(session), command], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ code: -1, out: '', err: String(err?.message || err) })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({ code: -1, out: out.trim(), err: `timeout after ${timeoutMs}ms` })
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ code: -1, out: out.trim(), err: String(error?.message || error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, out: out.trim(), err: err.trim() })
    })
  })
}

function isWindows(session) {
  return String(session?.clientOs || '').toLowerCase() === 'win'
}

/** Command that prints "up" or "down" for the VNC port. */
function probeCommand(session, port) {
  if (isWindows(session)) {
    // Not Get-NetTCPConnection: that goes through WMI and costs 1.5-2 s per call
    // on a busy machine, which is long enough for the 15 s probe timeout to fire
    // and report a live sshd as unreachable. The .NET listener table answers in
    // a couple of milliseconds.
    return `powershell -NoProfile -NonInteractive -Command "` +
      `try { ` +
      `$L = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners(); ` +
      `if (@($L | Where-Object { $_.Port -eq ${port} }).Count) { 'up' } else { 'down' } ` +
      `} catch { 'down' }"`
  }
  return `sh -c "ss -tln 2>/dev/null | grep -q '[:.]${port} ' && echo up || echo down"`
}

/**
 * Default start command per platform. Windows uses the stick's _vnc.ps1;
 * Linux starts x11vnc against the existing X session.
 */
function defaultStartCommand(session, port, scriptDir) {
  if (isWindows(session)) {
    const script = path.join(scriptDir || 'F:\\FieldSupport\\windows', '_vnc.ps1')
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`
  }
  return `sh -c "command -v x11vnc >/dev/null 2>&1 && ` +
    `(x11vnc -rfbport ${port} -localhost -forever -shared -nopw -bg -o /tmp/x11vnc.log ` +
    `|| nohup x11vnc -rfbport ${port} -localhost -forever -shared -nopw >/tmp/x11vnc.log 2>&1 &) ` +
    `|| echo 'x11vnc not installed'"`
}

export function createVncManager({ sshBinary = 'ssh', storeFile, onLog, startCommand, scriptDir } = {}) {
  const file = storePath(storeFile)
  const passwordFile = path.join(path.dirname(file), 'vnc-passwords.json')
  const log = typeof onLog === 'function' ? onLog : () => {}

  /** sessionKey -> { pid, localPort, remotePort, host, startedAt } */
  let forwards = readJson(file)
  /** sessionKey -> plaintext password last pushed to that machine */
  let passwords = readJson(passwordFile)

  function savePasswords() {
    writeJson(passwordFile, passwords)
  }

  /**
   * Rewrite the VNC password on a customer machine.
   *
   * The stick's _vnc.ps1 derives the TightVNC ciphertext from the plaintext
   * (DES with a bit-reversed fixed key), writes both registry views and
   * restarts the service. We keep the plaintext here so the noVNC URL can
   * carry it without asking the operator anything.
   */
  async function setPassword(session, password) {
    const plain = String(password ?? '')
    if (!plain) return { ok: false, error: '密码不能为空' }
    if (plain.length > 8) return { ok: false, error: 'VNC 密码最多 8 个字符' }
    if (/["`$\\]/.test(plain)) return { ok: false, error: '密码不能包含 " ` $ \\ 这些字符' }

    if (!isWindows(session)) {
      // Linux: vnc.sh 直接接受明文，自己用 x11vnc -storepasswd 生成密码文件
      const script = '/opt/fieldsupport/vnc.sh'
      const command = `bash "${script}" on "${plain}"`
      const result = await runRemote(sshBinary, session, command, 60_000)
      const output = `${result.out || ''}\n${result.err || ''}`
      if (!/VNC_OK/.test(output)) {
        const detail = (output.match(/VNC_FAIL[^\r\n]*/) || output.match(/[^\r\n]{6,}/g) || [])
        return { ok: false, error: String(detail[detail.length - 1] || 'vnc.sh 没有返回就绪').slice(0, 200) }
      }
      passwords[keyOf(session)] = plain
      savePasswords()
      log(`vnc password updated for ${session.clientHost}`)
      return { ok: true, password: plain, output: output.trim() }
    }

    const script = path.join(scriptDir || 'F:\\FieldSupport\\windows', '_vnc.ps1')
    const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" -Password "${plain}"`
    const result = await runRemote(sshBinary, session, command, 60_000)

    // Write-Host goes to stderr over ssh and Chinese comes back mangled, so
    // success is detected from the ASCII marker the script prints on stdout.
    const output = `${result.out || ''}\n${result.err || ''}`
    if (!/VNC_OK/.test(output)) {
      const detail = (output.match(/VNC_FAIL[^\r\n]*/) || ['脚本没有返回就绪'])
      return { ok: false, error: String(detail[0]).slice(0, 200) }
    }

    passwords[keyOf(session)] = plain
    savePasswords()
    log(`vnc password updated for ${session.clientHost}`)
    return { ok: true, password: plain, output: output.trim() }
  }

  /** Password currently in effect for this machine, or null if unknown. */
  function getPassword(session) {
    return passwords[keyOf(session)] || null
  }

  function save() {
    writeJson(file, forwards)
  }

  /** Drop entries whose process is gone (Host restart, manual kill). */
  function prune() {
    let changed = false
    for (const [key, entry] of Object.entries(forwards)) {
      if (!entry || !entry.pid) {
        delete forwards[key]
        changed = true
        continue
      }
      try {
        process.kill(entry.pid, 0)
      } catch {
        delete forwards[key]
        changed = true
      }
    }
    if (changed) save()
  }

  function pickLocalPort(preferred) {
    const used = new Set(Object.values(forwards).map((entry) => entry.localPort))
    if (preferred && !used.has(preferred)) return preferred
    let port = FIRST_LOCAL_PORT
    while (used.has(port)) port += 1
    return port
  }

  function keyOf(session) {
    return session.sessionKey || `${session.kitId}|${session.clientHost || 'unknown'}`
  }

  /**
   * Ask the customer machine whether the VNC port is listening.
   *
   * The answer has three states, and conflating them produces a misleading
   * error: the port is up, the port is down, or the question never arrived
   * because ssh itself failed (dead sshd, wrong account, key missing). Only the
   * third case means "this machine is not reachable at all".
   *
   * @returns {Promise<{up:boolean, answered:boolean, code:number, err:string}>}
   */
  async function probeVnc(session, port) {
    const result = await runRemote(sshBinary, session, probeCommand(session, port), 15_000)
    const text = `${result.out}\n${result.err}`.trim()
    const lowered = text.toLowerCase()
    const saidUp = /\bup\b/.test(lowered)
    const saidDown = /\bdown\b/.test(lowered)
    return { up: saidUp && !saidDown, answered: saidUp || saidDown, code: result.code, err: text }
  }

  /**
   * Turn a failed probe into an error that names the real problem.
   *
   * The server cannot tell why a machine has no reachable sshd: a customer
   * machine whose sshd died looks exactly like a control side that happens to be
   * running the client by mistake. State the fact first, then both readings —
   * telling a control side to "run 启动.cmd again" would be wrong advice.
   */
  function sshFailure(session, probe) {
    const host = session.clientHost || session.kitId || '客户机'
    const line = probe.err.split('\n').map((s) => s.trim()).filter(Boolean)[0]
      || `ssh 退出码 ${probe.code}`
    return `连不上 ${host} 的 SSH：${line}`
      + `（隧道在线但 SSH 无响应。这台是被控端就重跑 启动.cmd；只是控制端则不必理会）`
  }

  /** Make sure a VNC server is listening on the customer machine. */
  async function ensureServer(session, remotePort) {
    let first = await probeVnc(session, remotePort)
    if (!first.answered) {
      // One retry before declaring the machine unreachable. A single ssh attempt
      // can fail for reasons that have nothing to do with the machine — a slow
      // handshake, a transient reset — and reporting "cannot reach SSH" for that
      // sends the operator to restart a perfectly healthy client.
      await sleep(800)
      first = await probeVnc(session, remotePort)
    }
    if (first.up) return { started: false, already: true }
    if (!first.answered) return { started: false, error: sshFailure(session, first) }

    const command = typeof startCommand === 'function'
      ? startCommand(session, remotePort)
      : (startCommand || defaultStartCommand(session, remotePort, scriptDir))

    log(`starting VNC on ${session.clientHost || session.kitId}: ${command.slice(0, 80)}`)
    const launched = await runRemote(sshBinary, session, command, 45_000)
    if (launched.err && /not installed|not found|找不到/i.test(launched.err)) {
      return { started: false, error: launched.err.split('\n')[0] }
    }
    if (launched.code !== 0 && !launched.out.trim() && launched.err.trim()) {
      return { started: false, error: sshFailure(session, { code: launched.code, err: launched.err }) }
    }

    // Poll: the server needs a moment to bind, and _vnc.ps1 already waits a bit.
    const deadline = Date.now() + PORT_WAIT_MS
    let last = { answered: true, err: '' }
    while (Date.now() < deadline) {
      last = await probeVnc(session, remotePort)
      if (last.up) return { started: true }
      if (!last.answered) break
      await sleep(1200)
    }
    if (!last.answered) return { started: false, error: sshFailure(session, last) }
    return {
      started: false,
      error: `等不到 ${remotePort} 监听${launched.err ? `：${launched.err.split('\n')[0]}` : ''}`,
    }
  }

  /**
   * Open (and if needed start) a forward for one client.
   * @returns {Promise<object>}
   */
  async function start(session, options = {}) {
    prune()
    const key = keyOf(session)

    const existing = forwards[key]
    if (existing) {
      return {
        ok: true,
        localPort: existing.localPort,
        address: `127.0.0.1:${existing.localPort}`,
        remotePort: existing.remotePort,
        reused: true,
        serverStarted: false,
      }
    }

    if (!session.localPort) return { ok: false, error: '这台客户端没有被分配隧道端口' }
    if (!session.operatorKey) {
      return {
        ok: false,
        error: `这台机器上没有 kit「${session.name || session.kitId}」的 operator 私钥，无法建立 VNC 转发。
  服务器上的路径：${session.operatorKeySource || '(未提供)'}
把服务器 kits 目录下的该 kit 拷到本机，并在插件配置里设置 kitsDir。`,
      }
    }

    const remotePort = Number(options.remotePort) || Number(session.vncPort) || DEFAULT_REMOTE_PORT

    // On a remote control side the kit port only exists on the tunnel server.
    // Bring the local relay up first so the ssh below can reach it.
    if (typeof options.ensureRelay === 'function') {
      const relayed = await options.ensureRelay(session)
      if (relayed && relayed.ok === false) {
        return { ok: false, error: `无法建立到 kit「${session.name || session.kitId}」的数据通道：${relayed.error}` }
      }
    }

    // One click must be enough: bring the VNC server up before wiring the port.
    const ensured = await ensureServer(session, remotePort)
    if (ensured.error) {
      return { ok: false, error: `VNC 服务端启动失败：${ensured.error}` }
    }

    const localPort = pickLocalPort(Number(options.localPort) || 0)
    const sshArgs = [
      '-N',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', `UserKnownHostsFile=${os.devNull}`,
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-L', `${localPort}:127.0.0.1:${remotePort}`,
      '-p', String(session.localPort),
      '-i', session.operatorKey,
      `${session.user || 'root'}@127.0.0.1`,
    ]

    let child
    try {
      child = spawn(sshBinary, sshArgs, { detached: true, stdio: 'ignore', windowsHide: true })
    } catch (err) {
      return { ok: false, error: `无法启动 ssh：${err?.message || err}` }
    }
    child.unref()

    forwards[key] = {
      pid: child.pid,
      localPort,
      remotePort,
      host: session.clientHost || '',
      kitId: session.kitId || '',
      startedAt: new Date().toISOString(),
    }
    save()
    log(`vnc forward ${session.clientHost || session.kitId}: 127.0.0.1:${localPort} -> ${remotePort}`)

    return {
      ok: true,
      localPort,
      address: `127.0.0.1:${localPort}`,
      remotePort,
      reused: false,
      serverStarted: ensured.started,
    }
  }

  function stop(session) {
    prune()
    const key = keyOf(session)
    const entry = forwards[key]
    if (!entry) return { ok: false, error: '这台客户端没有开启的远程查看' }
    try {
      process.kill(entry.pid)
    } catch {
      /* already gone */
    }
    delete forwards[key]
    save()
    return { ok: true, localPort: entry.localPort }
  }

  function stopAll() {
    for (const entry of Object.values(forwards)) {
      try {
        process.kill(entry.pid)
      } catch {
        /* ignore */
      }
    }
    forwards = {}
    save()
  }

  function list() {
    prune()
    return Object.entries(forwards).map(([key, entry]) => ({
      sessionKey: key,
      ...entry,
      address: `127.0.0.1:${entry.localPort}`,
    }))
  }

  function get(session) {
    prune()
    const entry = forwards[keyOf(session)]
    return entry ? { ...entry, address: `127.0.0.1:${entry.localPort}` } : null
  }

  return { start, stop, stopAll, list, get, setPassword, getPassword, storeFile: file, ensureServer }
}
