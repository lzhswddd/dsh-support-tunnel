---
name: remote-support
description: 通过 TLS 隧道远程操作客户机（Windows/Linux）：执行命令、传文件、桌面控制、远程画面、重启。Use when the user asks to 远程支持/连客户机/看现场那台机器/在客户机上跑命令或截图/改客户机上的文件, when tunnel_list or tunnel_ui or tunnel_exec must be used, or when a machine is reached through the support stick (U 盘, kits\_stick). 覆盖 target 解析、九个工具的分工、桌面 agent 的 26 个动作、UltraVNC 远程画面、Linux 侧 systemd 部署和故障对照表。
whenToUse: 需要远程操作客户现场机器时——查在线客户端、跑命令、上传下载文件、点鼠标键盘、看屏幕、重启客户机、排查"连上了但进不去"这类通道问题。
---

# 远程支持通道（support-tunnel）

操作端一个 DSH 插件，客户机一个 U 盘。客户机主动连出到 `lzhswddd.top:24443`（TLS，指纹固定），
插件给每个客户端在本机分配一个 `40001+` 端口，再用 SSH 落到客户机的 sshd 上。

**两条独立通道，别混：**

```
SSH（4000N → 客户机 sshd）      tunnel_exec / upload / download / reboot
     ↓ 跑在 session 0，看不到用户的桌面
桌面 agent（127.0.0.1:9997）    tunnel_ui
     ↓ 跑在交互式会话，能碰窗口和 COM
```

## 先做什么

```
tunnel_list        # 永远先看：谁在线、端口、kitId、机器名、账户
```

`clients[]` 里四个字段最有用：`kitId` / `name`(kit 名) / `clientHost`(机器名) / `user`(登录账户)。
`user` 是客户端自己上报的，`tunnel_exec` 就用它登录——不用手工填账户。

`sshUp: false` 的机器隧道在线但 ssh 不通，只能走 `tunnel_ui`，或者先查 sshd。

## target 怎么写

按优先级匹配，不区分大小写；子串匹配到多台会报错要求更精确：

| 写法 | 例子 | 说明 |
|---|---|---|
| **机器名** | `target: "VISION"` | 最自然，推荐 |
| kit 名 | `target: "U盘"` | 一个 U 盘一套 kit，多台共挂 |
| kitId | `target: "k5a1dad4e"` | 最精确 |

## 九个工具

| 工具 | 用途 |
|---|---|
| `tunnel_list` | 在线列表和端口 |
| **`tunnel_ui`** | **桌面 19 个动作 + agent 7 个命令，见下** |
| `tunnel_exec` | 在客户机跑命令（走 ssh，session 0） |
| `tunnel_upload` / `tunnel_download` | 传文件 |
| `tunnel_audit` | 读最近的连接/exec/传输/被拦命令记录，`limit` 默认 20 最多 200 |
| `tunnel_vnc` | 开/关远程画面转发，`action: start\|stop\|status\|password` |
| `tunnel_reboot` | 重启客户机，唯一能越过关机守卫的路径 |
| `tunnel_disconnect` | 断开一台 kit 并释放端口 |

`tunnel_download` 拉大文件要确认写完：截图 PNG 3 MB 时抢断会拿到半截（有 magic 没有 IEND）。

## tunnel_ui —— 桌面 agent 的唯一入口

**不要为了调 agent 去开 socket。** `tunnel_ui` 就是那个通道，参数是结构化的：

```
tunnel_ui { target: 'VISION', action: 'status' }
tunnel_ui { target: 'VISION', action: 'windows', filter: '现场支持' }
tunnel_ui { target: 'VISION', action: 'click', x: 928, y: 712, screen: 0 }
tunnel_ui { target: 'VISION', action: 'shot', screen: 0 }
```

### agent 自己的命令（不排队，卡住时也能答）

| action | 参数 | 作用 |
|---|---|---|
| `status` | — | 队列深度、worker 数、完成/失败数、**每个在飞任务的耗时** |
| `apps` | — | hub 里注册的应用及其操作 |
| `libs` | — | agent 能用的 Python 包 |
| `exec` | `command` `shell` `cwd` `timeoutMs` | **在交互式会话里**跑命令 |
| `call` | `app` `op` `args` | 调 hub 应用的操作 |
| `com` | `progid` `member` `args` | 绑用户**已经打开**的 COM 实例 |
| `stop` | `restart` `task` | 停止；`restart: true` 用磁盘上的新代码重启 |

