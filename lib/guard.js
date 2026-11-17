/**
 * Dangerous command guard.
 *
 * The first 15 rules are the ones dsh_ssh_mcp.py already enforces; the last
 * three cover the extra cases PLUGIN-SPEC 7.6 names (shutdown, account
 * creation, HKLM registry deletion). Only "one command destroys the machine"
 * shapes are blocked, so normal support work is unaffected.
 *
 * Set OPS_GUARD=off in the Host environment to disable, or pass confirm=true
 * on a single tunnel_exec call to run one blocked command deliberately.
 */

export const DANGEROUS = [
  [/\bformat\s+[a-zA-Z]:/i, '格式化磁盘分区'],
  [/\brm\s+-[rf]{1,2}\s+\/(\s|$)/i, '递归删除根目录'],
  // \b does not hold before -Recurse (space and dash are both non-word), use \s
  [/Remove-Item\b[^\n]*\s-Recurse\b[^\n]*\s-Force\b[^\n]*[a-zA-Z]:\\?\s*$/i, '递归强删整个盘'],
  [/\b(rd|rmdir)\s+\/s\s+\/q\s+[a-zA-Z]:\\?\s*$/i, '递归删除整个盘'],
  [/\bdel\b[^\n]*[a-zA-Z]:\\\*/i, '删除整盘文件'],
  [/\bcipher\s+\/w/i, '擦除磁盘空闲空间'],
  [/\bvssadmin\b[^\n]*\bdelete\b[^\n]*\bshadows\b/i, '删除卷影副本'],
  [/\bbcdedit\b[^\n]*\b(delete|cleanup)\b/i, '删除启动项'],
  [/\bdiskpart\b/i, '磁盘分区操作'],
  [/\bInitialize-Disk\b|\bClear-Disk\b/i, '初始化/清空磁盘'],
  [/\bmkfs(\.\w+)?\b/i, '格式化文件系统'],
  [/\bnet\s+user\b[^\n]*\s\/delete\b/i, '删除本地账户'],
  [/\bRemove-Computer\b|\bReset-ComputerMachinePassword\b/i, '退出域/重置计算机账户'],
  [/:\s*\(\s*\)\s*\{.*:\s*\|/, 'fork bomb'],
  [/\bchmod\s+-R\s+0?00\b|\bchattr\s+-i\b/i, '破坏权限/锁定文件'],
  // -- added for PLUGIN-SPEC 7.6 ---------------------------------------------
  [/\bshutdown(\.exe)?\b[^\n]*\/[sr]\b/i, '关机/重启（改用 tunnel_reboot）'],
  [/\bnet\s+user\s+\S+\s+\S+\s+\/add\b/i, '创建本地账户'],
  [/\breg(\.exe)?\s+delete\s+["']?(HKLM|HKEY_LOCAL_MACHINE)/i, '删除 HKLM 注册表项'],
]

export function guardEnabled(env = process.env) {
  const flag = String(env.OPS_GUARD ?? 'on').trim().toLowerCase()
  return !['off', '0', 'false', 'no'].includes(flag)
}

/**
 * Returns the matched rule label, or undefined when the command may run.
 * `confirm` bypasses the guard for a single deliberate command.
 */
export function checkCommand(command, { confirm = false, enabled = true } = {}) {
  if (!enabled || confirm) return undefined
  const text = String(command ?? '')
  for (const [pattern, label] of DANGEROUS) {
    if (pattern.test(text)) return label
  }
  return undefined
}
