---
name: remote-support
description: 通过 TLS 隧道远程操作客户机（Windows/Linux）：执行命令、传文件、桌面控制、远程画面、重启。Use when the user asks to 远程支持/连客户机/看现场那台机器/在客户机上跑命令或截图/改客户机上的文件, when tunnel_list or tunnel_ui or tunnel_exec must be used, or when a machine is reached through the support stick (U 盘, kits\_stick). 覆盖 target 解析、十三个工具的分工、后台长任务、桌面 agent 的 26 个动作、UltraVNC 远程画面、Linux 侧 systemd 部署和故障对照表。
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

## 十三个工具

| 工具 | 用途 |
|---|---|
| `tunnel_list` | 在线列表和端口 |
| **`tunnel_ui`** | **29 个动作（22 个桌面 + 7 个 agent 命令），见下** |
| `tunnel_exec` | 在客户机跑命令，见下「在哪执行」 |
| `tunnel_upload` / `tunnel_download` | 传文件，见下 |
| **`tunnel_stat`** | 查一个文件的 existence/size/mtime，Windows 还报 `locked`（**真布尔**；非 Windows 上这个字段不存在，别把"缺省"当 false） |
| `tunnel_audit` | 读最近的活动记录，`limit` 默认 20 最多 200 |
| **`tunnel_forward`** | 转发任意 TCP 端口给人用（VNC 5900 / RDP 3389 / Web 管理页）；`tunnel_vnc` 是它的别名 |
| `tunnel_reboot` | 重启客户机，唯一能越过关机守卫的路径 |
| `tunnel_disconnect` | 断开一台 kit 并释放端口 |
| **`tunnel_job_output`** | 读 `background:true` 起的长任务：还在跑吗、输出到哪、真实退出码 |
| **`tunnel_job_kill`** | 停掉那个长任务 |

### 跑长命令：用 background，别让超时骗你

`robocopy` 拷几万个文件、`pip install`、`tar` 打包几百 MB——**这些一跑就是几分钟**。
前台调用撞上超时会返回 `The operation was aborted`，但那**不代表命令失败**，
它可能已经跑完了，只是输出还没回来。

```
tunnel_exec { target, command, background: true }   → 立刻拿到 jobId
tunnel_job_output { jobId }                          → running / exitCode / 输出
tunnel_job_kill   { jobId }                          → 不想要了就停
```

后台模式下 `exitCode: 0` **只代表启动成功**，真正的结果在 `tunnel_job_output` 里。

### 非 0 退出码有时是成功

`robocopy` 复制成功返回 **1**，diff 类工具发现差异也返回 **1**。
给它们一个 `accept_exit_codes: [0, 1]`，结果里会带 `accepted: true`，
免得把成功当失败然后又去"修"一遍。

### 上传前先看目标

不知道目标在不在、多大、是不是被 Excel 占着——用 `tunnel_stat`，别拼一段 PowerShell。
`locked: true` 就是「这个文件现在写不进去」，比等 scp 报一句 `Failure` 强。

### 命令走命令行，传文件走 scp

命令行有长度上限（几千字符就会失败）。**要写文件内容就用 `tunnel_upload`**，
不要切成几十块 base64 塞进命令行——那既慢又容易在半路断掉重传。

### cmd 装不了中文

```
tunnel_exec { shell: "cmd", command: "echo 中文" }
→ 拒绝：cmd 下含非 ASCII 的命令必然乱码
```

不是没修，是修不了。命令按 UTF-8 字节经 ssh 送到 sshd，而 cmd 拆分同一行里的参数时
用的是它自己的 936 代码页；`chcp 65001` 只影响**之后**新启动的命令，改不了它所在的那
一行。实测 `chcp & echo test-utf8-中文` 会打印 `Active code page: 65001`，然后照样乱码。

**含中文就用 `shell: "powershell"`**（不指定时 Windows 默认就是它）。纯 ASCII 的 cmd
命令不受影响，`dir` 这类**输出**里的中文也是正常的——坏的只有输入侧。

