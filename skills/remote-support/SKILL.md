---
name: remote-support
description: 通过 TLS 隧道远程操作客户机（Windows/Linux）：执行命令、传文件、键鼠控制、重启。Use when the user asks to 远程支持/连客户机/看现场那台机器/在客户机上跑命令或截图, when tunnel_list or tunnel_exec must be used, or when a customer machine is reached through the support stick (U 盘, kits\_stick, ticket k5a1dad4e). Covers target resolution (kit name / machine hostname / kitId), the U-stick client layout, the desktop-agent JSON protocol on 127.0.0.1:9997, the VNC picture channel (UltraVNC, lock screen, why TightVNC cannot), the Linux agent, and the standard failure checklist.
whenToUse: 需要远程操作客户现场机器时——查在线客户端、跑命令、上传下载文件、点鼠标键盘、重启客户机、排查“连上了但进不去”这类通道问题。
---

# 远程支持通道（support-tunnel）

一套"操作端 DSH 插件 + 客户机 U 盘"的反向隧道：客户机主动连出到 `lzhswddd.top:24443`（TLS，
指纹固定），插件给每个客户端在本机分配一个 `40001+` 端口，再用 SSH 落到客户机的 sshd 上。
客户机侧只有 U 盘 + 两个计划任务，拔盘即干净。

## 先做什么

```
tunnel_list                      # 永远先看这个：谁在线、端口、kitId、机器名、账户
```

返回的 `clients[]` 里四个字段最有用：`kitId` / `name`(kit 名) / `clientHost`(机器名) / `user`(登录账户)。
`user` 是客户端自己上报的，`tunnel_exec` 就用它登录 —— 所以不用手工填账户。

## 目标怎么写（target 参数）

按优先级匹配，不区分大小写，子串匹配到多台会报错要求更精确：

| 写法 | 例子 | 说明 |
|---|---|---|
| **机器名** | `tunnel_exec {target:"VISION"}` | 最自然，推荐 |
| kit 名 | `U盘` | 一个 U 盘一套 kit，多台机器共挂 |
| kitId | `k5a1dad4e` | 最精确 |
| 输出里的端口 | —— | 只用于看列表，不要拿来当 target |

## 工具

```powershell
tunnel_list                                                    # 在线列表 + 服务端状态
tunnel_exec  {target, shell:'powershell'|'sh'|'bash'|'cmd', command, cwd?, timeoutMs?}
tunnel_upload   {target, localPath, remotePath}
tunnel_download {target, remotePath, localPath}
tunnel_reboot   {target, delaySeconds?}                        # 唯一能越过关机守卫的路径
tunnel_disconnect {target}
```

要点：

- `shell` 省略时按客户端上报的 OS 自动选（`win` → powershell，`unix` → sh）
- `command` 走 `powershell -EncodedCommand`，**多行脚本、中文、引号都安全**
- 单次 `tunnel_exec` 约 200 ms（180 ms 是 SSH 握手）；20 条命令批量跑也只有 200 ms 左右的开销
- `tunnel_download` 大文件要确认写入完成：截图 PNG 3 MB 时抢占会拿到半截（有 magic 没有 IEND）

## 客户机 U 盘长什么样

```
F:\FieldSupport\windows\
├── _start.ps1          8 步启动（清理→host key→sshd→agent→ui-agent→state）
├── _clean.ps1          6 步清理，拔盘前跑
├── _diag.ps1           11 项诊断，-Fix 可自修，-Json 给 GUI 用
├── _gui.ps1            现场界面（v1.3）
├── _session1.ps1       拉起 session1-agent（Interactive 计划任务）
├── _kit.ps1            选 kit：kits\<机器名> → kits\_stick → kits\default
├── update-agent.ps1    远程热更新（stage/apply/rollback）
├── _rescue.ps1         失联自愈（agent 没了就重拉）
├── support-agent.exe   PyInstaller 单文件，纯 TCP 中继
├── sshd\               便携 OpenSSH
├── kits\_stick\        这套凭证：support.json / authorized_keys / me.pub
└── _runtime\           运行时生成：host key / sshd_config / support.json / *.log
```

**U 盘目录必须是纯 ASCII**（`F:\FieldSupport\...`）：`sshd.exe` 走 ANSI API，中文路径会让它读不到 host key。

启动方式：双击 `启动.cmd`（自提权）。GUI 是 `启动-GUI.cmd`。

## 桌面 agent（127.0.0.1:9997）

Windows 和 Linux 都用 9997。它只监听本机，**必须借 sshd 跳进去**：在 `tunnel_exec`
里定义一个小函数再用。

