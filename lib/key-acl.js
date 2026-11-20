/**
 * Tighten the ACL on operator private keys so OpenSSH will load them.
 *
 * Windows OpenSSH inspects the whole path a key lives on, not just the file. When
 * a kit directory has been copied, unzipped, or restored from anywhere, it arrives
 * carrying inherited ACEs (Users, Everyone, Authenticated Users). ssh then refuses
 * the key in one of two ways, and the two look unrelated:
 *
 *   "Permissions for '...' are too open"        / UNPROTECTED PRIVATE KEY FILE
 *   "拒绝访问。" / Access is denied
 *
 * Same cause. tools.js already appends the icacls hint for the first spelling, but
 * only after a tool call has already failed — and the command the UI hands the user
 * to paste into their own terminal never passes through the plugin at all, so nothing
 * fixes it for them.
 *
 * Keys made by ssh-keygen are already correct, which is why a freshly created kit
 * works and an imported one does not. This runs once at startup over the whole kits
 * directory: cheap, idempotent, and it means the copied command works the first time.
 */
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const KEY_NAME = 'operator_id'

function run(cmd, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** True when the current ACL still contains an entry that ssh would reject. */
async function needsTightening(keyPath) {
  // 继承来的权限是罪魁。用 /get 看有没有 (I) 标记，或者干脆每次都收紧——
  // 收紧是幂等的，多跑一次没有副作用，比解析本地化的 icacls 输出可靠。
  const { code, stdout } = await run('icacls', [keyPath])
  if (code !== 0) return false // 读不到就别动它，交给上层报错
  return /\(I\)/.test(stdout)
}

async function tighten(keyPath, user) {
  // /reset 先清掉所有显式 ACE 并恢复继承，/inheritance:r 再切断继承，
  // 最后只授予属主和 SYSTEM。
  //
  // 只用 /inheritance:r 清不干净：复制工具或手工 icacls 加上去的 Everyone 是显式
  // 权限，不受继承影响，会留下来继续让 ssh 拒绝。
  // Administrators 不在最终列表里是有意的：ssh 只认「属主 + SYSTEM」。
  await run('icacls', [keyPath, '/reset'])
  const result = await run('icacls', [
    keyPath,
    '/inheritance:r',
    '/grant:r', `${user}:(F)`,
    '/grant:r', 'SYSTEM:(F)',
  ])
  return result.code === 0
}

/**
 * Walk each kit under kitsDir, find its operator/operator_id, and tighten it.
 * Returns the number of keys fixed. Never throws.
 */
export async function ensureKitKeyAcls(kitsDir, log = () => {}) {
  if (process.platform !== 'win32') return 0
  if (!kitsDir) return 0

  const user = process.env.USERNAME || os.userInfo().username
  if (!user) return 0

  let kits
  try {
    kits = await readdir(kitsDir, { withFileTypes: true })
  } catch {
    return 0 // 目录还没有，正常
  }

  let fixed = 0
  for (const kit of kits) {
    if (!kit.isDirectory()) continue
    const keyPath = path.join(kitsDir, kit.name, 'operator', KEY_NAME)
    try {
      const info = await stat(keyPath)
      if (!info.isFile()) continue
    } catch {
      continue // 这个 kit 没有 operator key，跳过
    }

    try {
      if (!(await needsTightening(keyPath))) continue
      if (await tighten(keyPath, user)) {
        fixed += 1
      } else {
        log(`key ACL: ${kit.name}/operator/${KEY_NAME} 收紧失败，ssh 可能拒绝加载`)
      }
    } catch (err) {
      log(`key ACL: ${kit.name} 处理失败: ${err?.message || err}`)
    }
  }

  if (fixed > 0) log(`key ACL: 收紧了 ${fixed} 个 operator 私钥的权限`)
  return fixed
}