### `tunnel_list` 里看 loginUser，不是 user

`user` 是客户端上报的原值，机器被 SYSTEM 任务拉起时它是 `VISIONFRAME$` 这种计算机账户
——**登不进去**。真正用来登录的是 `loginUser`。

`sshCommand` 已经按 `loginUser` 重写过，可以直接用；`user` 和 `loginUser` 不一样时，
说明这台机器上 agent 不是用户会话拉起来的，这是正常的，不是故障。

## 传文件：用 scp，不要绕 agent

**传文件一律用 `tunnel_upload` / `tunnel_download`。** 它们是 scp over 隧道，
流式传输，几 MB 的截图和几十 MB 的安装包都能直接过。

**不要用 `tunnel_ui action=exec` 加 base64 来传文件**，除非 scp 明确不通：

| | `tunnel_upload`（scp） | agent exec + base64 |
|---|---|---|
| 大文件 | ✅ 流式，没有上限 | ❌ 膨胀 33%，而且命令行长度只有几十 KB |
| 速度 | 快 | 慢，内容要过一遍 JSON 和 shell |
| 二进制 | ✅ 原样 | ⚠️ 换行、编码都可能被改 |
| 中文路径 | 可能有问题 | 一样有问题 |

base64 只适合**几百字节的小文本**当兜底，而且写进去还要处理引号嵌套。

**`tunnel_ui action=shot` 例外**：它已经把 PNG 自动拉回本地（返回里带 `localPath`），
要看屏幕就直接读那个路径，别再 `tunnel_download` 一趟。

### scp 报错不等于 scp 坏了

`tunnel_upload` 报 `Permission denied (publickey)` 时，看着像传输坏了——
**其实是账户问题**（agent 被 SYSTEM 拉起时上报 `NAME$`），和 `tunnel_exec` 同一个根因。
配好 `clientUser` 两边一起恢复。**不要因为 scp 报错就改用 agent 传**，
那只是把同一个账户问题换个地方踩，而且大文件根本传不了。

### 覆盖默认被拒绝

`tunnel_upload` 上传前会问一句远端：**目标文件如果比本地这份新，直接拒绝**，
报错里带远端的时间和大小。

**这是有意的**，不是故障。用户在两次上传之间编辑过那个文件，盖上去就没了——
2026-11-21 就这么丢过一次 pptx 的编辑，VSS、AutoRecover、回收站全都没有副本。

```
要覆盖  → 带 overwrite: true
要保留  → 换个 remotePath
```

远端更旧、或者不存在时照常上传，不会多问。**别为了绕过这个提示就写 `overwrite: true`**
——先确认你手上的版本确实该赢。

### 下载会校验，但大文件仍要自己确认

`tunnel_download` 现在会检查：scp 退出码非 0 直接报错；拉到 0 字节但远端有内容也报错
（以前这两种都返回 `exitCode: 0`，和成功无法区分）。

但**内容完整性它管不了**：截图 PNG 3 MB 时抢断会拿到半截（有 magic 没有 IEND）。
大文件传完自己核一下大小或哈希。

### 这两个工具不在本机开 ssh

`tunnel_exec` 和 `tunnel_ui` **都不在本机起 ssh 进程**：它们把命令 POST 给隧道服务端
（`/api/kit/<sessionKey>/exec`），**由服务端 SSH 进客户机执行**。

```
插件 → HTTP → 服务端 → ssh → 隧道 → 客户机 sshd
```

两个直接后果：

- **本机找不到 ssh 进程**。排查「为什么连不上」时别在本机翻 ssh.exe，那里没有
- **登录账户以服务端收到的为准**。控制端只能通过请求体里的 `user` 覆盖它；
  以前不带这个字段，控制端算好的账户（把 `NAME$` 换成真实用户）到服务端就丢了，
  症状是「改控制端怎么都不生效」——这个坑踩过一次，绕了很久

### 改代码前先确认改哪一侧