**卡住先问 `status`，别猜。** 如果某个 `exec` 在 `active[]` 里挂了几百秒，问题在命令本身，
不在 agent。Windows 上它还报 `comQueue` / `comWorkerAlive`，Linux 上是 `serialQueue`。

**`exec` 和 `tunnel_exec` 不是一回事。** sshd 在 session 0，看不到用户开着的窗口和 COM 对象；
agent 在交互式会话。**凡是要碰"用户已经打开的软件"，用 `tunnel_ui action=exec` 或 `action=com`。**

### 桌面动作

| 类别 | action |
|---|---|
| 探测 | `ping` `screens` `info` |
| 窗口 | `windows`(filter) `rect` `raise` `focus`(title 或 hwnd) |
| 鼠标 | `move` `click` `dblclick` `rightclick` `drag` `wheel` |
| 键盘 | `type`(text) `key`(SendKeys 语法) `paste`(text) |
| 取画面 | `shot` `find` `ocrText` |

两个省事的细节：

- **`shot` 会把 PNG 自动拉回本地**，返回里带 `localPath`，不用再 `tunnel_download` 一趟
- **`click` 支持 `capture: true`**，前后各截一张，一次调用就能看出点中了没有

`shot` 连被挡住甚至最小化的窗口都能截（被控端用 PrintWindow，不是截屏幕）。

### 坐标

物理像素。`screen: 0` 主屏、`1` 第二块、以此类推，每块屏从自己左上角算。
给了 `hwnd` 就是**窗口客户区相对坐标**，这种情况下不用操心屏幕偏移。

**但不要靠截图验证界面**——见故障表最后一行。

### hub 里的应用

```
excel        6 个操作：open sheets read write close quit          serial
solidworks   8 个操作：version open info export rebuild configs activate close   serial
```