```powershell
function Ui([string]$j){
  $tc=New-Object Net.Sockets.TcpClient; $tc.Connect('127.0.0.1',9997)
  $st=$tc.GetStream(); $st.ReadTimeout=30000
  $wr=New-Object IO.StreamWriter($st); $wr.AutoFlush=$true
  $rd=New-Object IO.StreamReader($st)
  $wr.WriteLine($j); $r=$rd.ReadLine(); $tc.Close(); return $r
}
Ui '{"action":"status"}'                      # 队列深度、活跃任务、线程名 —— 卡住时先问这个
Ui '{"action":"exec","command":"nvidia-smi"}' # 命令执行，带进程组杀
Ui '{"action":"apps"}'                        # hub 里注册的应用
Ui '{"action":"call","app":"sysinfo","op":"gpu"}'
Ui '{"action":"screens"}'
Ui '{"action":"windows","filter":"现场支持"}'
Ui '{"action":"click","x":928,"y":712,"screen":0}'
Ui '{"action":"shot","screen":0,"path":"F:\\_shots\\a.png"}'
```

**卡住先查 `status`**，别猜。它返回 `generalQueue` / `serialQueue` / `active[]`（含
`action`、`kind`、`thread`、`elapsedMs`）。如果某个 `exec` 挂了几百秒还在 `active` 里，
问题在命令本身而不是 agent。

Windows 的动作集比 Linux 多 `com`（COM 调用）和 `paste`；Linux 没有 COM，`paste` /
`ocrText` 会明确报缺工具而不是返回空结果。

**坐标**是物理像素；点击前用 `rect` 拿窗口位置，按 `客户区原点 + 逻辑坐标 × 缩放` 换算。
但**不要靠截图验证界面**——见坑 AI。

## 远程画面（VNC）

**用 UltraVNC，不是 TightVNC。** 实测同一台机器、同一时刻、同一套抓帧代码：

| | TightVNC 服务模式 | UltraVNC 服务模式 |
|---|---|---|
| 锁屏画面 | **全黑** | **登录界面 + 壁纸** |
| 输密码解锁 | 无从验证 | 成功 |

TightVNC 的钩子绑在 attach 时的 `Default` 桌面，锁屏切 `Winlogon` 它留在原处。
UltraVNC 会重挂。

### U 盘 / 本地两种部署

```powershell
.\_vnc.ps1              # 复制到 C:\ProgramData\FieldSupport\ultravnc（拔盘不死）
.\_vnc.ps1 -Portable    # 服务直接指向 U 盘（拔盘即失效）
.\_vnc.ps1 -Status
.\_vnc.ps1 -Stop
```

### 三个必须知道的点

**1. 端口 up ≠ 有画面。** hook 注入要**约 40 秒**，期间返回的帧**尺寸完全正确、内容全黑**
（2560x1600，约 11 KB）。**抓帧小于 50 KB 就当黑屏**，别怀疑客户端。

**2. 密码只能用 `setpasswd.exe`。** 手写 `[ultravnc] passwd=` 和写注册表**都不认**，服务会
一直报 "no valid password"。它写的是 `[UltraVNC] passwd=<9 字节>`（段名大写）。

**3. 服务在跑就别重建。** `_vnc.ps1` 分三条路，只有 `cold` 才付 40 秒：

```
服务在跑 + 端口开   → reused=1      1 秒
密码真的变了       → restarted=1    重启 + 40 秒
服务不存在         → cold           完整安装 + 40 秒
```

就绪标记在 `C:\ProgramData\FieldSupport\vnc-ready.json`，15 分钟内有效。GUI 勾选
「允许远程画面」时后台准备，所以真正连的时候不用等。

**成功判据是 stdout 上的 `VNC_OK`**（ASCII），不是中文输出——`Write-Host` 走 ssh 回来编码会乱。

### 拿画面自己看

不要装 VNC 客户端。跑一个最小 RFB 客户端就够：

```python
# 关键：RFB 是大端。用 BitConverter 按小端读会把 2560 读成 25
width, height = struct.unpack('>HH', head[0:4])
# 认证：密码前 8 字节当 DES key，每字节 bit 反转；pyDes 是最省事的实现
# SetPixelFormat 消息 20 字节；FramebufferUpdateRequest 后按矩形拼图
```

`D:\ai\.tmp\vnc-grab.py` 是一份能跑的（认证 / 大端解析 / Raw 编码 / PNG 输出）。

## Linux 侧

### agent 架构（和 Windows 对齐）

```
acceptor（只路由）
  ├── inline   status / ping / apps / stop     立刻回，不排队
  ├── general  4 worker   exec / shot / windows / find
  └── serial   1 worker   键鼠（xdotool 共用一条 X 连接）
```

**环境自探测**：systemd 起来没有 `DISPLAY`，sshd 会话也没有。`ensure_ui_env()` 读
`/proc/<pid>/environ` 自己找，所以不需要从桌面终端启动。日志里能看到
`ui env from Xwayland(pid=...): DISPLAY=:0`。

### 四个 unit

```
fieldsupport.service             隧道
fieldsupport-ui.service          agent 9997（Restart=always）
fieldsupport-ui-keeper.service   oneshot
fieldsupport-ui-keeper.timer     每分钟 OnCalendar=*:0/1
```

`Restart=always` 管崩溃（kill -9 后 2 秒回来）；keeper 管 `stop`/`disable`/符号链接丢失。
**没有** Windows `_fs_rescue` 那种更新兜底——Linux 暂无远程更新机制。

### Wayland 下没有远程画面

```
grdctl vnc     认证通过，返回 800x600、3 种颜色的空虚拟桌面（不是用户的屏幕）
x11vnc         X Error BadMatch (X_GetImage) —— Xwayland 不提供根窗口像素
```