**`tunnel_exec` / `tunnel_ui` 的命令由服务端拼，不是控制端。** 想改命令怎么发出去，
改 `tools.js` 是白改——那里的 `buildRemoteCommand` 在这条路径上**根本不会被调用**。

| 想改什么 | 改哪 |
|---|---|
| **命令拼装**：编码、引号、shell 选择、cwd、preamble | `tunnel-server/lib/kit-actions.js` 的 `remoteArgv()` |
| **登录账户** | 两侧都要：控制端 `resolveSession`/`sshBase` 算出真实账户 → 请求体带 `user` → 服务端优先用请求里的 |
| **工具参数、返回结构、错误文案** | `support-tunnel/lib/tools.js` |
| **上传/下载怎么传** | 控制端 `remote.js`（走服务端 `/kit/file`）或 `tools.js`（本机 scp 回退） |
| **VNC/RDP 转发** | `support-tunnel/lib/vnc.js`（本机 `ssh -L`） |

**改完必须重启对应的那一侧**：改 `kit-actions.js` 要重启 `_tunnel_server`，
改 `tools.js` / `index.js` 要重启 DSH。**只重启一边等于没改**——代码是对的，
跑的还是旧的。

**这个错犯过两次，都是同一个误解**：

```
user 账户覆盖   写在 tools.js      → 服务端没收到，Permission denied 照旧
UTF-8 / CLIXML  写在 tools.js      → 服务端没收到，中文照旧乱码
```

两次都是「改完以为好了，实测一模一样」。改这类东西之前，先问一句：
**这条命令最后是谁在拼？**

### 改完必须重启，`applied` 不等于生效

`plugin_manager install_bundle` 返回 `application: applied` 只说明**文件和配置换了**。
ESM 按路径缓存模块，**同一路径重装不会重新求值**——跑的仍是旧代码。

实测过一次：同一个 bug 连改四版（条件赋值 → 出口净化 → 硬编码返回 → 加审计探针），
每次都 `applied`，每次现象一模一样。硬编码返回值都报错、审计探针一条没留下，
才终于明白那四版代码一版都没被加载过。重启之后第一次就对了。

**发布流程**（正式 tarball 安装，包名 `dsh-support-tunnel`）：

```
1. 改 package.json 的 version
2. npm pack                                     → dsh-support-tunnel-<ver>.tgz
3. plugin_manager install_bundle <tgz 绝对路径>
4. 重启 DSH                                     ← 省不掉
```

改名那一刻是唯一的例外：新包名 = 新路径 = 新缓存键，装完立即生效。但下次同包名升级
又要重启，别把这个巧合当规律。

`link:` 安装也别指望热重载：HMR 的 `ignored` 默认含 `**/node_modules`，而两种安装方式
都把插件放在那下面。它管的是 profile 配置和少数被 watch 的路径，不是插件代码。

### 装完要不要重启，看改的是哪一层

两种都要**重新打包安装**——profile 读的是 `node_modules` 里的副本，不是工作目录。
区别只在装完之后那一步：

| 改了什么 | 装完要重启吗 | 为什么 |
|---|---|---|
| `lib/*.js`、`index.js` | **要** | ESM 按路径缓存模块，同路径重装不会重新求值 |
| `skills/*.md` | **不要** | skill provider 按 mtime 读文件，副本换了就读到新的 |
| `client.js`（Web 端） | 看情况 | 要重建客户端 bundle；`pnpm run dev:web` 在跑时会自动重载 |

所以只改 skill 文案时，bump 一个小版本、pack、install 就结束了，不用打断会话。
改 `lib/` 里任何一个 `.js` 就必须重启，没有例外。

### 改源码只能用文件工具，不能用 PowerShell 的读写 cmdlet

`Get-Content -Raw` 不给 `-Encoding` 时，PowerShell 5.1 按 ANSI（中文机器上是 GBK）读，
`[IO.File]::WriteAllText(..., UTF8)` 再按 UTF-8 写回去——**整份文件的中文注释全毁**。
文件里不会有 U+FFFD，只是每个汉字都变成了另一串合法字符，看着像编码"没问题"。