两个都标了 `serial`（COM 单线程套间），走 agent 的专用 COM worker，不会堵住普通任务。
新增应用只要往 `apps\` 丢一个 `.py`（`NAME` / `DESCRIPTION` / `SERIAL` / `OPERATIONS`），
不用改 agent，也不用重启（按 mtime 热加载）。

## Windows 和 Linux 的差异

同一个 `tunnel_ui`，两边能力不一样。**先看 target 是哪种系统，再决定用哪个动作。**

| | Windows | Linux |
|---|---|---|
| agent | `session1-agent.py`（pythonw） | `ui-agent.py`（python3） |
| 怎么跑 | 计划任务 `_session1_agent`，Interactive | systemd `fieldsupport-ui.service`，root |
| **为什么需要 agent** | **跨 Session 0 隔离**：sshd 在 0，桌面在 1+ | **补环境变量**：有权限但没 `DISPLAY` |
| `com` | ✅ 绑用户已打开的实例 | ❌ 没有 COM |
| `libs` | ✅ | ✅ |
| `paste` | ✅ | ✅ 装 wl-clipboard 后可用，Wayland 走 wl-copy |
| `ocrText` | ✅ | ⚠️ 要 tesseract，且**截图那一步在 GNOME Wayland 下拿不到画面** |
| `stop` / `restart:true` | ✅ 计划任务 | ✅ hold 标记，见下 |
| 截图 | PrintWindow：**被挡住、最小化都能截**，可只截某个窗口 | grim/scrot 截屏幕，窗口被挡就截到挡它的东西 |
| 自启 | 5 个计划任务 | 4 个 systemd unit |
| 守护 | `_fs_keeper` 每分钟 + `_fs_rescue` 更新兜底 | `Restart=always` + keeper timer，**没有 rescue** |
| 远程画面 | UltraVNC，**锁屏可见可解锁** | **RDP**（gnome-remote-desktop，Wayland 下可用）；VNC 不行 |
| 部署路径 | `<盘>:\FieldSupport\windows\` 或 `<盘>:\windows\` | `/opt/fieldsupport/` |
| 安装 | 双击 `启动.cmd` | `sudo bash install.sh --systemd` |
| hub 应用 | `excel`(6) `solidworks`(8) | 空（通了但没注册） |

### 三个最容易踩的

**1. Linux 上「停」和「重启」靠一个 hold 标记区分。** unit 是 `Restart=always`，keeper 又在每分钟守，
单纯退出等于重启：

```
stop restart:true   清掉标记再退出 → systemd 立刻拉起，载入磁盘上的新代码
stop                先写 /run/fieldsupport-hold 再停 → keeper 看到标记就不动手
```

标记在 `/run`（tmpfs），**重启机器就清掉**，机器回到被守护状态。手工开回来时记得一并删：

```bash
sudo rm -f /run/fieldsupport-hold && sudo systemctl start fieldsupport-ui
```

没有这个标记时，`systemctl stop` 会被 keeper 在一分钟内撤销——实测过一次，日志里
`restarted fieldsupport-ui.service` 就是它干的。

**2. Linux 没有 `com`，别绕。** 想调某个软件的功能，Linux 侧只能靠它的命令行工具（如 `sw.py`）
或 `exec` 调外部命令；"绑定用户已经打开的那个实例"这条路在 Linux 上不存在。

**3. 截图语义不同，别用同一套判据。** Windows 给 `hwnd` 能只截一个窗口，被遮挡也无所谓；
Linux 是整屏截，窗口被挡住就截到挡住它的东西——先 `raise` 或 `focus`。

**锁屏画面两边都不要用 `shot` 去取**：Windows 那条路是 VNC（`tunnel_vnc` + 抓帧），Linux 没有这条路。

### 同一件事的两边写法

```
看 agent 状态   Windows: tunnel_ui action=status          Linux: 同
跑命令          Windows: tunnel_ui action=exec            Linux: 同
看装了什么包    Windows: tunnel_ui action=libs            Linux: 同
重载 agent      Windows: tunnel_ui action=stop restart    Linux: 同
调 SolidWorks   Windows: tunnel_ui call {app:'solidworks'} Linux: 没有
取屏幕          Windows: tunnel_ui shot                   Linux: tunnel_ui shot（窗口先 raise）
```

## 客户机 U 盘

```
<盘>:\FieldSupport\windows\        顶层 26 个文件 + 5 个目录
├── _start.ps1              8 步启动：清理→host key→sshd→隧道→桌面 agent→就绪
├── _clean.ps1              清理。默认彻底清；-ProcessesOnly 只停进程、留任务和 _runtime
├── _diag.ps1               10 项诊断，-Fix 自修，-Json 给 GUI 用
├── _gui.ps1                现场界面，无控制台窗口
├── _install-boot.ps1       注册/卸载开机自启三件套
├── _keeper.ps1             每分钟守护（_fs_keeper 调用）
├── _ui-ensure.ps1          解包嵌入式 Python 并拉起桌面 agent
├── _vnc.ps1                远程画面：默认复制到 ProgramData，-Portable 指向 U 盘
├── _rescue.ps1             失联自愈
├── _kit.ps1                选 kit：kits\<机器名> → kits\_stick → kits\default
├── update-agent.ps1        远程热更新（stage / apply / rollback）
├── _launch.vbs             无控制台启动 GUI
├── app.ico / _make-icon.py GUI 图标及其生成脚本
├── session1-agent.py       桌面 agent（26 个动作）
├── hub.py                  hub 加载器
├── sw.py                   SolidWorks 命令行工具
├── fs-mcp.py               MCP 适配器（把 agent 暴露成 MCP 工具）
├── agent-embed.zip         嵌入式 Python 3.12 + pywin32/comtypes/pillow/openpyxl
├── support-agent.exe       隧道中继（PyInstaller 单文件）
├── ultravnc\               15 个文件，VNC 服务本体
├── apps\                   hub 应用（excel.py / solidworks.py）
├── sshd\                   便携 OpenSSH
├── kits\_stick\            凭证：support.json / authorized_keys / me.pub
├── _runtime\               运行时生成：host key / sshd_config / *.log
└── *.cmd                   启动 / 启动-GUI / 清理 / 诊断 / 开关开机自启
```

**路径必须纯 ASCII**：`sshd.exe` 走 ANSI API，中文路径读不到 host key，整条隧道起不来。
目录名可以是 `D:\windows\` 也可以是 `D:\FieldSupport\windows\`——自启脚本两种都认。

启动双击 `启动.cmd`（自提权），界面是 `启动-GUI.cmd`。

### 计划任务（五件）

```
_fs_boot          BootTrigger   开机拉起整套
_fs_keeper        TimeTrigger   每分钟守护
_fs_uilogon       LogonTrigger  登录后 20 秒补桌面 agent
_ss_sshd          BootTrigger   sshd
_session1_agent   LogonTrigger   桌面 agent 本体（Interactive）
```

`_clean.ps1` 只删 `_ss_*` 和 `_fs_rescue`，**不碰 `_fs_boot` / `_fs_keeper` / `_fs_uilogon`**。

## 远程画面（VNC）

**用 UltraVNC，不是 TightVNC。** 同一台机器、同一时刻、同一套抓帧代码实测：

| | TightVNC 服务模式 | UltraVNC 服务模式 |
|---|---|---|
| 锁屏画面 | **全黑** | **登录界面 + 壁纸** |
| 输密码解锁 | 无从验证 | 成功 |

TightVNC 的钩子绑在 attach 时的 `Default` 桌面，锁屏切 `Winlogon` 它留在原地；UltraVNC 会重新挂。

### 三个必须知道的点

**1. 端口 up ≠ 有画面。** hook 注入要**约 40 秒**，期间返回的帧**尺寸完全正确、内容全黑**
（2560x1600 约 11 KB）。**抓帧小于 50 KB 就当黑屏**，别怀疑客户端。

**2. 密码只能用 `setpasswd.exe`。** 手写 `[ultravnc] passwd=` 和写注册表**都不认**，服务会一直报
"no valid password"。它写的是 `[UltraVNC] passwd=<9 字节>`（段名大写）。

**3. 服务在跑就别重建。** `_vnc.ps1` 三条路，只有 `cold` 才付 40 秒：

```
服务在跑 + 端口开  → reused=1     1 秒
密码真的变了      → restarted=1   重启 + 40 秒
服务不存在        → cold          完整安装 + 40 秒
```

就绪标记在 `C:\ProgramData\FieldSupport\vnc-ready.json`，15 分钟内有效。GUI 勾选「允许远程画面」
时后台准备，所以真正连的时候不用等。

**成功判据是 stdout 上的 `VNC_OK`**（ASCII），不是中文输出——`Write-Host` 走 ssh 回来编码会乱。

### 操作端开转发用 tunnel_vnc

```
tunnel_vnc { target, action: 'start' }     # 返回 127.0.0.1:5901 这类地址，给人用 VNC 客户端连
tunnel_vnc { target, action: 'status' }    # 列出所有转发
tunnel_vnc { target, action: 'password', password: 'xxx' }   # 改那台机器的 VNC 密码，最多 8 字符
```

**这是给人看的通道，和 `tunnel_ui`（给我用）是两回事**，互不影响。

### 要自己抓帧的话

不要装 VNC 客户端，写个最小 RFB 客户端就够。三个要点：

```
1. RFB 是大端。用 BitConverter 按小端读会把 2560 读成 25
   width, height = struct.unpack('>HH', head[0:4])