**不是配置问题。** 要看真实屏幕（含锁屏）只能切 X11：

```bash
sudo sed -i 's/^#\?WaylandEnable=.*/WaylandEnable=false/' /etc/gdm3/custom.conf
sudo systemctl restart gdm3
```

Linux 的主路径是 **agent 的 exec / 文件 / 截图**。`shot` 走 `grim`，VNC 关着也能截，
但锁屏时同样不行。

### 判断 Wayland 不要读环境变量

sshd 会话里 `XDG_SESSION_TYPE` 是空的。用进程表：有 `Xorg` 就是 X11，有 `Xwayland` 就是
Wayland。

## 常见故障对照表

| 现象 | 根因 | 处理 |
|---|---|---|
| `clients` 为空 | agent 没起 / U 盘拔了 / 网络出不去 | 到机器上双击 `启动.cmd`；`_runtime\` 里看日志 |
| `unknown_kit` (404) | 服务端 `kitsDir` 里没有这个 kitId | 确认服务端 `kits\` 有对应目录 |
| `auth failed` (401) | token 不匹配 | U 盘 `kits\_stick\support.json` 与服务端 kit 对齐 |
| 隧道在线但 SSH `Permission denied` | ① 用错账户名 ② `_runtime\authorized_keys` 缺失/内容不对 | 先 `whoami` 确认账户；补写 authorized_keys（sshd 每次连接重读） |
| `Connection closed by remote host` | 账户存在但登录被拒（内置 Administrator 常被禁用） | 换实际登录账户 |
| GUI「键鼠 ○ 未启用」 | `_ss_ui_*` 任务 Ready 而进程已退 | `Start-ScheduledTask` 那个任务即可，不必重启整套 |
| GUI 卡、点不动 | 定时器里跑了 WMI（`Get-NetTCPConnection` 单次可 700 ms） | 用 `IPGlobalProperties::GetActiveTcpListeners()` |
| GUI 有多个窗口叠在一起 | 没有单实例保护 | 同一时间只跑一个；`_gui.ps1` 顶部已有判断 |
| 界面报「凭证 X」 | `_diag.ps1` 不认 `kits\_stick` | 更新 `_diag.ps1` |
| VNC 连上但画面全黑（约 11 KB） | hook 还没注入完，约需 40 秒 | 等；或看 _vnc.ps1 -Status 是否 reused |
| VNC 报 no valid password | 密码不是 setpasswd.exe 写的 | 用 setpasswd.exe <pw>，别手写 ini/注册表 |
| _vnc.ps1 卡住不返回 | 在拆一个正跑着的服务（StopPending） | 服务在跑就直接复用，别重建 |
| Linux 9997 连不上 | agent 没起 / 服务被 disable | systemctl is-active fieldsupport-ui，keeper 一分钟内会拉回来 |
| Linux 改了东西没生效 | 服务没重启 | sudo systemctl restart fieldsupport-ui，改 py 必须重启 |
| Linux 看不到桌面 | Wayland | 无解；要画面只能切 X11 |
| 重启后连不回来 | 这台机器没装开机自启（自启是每台机器 `C:\ProgramData` 里的事） | 现场跑一次 `启动.cmd`，或先 `开启开机自启.cmd` 再重启 |

## 远程更新客户端（不需要人碰机器）

```
1. tunnel_upload 新文件 → F:\FieldSupport\windows\_update-in\
2. tunnel_exec 跑 update-agent.ps1 -Mode stage         # 不断线，先验哈希
3. 注册一次性 SYSTEM 任务跑 apply（不能在 tunnel_exec 里直接跑，会杀掉自己）
4. 等 10-20 秒 → tunnel_list 看 accepted 是否 +1
5. 读 _runtime\update.state.json：ok=true 且 rolledBack=false 才算成功
```

`apply` 会在停 agent 前自动 arm 一个 `_fs_rescue` 任务（+3 分钟）；agent 起来后自己 disarm，
起不来就留着兜底 —— 所以"改坏了"最多失联三分钟。

## 安全边界

- 凭证只在 U 盘里（`kits\_stick\support.json` 的 kitId + token）。**盘就是钥匙**，盘丢就换 kit。
- 服务端只认 `kitsDir` 里登记过的 kitId + token；新增 kit 目录会在下次连接时自动生效（每次握手前 `refresh()`）。
- 客户机侧不存任何 API key：agent 只是 TCP 中继，AI 推理全在操作端。
- `清理.cmd` 后系统应无残留：`%TEMP%\_ss_*`、`C:\ProgramData\SSH`、`C:\Program Files\OpenSSH` 都应为空。

## 详细资料

项目目录 `D:\ai\bmc-control\remote-support\`：

- `HANDOFF.md` —— 架构、实测时间线、坑清单 A–AI（**遇到怪现象先搜这里**）
- `STATUS.md` —— 更短的现状
- `TUNNEL-PROTOCOL.md` —— 帧格式与握手细节
- `support-tunnel/lib/{server,tools,guard,ports}.js` —— 服务端实现