用 `edit` / `write` 工具改，它们按 UTF-8 处理。真要用 PowerShell 批处理，读写两侧都显式
给 `[Text.UTF8Encoding]::new($false)`。

`tunnel_upload` / `download` / `reboot` 走另一条路（本机 ssh/scp 直连 loopback），
所以它们和 exec 的失败原因可能不同，别用同一套假设。

### GUI 程序别用 tunnel_exec 驱动

`tunnel_exec` 落在 **session 0，没有桌面**。

```
New-Object -ComObject PowerPoint.Application     ← 成功
$app.Presentations.Open("x.pptx")                ← "PowerPoint could not open the file"
```

看起来像**文件损坏**，其实只是这个 session 没有交互式桌面。现场据此误判过一次，
带着"文件是坏的"这个结论绕了很远。

现在 `tunnel_exec` **直接拒绝**驱动 Office/COM 的命令并说明原因——识别
`New-Object -ComObject`、`GetActiveObject`、`GetTypeFromProgID` 和常见 ProgID。
**要碰用户开着的软件，一律 `tunnel_ui action=exec` 或 `action=com`。**

### 上报的账户可能是机器账户

agent 被 **SYSTEM 计划任务**拉起时（机器刚重启、还没人登录），它上报的是计算机账户：

```json
"user": "VISIONFRAME$"
```

**Windows 不给 `NAME$` 账户交互式登录权**，sshd 一律回 `Permission denied (publickey)`，
哪怕 key 完全正确、端口也通。实测同一个端口：`VISIONFRAME$` 拒绝，`lzh` 正常返回主机名。

所以 `tunnel_list` 里看到 `user: XXX$` **不用紧张**——那是客户端上报的原始值，
工具用不用它是另一回事。真正决定登录的是配置：

```yaml
# cordis.patch.yml
clientUser: 'lzh'    # 上报名称为空、或以 $ 结尾时，改用它登录
```

**没配这一项，SYSTEM 拉起的 agent 就等于完全不可用**——而机器重启后正是这个状态。

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
| 批量 | `batch`(actions) |
| 浏览器 | `browser`(url, isolated) `browser_close`(profileDir) |

### 一串动作：用 batch

```
tunnel_ui { action: "batch", actions: [
  { action: "click", x: 120, y: 88 },
  { action: "type",  text: "192.168.1.10" },
  { action: "key",   keys: "{ENTER}" }
] }
```

一次往返，比分开发三次省事。**但 batch 不是事务**——端侧把 actions 解析成一步步，
每一步各自排队或放行，两步之间别的调用可以插进来。要保证"点这个再打字"不被打断，
靠的是**同一个窗口的动作在同一条车道上排队**，不是靠批次本身。

**默认第一个失败就停**：点击没命中，后面的 `type` 会打到别处去。要跑完剩下的传
`continueOnError: true`。返回里 `stoppedEarly` + `stopReason` 说明为什么停。

不支持嵌套 batch。

#### 两种模式：20 步以内同步，超过进队列

```
mode: "inline"   当场跑完，直接返回全部结果
mode: "job"      端侧建作业、起线程，立刻返回 jobId
省略              ≤20 步 inline，>20 步 job
```

作业模式才有中间状态可看：

```
tunnel_ui { action: "batch", mode: "job", actions: [...] }
→ { jobId: "a1b2c3", state: "running", index: 0, total: 300 }

tunnel_ui { action: "batch_status", jobId: "a1b2c3" }
→ { state: "running", index: 47, total: 300, done: 47,
    currentAction: "drag", currentKind: "ui", currentLane: "queued",
    elapsedMs: 8210, results: [...] }

tunnel_ui { action: "batch_cancel", jobId: "a1b2c3" }
→ { cancelling: true, index: 47, total: 300 }
```

`batch_status` 不带 jobId 就列出所有在跑的。`batch_cancel` **在步骤之间生效**，
正在执行的那一步不会被打断。