2. 认证：密码前 8 字节当 DES key，每字节 bit 反转，加密 16 字节挑战
3. SetPixelFormat 消息 20 字节（1 + 3 pad + 16），然后 FramebufferUpdateRequest
```

## Linux 侧

### agent 架构（和 Windows 对齐）

```
acceptor（只路由）
  ├── inline   status / ping / info / apps / libs / stop   立刻回，不排队
  ├── general  4 worker   exec / shot / windows / find
  └── serial   1 worker   键鼠（xdotool 共用一条 X 连接）
```

**环境自探测**：systemd 起来没有 `DISPLAY`，sshd 会话也没有。`ensure_ui_env()` 读
`/proc/<pid>/environ` 自己找，日志里能看到 `ui env from Xwayland(pid=...): DISPLAY=:0`。

### 四个 unit

```
fieldsupport.service             隧道
fieldsupport-ui.service          agent 9997（Restart=always）
fieldsupport-ui-keeper.service   oneshot
fieldsupport-ui-keeper.timer     每分钟 OnCalendar=*:0/1
```

`Restart=always` 管崩溃（kill -9 后 2 秒回来）；keeper 管 `stop`/`disable`/符号链接丢失。
**没有** Windows `_fs_rescue` 那种更新兜底——Linux 暂无远程更新机制。

### Linux 侧要装的工具

agent 只依赖发行版基础包，其余按需装。装完不用重启 agent——每次请求都重新探测。

```bash
# 剪贴板（paste）。Wayland 用 wl-clipboard，X11 用 xclip
sudo apt install -y wl-clipboard xclip

