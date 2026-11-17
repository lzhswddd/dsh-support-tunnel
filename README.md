# support-tunnel

把「客户机反向连服务端」从 SSH `-R` 换成一条 HTTP/HTTPS 隧道：客户机主动连出，服务端为每台在回环上开独立端口，`ssh` / `scp` 直接走那个端口。

对外只需要一个入口端口（默认 24443），多台客户机同时在线，按 `(kit, 机器名)` 各分一个本机端口。同一个 U 盘 kit 可以同时服务多台机器。

## 它解决什么

| 老办法（SSH `-R`） | 这个插件 |
| --- | --- |
| 每台客户机占一个映射端口 | 对外只开一个端口 |
| 同一端口被占第二台就连不上 | 多台同时在线 |
| 换现场要重新试端口 | HTTPS 出站，企业网一般放行 |

## 快速开始

### 1. 装插件

把本目录放到任意位置，然后任选一种：

- DSH **设置 → 插件 → 添加插件**，选这个目录
- 命令行：`plugin_manager` 的 `install_bundle`，target 传本目录绝对路径

装完重启 DSH（插件的 Host 代码要重新加载）。

### 2. 配置入口地址并导出客户端配置

打开 **设置 → 插件 → 客户机隧道**：

1. 填 **kit 名**（比如「车间电脑」）
2. 填 **服务端地址**——客户机要连的域名或 IP
3. 端口保持 24443（除非你改了监听端口）
4. 点 **生成 support.json**

kit 不存在会自动新建：生成 `kitId`、32 字节 `token`，并在 Host 上生成 `operator` 密钥。生成结果写到：

```
<kitsDir>/<kit 名>/client/support.json
```

面板里可以直接复制 JSON 或下载。

### 3. 给客户机装客户端

把 `kits/<kit 名>/client/` 整个目录拷过去：

| 平台 | 客户端 | 启动 |
| --- | --- | --- |
| Windows | `support-agent.exe`（见下）或 `support_agent.py` | 双击 `启动隧道.cmd` |
| Linux / macOS | `support_agent.py`（用系统 `python3`） | `python3 support_agent.py -c support.json` |

Windows 的 exe 需要自己打：

```powershell
cd support-agent
.\build.ps1
```

或者直接把 `support_agent.py` 和 Python 一起给客户机。

### 4. 连上去

客户机连上后，`tunnel_list` 会列出它和分配的本机端口，直接：

```bash
ssh -p 40001 -i <kitsDir>/<kit>/operator/operator_id <用户>@127.0.0.1
```

## 工具

| 工具 | 作用 |
| --- | --- |
| `tunnel_list` | 在线客户机、`kitId`、`clientOs`、本机端口、收发字节、可直接复制的 ssh 命令 |
| `tunnel_exec` | 跑一条命令，`shell` 可选 `auto`/`cmd`/`powershell`/`sh`/`bash` |
| `tunnel_upload` / `tunnel_download` | scp 收发单个文件 |
| `tunnel_disconnect` | 踢掉一台并释放端口（客户机会自动重连） |
| `tunnel_audit` | 最近的连接、执行、传输、被拦命令 |
| `tunnel_reboot` | 重启客户机（`shutdown` 唯一被允许的入口） |

`shell: "auto"` 按客户端握手时报的 OS 选：Windows 走 `powershell -EncodedCommand`，Linux 走 `sh -c`。所以同一套工具在两种客户机上都不用改参数。

## 配置

在插件行的 `config` 里改（或设环境变量 `TUNNEL_KITS_DIR` 覆盖 `kitsDir`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `24443` | 隧道监听端口 |
| `host` | `0.0.0.0` | 监听地址 |
| `tls` | `true` | 首次启动自签证书，缓存在 `~/.dsh/support-tunnel/` |
| `tlsCert` / `tlsKey` | 空 | 自带 PEM 时指定 |
| `kitsDir` | 空 = `<DSH_HOME>/support-tunnel/kits` | 支持 `~`、相对 DSH_HOME、绝对路径 |
| `basePort` | `40001` | 分配给客户机的本机端口起点 |
| `maxClients` | `20` | 同时在线上限 |
| `publicServer` | 空 | 面板里预填的对外域名 |
| `sshBinary` / `scpBinary` / `sshKeygen` | `ssh.exe` 等 | Host 上调用的 OpenSSH |

## 安全

- 分配的本机端口只监听 `127.0.0.1`，路由器不需要为每台客户机做映射
- 每台一个 `token`，恒定时间比较；`tunnel_list` 不返回 token
- 客户机固定服务端证书指纹（`serverFingerprint`），不符就断开并停止重试
- 工具层的危险命令守卫 18 条，命中不执行，除非显式 `confirm`
- 每次执行、传输、连接都写 JSONL 审计

## 换机器部署

三个地方要一起对齐：kit 里的 `server`、`serverFingerprint`，以及插件的 `kitsDir`。仓库根目录的 `MIGRATE-HOST.md` 和 `retarget-kits.ps1` 覆盖了这件事（带备份和 `-DryRun`）。

最省事的两条路：

- **沿用同一域名**：把 `~/.dsh/support-tunnel/{cert.pem,key.pem}` 拷到新机器，指纹不变，kit 不用改
- **换了域名**：在新机器的设置页重新导出每个 kit，或跑 `retarget-kits.ps1 -Server <新域名>`

## 目录

```
support-tunnel/          插件包（Host + 设置页）
  index.js               apply / normalizeConfig
  client.js              设置页里的配置面板
  lib/server.js          HTTP 服务、会话、端口分配、背压
  lib/protocol.js        帧编解码
  lib/tools.js           工具定义与 ssh/scp 调用
  lib/ui-api.js          设置页用的 HTTP 路由
  lib/guard.js           危险命令守卫
  lib/cert.js            自签证书（手写 DER，无依赖）
support-agent/           客户机客户端 + PyInstaller 打包脚本
make-tunnel-kit.ps1      命令行生成 kit（设置页的等价批量版本）
retarget-kits.ps1        批量改服务端地址/指纹
MIGRATE-HOST.md          换机器部署步骤
TUNNEL-PROTOCOL.md       帧格式、半关闭、背压约定
```

## 已知限制

- 只转发 TCP，不支持 UDP
- 服务端本机端口仍是每台一个（40001+），只是不再需要路由器映射
- 新建连接偶发 10 ms 级抖动（Python 客户端每 stream 两个线程的调度开销），对 SSH 会话可忽略
- 明文模式（`tls: false`）只用于联调