#### 跑太久会停在断点上

一场 batch 会一直占着端侧的通道。步数不是约束，**时间是**：

```
budgetSeconds    默认 35，上限 300
超预算 → state: "budget"，如实给 nextIndex
```

```
{ "stoppedEarly": true, "stopReason": "budget", "nextIndex": 120 }
```

`nextIndex` 是从哪一步断的——**从它继续，不要重放已经做完的**。
`stopReason` 有三种：`none` / `error` / `budget`。

### 串行还是并行：由你决定，不用猜

每个动作和每个 batch 步骤都可以带 `serial`：

```
serial: true    强制排队
serial: false   强制放行
省略            按动作类型自动判断
```

自动判断的规则是端侧的分类：

```
ui           碰光标/键盘/COM/前台状态   → 排队
background   只在旁边读数据或跑命令      → 放行
inline       查队列自身状态             → 连队列都不等
```

**为什么要能覆盖**：分类是工具对"这动作碰什么"的猜测，而你知道自己想干什么。

- 两条后台动作必须互斥（同一份文件写两次、两条互相干扰的 `exec`）→ `serial: true`。
  它们没有 hwnd，会一起排在 `global` 这条道上。
- 已知互不影响的动作想并行 → `serial: false`。

每个结果都告诉你实际发生了什么：

```json
{ "ok": true, "taskKind": "background", "lane": "direct" }
```

`taskKind` 是分类，`lane` 是它到底排了队还是一路放行。**"排没排队"是可以问的，
不用猜。**

### 看端侧现在在干什么

```
tunnel_ui { action: "status" }
```

```json
"lanes": { "984040": { "busy": 1, "action": "click", "heldMs": 1832, "by": "serial0" } },
"batchJobs": [ { "jobId": "a1b2c3", "index": 47, "total": 300 } ],
"taskKinds": { "ui": [...], "background": [...], "inline": [...] }
```

`lanes` 说清楚每条道被谁占着、占了多久——一个动作卡住时，`heldMs` 一直涨的就是它。

### 浏览器：默认开一个干净的

```
tunnel_ui { action: "browser", url: "https://example.com" }            # 隔离
tunnel_ui { action: "browser", url: "https://example.com", isolated: false }  # 用他的
```

`isolated` 默认 **true**：起一个用完就扔的 profile，没有 cookie、没有历史、不碰用户的
任何东西。**翻客户已登录的浏览器和打开一个页面是两回事**，所以安全的那条是默认值，
要用他现有登录态才显式传 `false`。

返回里有 `profileDir`，用完销毁：

```
tunnel_ui { action: "browser_close", profileDir: "C:\\ProgramData\\FieldSupport\\browsers\\run-xxxx" }
```

不销毁的话那个目录会一直留着（几十 MB）。`browser_close` 只接受 agent 自己目录下的
路径，传别的会被拒。

Linux 上 agent 是 root，浏览器会**降权到会话用户**再起——root 起 Chrome 要么被拒，
要么得关沙箱。

两个省事的细节：

- **`shot` 会把 PNG 自动拉回本地**，返回里带 `localPath`，不用再 `tunnel_download` 一趟
- **`click` 支持 `capture: true`**，前后各截一张，一次调用就能看出点中了没有

`shot` 连被挡住甚至最小化的窗口都能截（被控端用 PrintWindow，不是截屏幕）。

### 坐标

物理像素。`screen: 0` 主屏、`1` 第二块、以此类推，每块屏从自己左上角算。
给了 `hwnd` 就是**窗口客户区相对坐标**，这种情况下不用操心屏幕偏移。

**`hwnd` 是必须的**：不传它，`x/y` 会被当成绝对坐标。画图那次拖了十几次什么都没画出来，
就是因为插件白名单漏了 `hwnd`，坐标静默变成了绝对坐标。传了之后实测：画图在 `(60,40)`，
窗口内 `(500,500)` → 屏幕 `(560,540)` ✓