# OCR（ocrText）。中文界面要语言包
sudo apt install -y tesseract-ocr tesseract-ocr-chi-sim

# 截图。grim 只对 wlroots 系合成器有效，GNOME 上装了也用不了
sudo apt install -y grim scrot
```

`tunnel_ui action=libs` 能查运行时和具体包，`modules` 还能点名探测：

```
tunnel_ui {action:'libs', modules:['PIL','yaml']}
→ {"ok":true, "python":"3.10.12", "available":{"PIL":true,"yaml":true}}
```

**现场机器常常没网**，所以要么提前在能上网的机器上 `apt download` 拿 `.deb` 拷过去
`dpkg -i`，要么把这些包一起打进 U 盘。

### GNOME Wayland：截图不行，但远程画面有出路

`shot` 先试 grim，**grim 在 GNOME 上一定失败**：

```
compositor doesn't support wlr-screencopy-unstable-v1
```

那个协议是 wlroots 系（sway、Hyprland）才有的。回退到 scrot 之后，拿到的是
**Xwayland 根窗口**——1920x1080、PNG 合法、27 KB，**整张全黑**。

三条替代路都试过，全封闭：

```
gnome-screenshot                   Ubuntu 22.04 默认没装
org.gnome.Shell.Screenshot         AccessDenied: Screenshot is not allowed
org.freedesktop.portal.Screenshot  存在，但要用户在弹窗上点确认，无人值守就是卡死
```

所以 agent 现在**按像素判断**：全黑就返回 `ok=false` 并说明原因，不再交回一张黑图让调用方
以为成功了。

**但「截图不行」不等于「看不到画面」。RDP 可以。**

GNOME 自带的 `gnome-remote-desktop` 在 compositor **内部**抓屏（走 PipeWire），不受
Xwayland 限制，也不像 VNC 那样另起一个空的虚拟桌面。Ubuntu 22.04 默认就装好了。

```bash
# 查状态（必须带这两个环境变量，否则报 "Cannot autolaunch D-Bus without X11 $DISPLAY"）
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
grdctl status

# 启用与设凭据
grdctl rdp enable
grdctl rdp set-credentials <用户名> <密码>
grdctl rdp disable-view-only        # 允许控制（默认就是可控制）