**但不要靠截图验证界面**——见故障表最后一行。

### 点准的唯一办法：mark + ref，不要估像素

**永远不要从截图里读坐标。** 实测过：我看图估「画笔」按钮在 `(505,137)`，UIA 报的是
`(430..496, 115..215)` —— 偏 42 像素，点在按钮外的空白处。工具栏那么密，42 像素就是
另一个控件。

正确做法是让工具把编号画在图上：

```
tunnel_ui { action: "state", target, mark: true }
```

返回里 `controls` 每一项带 `n`（编号）、`ref`、以及 UIA 的精确矩形，画面上每个可交互控件
都有红框和号码：

```json
{ "controls": [
    { "n": 27, "ref": "e27", "text": "画笔", "type": 50013,
      "x": 691, "y": 221, "w": 40, "h": 55 },
    { "n": 36, "ref": "e36", "text": "红色", "type": 50007, ... } ] }
```

然后 `click { ref: "e27" }` —— 坐标由 UIA 给，不需要你算。

`mark: true` 只挑能点的（Button / Edit / ListItem / TabItem / CheckBox / ComboBox /
Hyperlink / MenuItem / RadioButton / Slider / TreeItem / DataItem / SplitButton），
一个典型的画图窗口是 45 个。默认上限 40，用 `limit` 调。

**同时还会生成一张 mask 图**（返回里的 `mask`）：

```
原图   控件上叠红框 + 编号，标签有碰撞回避
mask   黑底，每个控件填成一整块独立颜色，号码写在块中央
```

工具栏里相邻控件只隔 8 像素，原图上红框边框贴在一起，看图容易指错；mask 里每个控件
是不相连的色块，"我要那个色块"就没有歧义了。`mask.legend` 给出号码 → 颜色 → ref：

```json
{ "n": 27, "ref": "e27", "text": "画笔", "color": "#4880ff" }
```

### 滚动和缩放：用 scroll，不要用 wheel 猜

`wheel` 是开环的——发多少个 notch、实际滚了多远，调用方拿不到。画图里
`delta: 480` 直接把整张图滚出视野。

用 `scroll`，它走 UIA ScrollPattern，**前后位置都报**：

```
scroll { hwnd, read: true }            只看当前在哪
scroll { hwnd, vertical: 0 }           到顶
scroll { hwnd, vertical: 100 }         到底
→ { scrollBefore: {vertical: 84.8}, scrollAfter: {vertical: 100},
    progress: { vertical: { reached: true, steps: 2, landed: 100 } } }
```

`reached: false` 就说明没到位，`landed` 告诉你停在哪儿。

`wheel { ctrl: true }` 是缩放。**缩放级别 UIA 读不到**，所以它只返回
`zoomRequested: true`，要确认结果得再 `shot` 一次。

### UIA 优先：不碰光标也不抢焦点

`click { ref }` 会先试 `Invoke` → `SelectionItem.Select` → `Toggle`，都不支持才退回真实
点击。`type { ref }` 会先试 `ValuePattern.SetValue`。

好处不只是快——**这些路径不动光标、不抢前台**，所以不同窗口的这类动作可以并行。
返回里的 `mode` 说明走了哪条：

```
mode: "uia" + pattern: "invoke"     语义动作
mode: "uia-setvalue"                ValuePattern 直接赋值
mode: "physical"                    退回真实点击
mode: "unicode"                     SendInput 注入字符
```

`uia-setvalue` 是**整段替换**。所以只有控件原本为空、或显式传 `replace: true` 时才用——
不然会把用户已经填好的内容抹掉。

### 打字：不受输入法影响

`type` 用 `SendInput` + `KEYEVENTF_UNICODE` 直接注入码位，**绕开键盘布局和输入法**。

以前的实现走 `VkKeyScan` + `keybd_event`，中文输入法开着时打 `abc` 出来的是 `a'b'cabc`
——输入法把它当拼音在分音节，组合串和上屏文本一起出现在屏幕上。这个靠调时序修不了，
键根本没到应用。

所以：**中英文都直接用 `type`，不要为了"绕开输入法"改用剪贴板**。

### 判断"这一下有没有生效"：changed

改变状态的动作会带 `changed`（真变化 `true`，没变化 `false`），拿不到画面时带
`changedUnknown` 和原因——**省略和"没变"在调用方看来是一样的**，所以不能说的时候要说明。

两个已知边界：

- **窗口被遮挡时不可信**：像素判据读的是屏幕上看到的东西，窗口在后面就抓到前面的窗口，
  会给出 `false`（画图那次选中画笔就是真实的 `false`）
- **贵**：一次观察最多 3 秒。批量操作里用 `observe: false` 关掉，最后再 `state` 一次看结果。
  实测 10 段拖拽开了观察是 30 秒，关掉是 3.3 秒

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
├── session1-agent.py       桌面 agent（29 个动作）
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

**服务不会自己起来。** `grdctl rdp enable` 只是置了配置，真正监听 3389 的是用户级服务：

```bash
sudo -u <user> env XDG_RUNTIME_DIR=/run/user/$(id -u <user>) \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/0/bus \
    systemctl --user restart gnome-remote-desktop
```

### 自动登录的机器配不了 RDP 凭据

这条排查起来很费时间，因为报错和真实原因没关系：

```
$ grdctl rdp set-credentials ubuntu ubuntu
Object does not exist at path ?/org/freedesktop/secrets/collection/login?
```

`grdctl` 把用户名密码存进 **gnome-keyring**，而 keyring 的 login collection 只在
**真正输入过一次密码登录**之后才建立。**配了自动登录的机器永远不会有它**——GNOME 从没
收到过密码，也就从没解锁过 keyring。

`grdctl status` 会一直显示 `Username: (empty)` / `Password: (empty)`，服务不监听 3389，
而 `set-credentials` 要么报上面那句，要么**静默卡住**（等一个永远不来的解锁提示）。

两种解法：

**A. 关掉自动登录，手动登一次**（推荐，一次就好）

```bash
sudo sed -i 's/^AutomaticLoginEnable=true/AutomaticLoginEnable=false/' /etc/gdm3/custom.conf
sudo systemctl restart gdm3
# 在机器前（或通过 VNC/控制台）输一次密码登录，keyring 就建好了
```

**B. 直接解锁 keyring**（不重启图形会话）

```bash
sudo -u <user> env XDG_RUNTIME_DIR=/run/user/$(id -u <user>) \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u <user>)/bus \
    bash -c 'echo -n "<密码>" | gnome-keyring-daemon --unlock --components=secrets'
```

解锁后 `grdctl rdp set-credentials` 立刻能用（返回 0，`status` 里显示 `(hidden)`）。

**TLS 证书不需要 keyring**，可以先用 openssl 自签绕开这一半：

```bash
openssl req -x509 -newkey rsa:2048 -keyout ~/rdp.key -out ~/rdp.crt -days 3650 -nodes -subj "/CN=$(hostname)"
grdctl rdp set-tls-cert ~/rdp.crt
grdctl rdp set-tls-key  ~/rdp.key
```

但**光有证书不够**：没有凭据，3389 依然不监听。

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

### 切到 X11 之后，整套工具全部恢复

同一台机器、同一套 agent，只换会话类型，能力差别很大（实测数据）：

| 能力 | GNOME Wayland | X11（ubuntu-xorg） |
|---|---|---|
| `shot` | ❌ `Can't open X display` / 27 KB 全黑 | ✅ **94 KB 真实画面** |
| `windows` | ⚠️ 只列出 Xwayland 客户端 | ✅ **11 个窗口全部** |
| 键鼠 | ⚠️ 只能操作 Xwayland 应用 | ✅ 全部 |
| `paste` | ✅ wl-copy | ✅ xclip |
| VNC | ❌ 见上文，无解 | ✅ x11vnc 可用 |
| RDP | ✅ 要 keyring | ✅ |