# 确认在听
ss -tlnp | grep 3389
```

转发用 `tunnel_vnc` 的 `remotePort`——**那个参数不限于 VNC**：

```
tunnel_vnc {target:'linux-field', action:'start', remotePort:3389}
→ 127.0.0.1:5902，然后用 mstsc 连（不是 VNC 查看器）
```

握手实测（走隧道，19 字节请求 → 19 字节响应）：

```
03 00 00 13 0E D0 …        0xD0 = Connection Confirm
… 02 03 08 00 02 00 00 00  Negotiation Response，选中 HYBRID (TLS+NLA)
```

**所以：要画面用 RDP，别试 VNC。** 这台机器 `grdctl vnc` 是 disabled，就算启用也是
headless 空桌面；`x11vnc` 直接 `X Error BadMatch`。

`shot` 依然不行——那是给 agent 拿像素用的另一条路，依赖 compositor 的截图接口，
和画面传输不是一回事。

要彻底解决截图（含锁屏），只能切 X11：

```bash
sudo sed -i 's/^#\?WaylandEnable=.*/WaylandEnable=false/' /etc/gdm3/custom.conf
sudo systemctl restart gdm3
```

切过去之后 grim 就别用了（走 scrot），`paste` 会自动从 wl-copy 回落 xclip。

Linux 的主路径始终是 **agent 的 exec / 文件 / 键鼠**，画面是附加项。

**判断 Wayland 不要读 `XDG_SESSION_TYPE`**——sshd 会话里它是空的。用进程表：有 `Xorg` 是 X11，
有 `Xwayland` 是 Wayland。

## 常见故障对照表

| 现象 | 根因 | 处理 |
|---|---|---|
| `clients` 为空 | agent 没起 / 盘拔了 / 出不去网 | 现场双击 `启动.cmd`；`_runtime\` 看日志 |
| `unknown_kit` (404) | 服务端 `kits\` 没有这个 kitId | 确认服务端目录 |
| `auth failed` (401) | token 不匹配 | U 盘 `kits\_stick\support.json` 与服务端对齐 |
| 隧道在线但 SSH `Permission denied` | ① 账户名错 ② `authorized_keys` 缺失 | `whoami` 确认；补写 authorized_keys（sshd 每次连接重读） |
| `sshUp: false` 但隧道绿色 | sshd 挂了或被禁 | 只能先用 `tunnel_ui`；到机器上重启 sshd 任务 |
| `tunnel_ui` 返回空/解析失败 | agent 不在，或 9997 被占 | `tunnel_ui action=status` 探活；`_diag.ps1` 看第 8 项 |
| 命令在 agent 里卡住 | 某个 exec 挂了几百秒 | `action=status` 看 `active[]`，问题在命令不在 agent |
| COM 调用失败但软件开着 | 用了 `tunnel_exec`（session 0） | 改用 `tunnel_ui action=com` / `action=exec` |
| GUI「键鼠 ○ 未启用」 | `_session1_agent` 任务 Ready 而进程已退 | `Start-ScheduledTask _session1_agent`，不必重启整套 |
| GUI 卡、点不动 | 定时器里跑了 WMI（`Get-NetTCPConnection` 单次可 700 ms） | 用 `IPGlobalProperties::GetActiveTcpListeners()` |
| GUI 有多个窗口叠着 | 没单实例保护 | 同时只跑一个；`_gui.ps1` 顶部已有判断 |
| 界面报「凭证 X」 | `_diag.ps1` 不认 `kits\_stick` | 更新 `_diag.ps1` |
| VNC 连上但画面全黑（约 11 KB） | hook 还没注入完，约需 40 秒 | 等；看 `_vnc.ps1 -Status` 是否 `reused` |
| VNC 报 no valid password | 密码不是 `setpasswd.exe` 写的 | 用 `setpasswd.exe <pw>`，别手写 ini/注册表 |
| `_vnc.ps1` 卡住不返回 | 在拆一个正跑着的服务（StopPending） | 服务在跑就复用，别重建 |
| Linux 9997 连不上 | agent 没起 / 服务被 disable | `systemctl is-active fieldsupport-ui`，keeper 一分钟内拉回来 |
| Linux 改了 py 没生效 | 服务没重启 | `sudo systemctl restart fieldsupport-ui` |
| Linux 看不到桌面 | Wayland | 无解；要画面只能切 X11 |
| 重启后连不回来 | 这台没装开机自启 | 现场跑一次 `启动.cmd` 或 `开启开机自启.cmd` |
| **截图看着不对** | 客户机可能有 RDP 会话占了某块屏；且 `windows` 的坐标和截图像素在 DPI 缩放下对不上 | **用 `windows` 枚举核对，别只信图** |

## 远程更新客户端（不用人碰机器）

```
1. tunnel_upload 新文件 → F:\FieldSupport\windows\_update-in\
2. tunnel_exec 跑 update-agent.ps1 -Mode stage      # 不断线，先验哈希
3. 注册一次性 SYSTEM 任务跑 apply（不能在 tunnel_exec 里直接跑，会杀掉自己）
4. 等 10-20 秒 → tunnel_list 看 accepted 是否 +1
5. 读 _runtime\update.state.json：ok=true 且 rolledBack=false 才算成功
```

`apply` 在停 agent 前会 arm 一个 `_fs_rescue`（+3 分钟）；agent 起来后自己 disarm，起不来就留着兜底
——所以"改坏了"最多失联三分钟。

改了 `session1-agent.py` 也可以走 `tunnel_ui action=stop restart=true` 直接重载，比整套更新轻。

## 安全边界

- 凭证只在 U 盘里（`kits\_stick\support.json` 的 kitId + token）。**盘就是钥匙**，盘丢就换 kit。
- 服务端只认 `kitsDir` 里登记过的 kitId + token；新增 kit 目录在下次握手前 `refresh()` 时生效。
- 客户机侧不存任何 API key：agent 只是中继，AI 推理全在操作端。
- `清理.cmd` 后系统应无残留：`%TEMP%\_ss_*`、`C:\ProgramData\SSH`、`C:\Program Files\OpenSSH` 都应为空。

## 详细资料

项目目录 `D:\ai\bmc-control\remote-support\`：

- `HANDOFF.md` —— 架构、实测时间线、坑清单 A–AI（**遇到怪现象先搜这里**）
- `STATUS.md` —— 更短的现状
- `TUNNEL-PROTOCOL.md` —— 帧格式与握手细节
- `support-tunnel/lib/{server,tools,guard,ports}.js` —— 操作端实现