**不是工具不行，是 GNOME 的 Wayland 实现不提供这些接口**：`wlr-screencopy` 是 wlroots
专有、`x11vnc` 要根窗口像素而 Xwayland 不给、`xdotool` 对原生 Wayland 窗口无效。
agent 里那套工具本来就是为 X11 写的，**GNOME Wayland 是唯一让它们同时全部降级的会话**。

**能选就选 X11**，三种做法从轻到重：

```
1. 登录界面右下角齿轮 → "Ubuntu on Xorg"      改一次，只影响这个用户
2. /etc/gdm3/custom.conf 里 WaylandEnable=false  全局强制
3. 换 XFCE / MATE 这类 X11 原生桌面            最彻底，但要重装桌面
```

第 1 种最省事，现场机器操作一次就够；第 2 种适合新部署，写进装机脚本。

切过去之后 `is_wayland()` 返回 false，`shot` 走 scrot，`paste` 回落 xclip，**全自动，
不用改任何配置**。

```bash
# 全局强制 X11
sudo sed -i 's/^#\?WaylandEnable=.*/WaylandEnable=false/' /etc/gdm3/custom.conf
sudo systemctl restart gdm3
```

**判断会话类型必须以 `XDG_SESSION_TYPE` 为准**：X11 会话里 `/run/user/<uid>/wayland-0`
常常是上一个 Wayland 会话留下的残骸，照着 socket 推断会让 grim 顶掉 scrot，截图反而
失败（这个坑踩过，日志是 `grim 不可用 (failed to create display)`）。

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
| **`Permission denied (publickey)` 但 key 是对的、端口也通** | **agent 上报了机器账户 `NAME$`**（被 SYSTEM 任务拉起）—— Windows 不给这类账户交互式登录权 | 配 `cordis.patch.yml` 的 `clientUser`；判断依据是 `tunnel_list` 里 `user` 以 `$` 结尾 |
| **本机找不到 ssh 进程** | `tunnel_exec` / `tunnel_ui` 由**服务端**执行，本机只发 HTTP | 正常。要排查去服务端，本机翻了也是空的 |
| 私钥报「拒绝访问」或 `UNPROTECTED PRIVATE KEY FILE` | 导入的 kit 带着继承 ACL（zip 解压、跨机复制） | 插件启动时已自动收紧；手工可 `icacls <key> /reset` 再 `/inheritance:r /grant:r "<user>:(F)" /grant:r "SYSTEM:(F)"` |
| `The operation was aborted` 但命令其实跑完了 | 前台调用撞上通道超时，超时≠失败 | 长命令改用 `background: true`，用 `tunnel_job_output` 拿真实结果 |
| 中文输出变成乱码 | 以前是 PowerShell 的 OEM 代码页 | 已修（脚本开头设 UTF-8）；cmd 走 `chcp 65001`。还乱就 `[Console]::OutputEncoding` 自己再设一次 |
| stderr 里全是 `#< CLIXML` | PowerShell 的 progress 流被序列化 | 已修（`$ProgressPreference=SilentlyContinue`）。若仍出现，是客户机上的旧 agent |
| `tunnel_audit` 返回空 | remote 模式以前没有本地日志 | 已修，本地落 `%TEMP%\support-tunnel-audit.jsonl` |
| 上传报「目标在远端更新」 | **不是故障**，是覆盖保护 | 确认自己这份该赢就带 `overwrite: true`；否则换 `remotePath` |
| scp 报 `dest open ... Failure` 或 `No such file or directory` | 目录不存在 / 文件被占用 / 权限 / 磁盘满，scp 全说成一句话 | 已改为失败后 stat 目标并说明具体原因（本机 scp 和服务端两条分支都有）；也可自己先跑 `tunnel_stat` |
| `cmd` 下中文变问号 | 输入侧的代码页问题，`chcp` 改不了同一行的参数 | 已改为直接拒绝；含中文就用 `shell: "powershell"` |
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
