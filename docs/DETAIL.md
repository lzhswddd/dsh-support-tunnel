# 客户机隧道 support-tunnel

把「客户机反向连服务端」从 SSH `-R` 改成一条 HTTP/HTTPS 隧道：客户机主动连出，服务端为每台在回环上开独立端口，`ssh`/`scp` 走这个端口。

## 解决什么

| 旧方案（SSH `-R`） | 本插件 |
| --- | --- |
| 每台客户机占一个映射端口（2222、2223…） | 对外只开一个入口端口（默认 24443） |
| 同一台机器被占住时第二台连不上 | 多台同时在线，按 `kitId` 区分 |
| 换现场要重新试端口 | 只映射 443/24443，企业网放行 HTTPS 出站 |

服务端给每台客户机分配的端口只在 `127.0.0.1` 上监听，所以「端口独占」被限制在本机内部，路由器不需要为每台机器做映射。

## 一次会话长什么样

1. 客户机运行 `support-agent.exe`，读同目录 `support.json`
2. 它向 `https://<服务端>:24443/t/<kitId>` 发一个长连接 `POST`，带 `Authorization: Bearer <token>`，请求体与响应体都是 chunked 帧流
3. 服务端校验 token，分配 `127.0.0.1:40001` 并开始监听
4. 操作者执行 `ssh -p 40001 -i operator_id Administrator@127.0.0.1`
5. 该 TCP 连接变成隧道里的一个 stream（`NEW` → `DATA` ↔ `DATA` → `CLOSE`）
6. 隧道本身不断开，可以继续接新的连接；`sfp`、`scp`、多个 ssh 窗口同时用时靠 `streamId` 区分

## 工具

| 工具 | 作用 |
| --- | --- |
| `tunnel_list` | 列出在线客户机：`kitId`、名称、`clientOs`、本机端口、在线 stream 数、收发字节、可直接复制的 ssh 命令 |
| `tunnel_exec` | 在客户机跑一条命令，返回 `exitCode`/`stdout`/`stderr`/耗时。`shell` 可选 `auto`/`cmd`/`powershell`/`sh`/`bash` |
| `tunnel_upload` / `tunnel_download` | 用 `scp` 穿透隧道收发单个文件 |
| `tunnel_disconnect` | 踢掉一台客户机并释放端口（客户机自己会重连） |
| `tunnel_audit` | 读最近的操作记录：连接、断开、执行、传输、被拦下的命令 |
| `tunnel_reboot` | 重启客户机。这是 `shutdown` 唯一被允许的入口 |

### Windows 与 Linux 客户端

客户端在握手时上报自己是什么系统（`X-Client-OS`），`shell: "auto"` 按这个选：

| 客户端 | `shell: auto` | 说明 |
| --- | --- | --- |
| Windows | `powershell`（`-EncodedCommand`） | 避开引号地狱 |
| Linux / macOS / WSL | `sh` | `sh -c '<command>'`，单引号按 POSIX 规则转义，能穿透 sshd 登录 shell 那一层 |

也可以显式指定 `cmd` / `powershell` / `sh` / `bash`。`cwd` 在两边都是「先 cd 再执行」，
Linux 上用 `cd '<dir>' && <command>`。

**为什么要上报而不是猜**：一台 Windows 主机里可能跑着 WSL，主机名完全一样（都是那台 Windows），
光看 `clientHost` 分不出里面是 Linux。老客户端不上报这个头时服务端一律按 `win` 处理，行为不变。

`tunnel_reboot` 同理：Windows 走 `shutdown /r /t N /f`，Linux 走 `shutdown -r +N`（分钟）。

## 设置页

**设置 → 插件 → 客户机隧道** 有一个配置面板：

- 隧道状态：是否监听、端口、证书指纹（可复制）、`kitsDir`、在线客户机
- 导出客户端配置：填 kit 名（下拉可选已有）+ 对外域名 + 端口 + 登录用户，点一次就写出
  `<kitsDir>/<kit>/client/support.json`，可以复制 JSON 或直接下载
- kit 名不存在时会新建：生成 `kitId`、32 字节 `token` 和 Host 侧的 `operator` 密钥；
  已存在的 kit 只改地址，`kitId` 和 `token` 保持不变（客户机不用重新配对）

面板走 Web GUI 自己的 HTTP 服务（`/api/support-tunnel/state`、`/api/support-tunnel/export`），
只接受回环请求。浏览器那一侧没有能回调 Host 的服务，所以配置和导出都走这条 HTTP 通道，
而不是在页面里伪造一份数据。

## 配置

在插件行里改 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `24443` | 隧道监听端口 |
| `host` | `0.0.0.0` | 监听地址 |
| `tls` | `true` | `false` 时用明文 HTTP（只在阶段一联调时用） |
| `tlsCert` / `tlsKey` | 空 | PEM 路径；空则在 `~/.dsh/support-tunnel/` 生成并复用自签证书 |
| `certName` / `domain` | `support-tunnel` | 写进证书 CN 与 SAN 的名字 |
| `basePort` | `40001` | 分配给客户机的本地端口起点 |
| `maxClients` | `20` | 同时在线上限 |
| `kitsDir` | 空 = `<DSH_HOME>/support-tunnel/kits` | 读 kit 的 token、登录账户、operator 私钥。支持 `~`、相对 DSH_HOME 的路径，环境变量 `TUNNEL_KITS_DIR` 优先级最高 |
| `sshBinary` / `scpBinary` | `ssh.exe` / `scp.exe` | 执行工具时调用的 OpenSSH 客户端 |
| `auditFile` | `~/.dsh/tunnel-audit.jsonl` | 审计日志（JSON Lines） |
| `idleKillMs` | `0` | 空闲多久断开客户机，`0` 表示不断 |

端口被占用不会让插件激活失败：服务照常注册，`tunnel_list` 返回 `listening:false` 和 `error`（例如 `EADDRINUSE`）。

## 证书与指纹

首次启动会在 `~/.dsh/support-tunnel/` 生成 RSA-2048 / SHA-256 自签证书（v3，含 `subjectAltName`、`CA:false`、`serverAuth`）。证书会缓存，不会每次重启都换，否则所有 kit 的指纹都会失效。

`tunnel_list` 的 `fingerprint` 就是客户机 `support.json` 里 `serverFingerprint` 该填的值，格式 `sha256:<base64 无填充>`。指纹不符时客户机拒绝连接并停止重试，等同于 `known_hosts` 的作用。

也可以在服务端直接从证书算：

```powershell
$pem = Get-Content "$env:USERPROFILE\.dsh\support-tunnel\cert.pem" -Raw
$der = [Convert]::FromBase64String(($pem -replace '-----[^-]+-----','' -replace '\s',''))
'sha256:' + [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash($der)).TrimEnd('=')
```

## 和现有 sshd 入口端口的关系

旧方案让 sshd 直接监听公网入口（例如 443 与 24443）接收客户机的反向隧道。本插件要用同一个 24443，所以两者**不能同时占用同一个端口**：

- 先让 sshd 释放该端口：把 `C:\ProgramData\SSH\sshd_config` 里对应那行 `Port 24443`（以及兜底的 `Port 443`）删掉，只留本机 22，然后重启 sshd
- 再让插件接管 24443：重启 DSH 或重新启用插件行
- 存量客户机如果还在跑老 kit，可以先保留 443 给它们，等换完 support-agent 再删

端口仍被占时插件不会崩：`tunnel_list` 会返回 `listening:false` 和 `error: EADDRINUSE: ...`，其余工具照常可见。

## 安全边界

- **只绑回环**：客户机端口 `listen('127.0.0.1', port)`，不对外暴露
- **token 认证**：每台一个 32 字节 hex，服务端从 kit 目录读，恒定时间比较；`tunnel_list` 不返回 token
- **同机重连换旧会话**：会话身份是 `(kitId, clientHost)`，同一台机器重连会踢掉自己的旧会话；
  同一个 U 盘 kit 可以同时服务多台机器，各自占一个本机端口
- **危险命令守卫**：18 条规则（15 条沿用 `dsh_ssh_mcp.py`，另加 `shutdown`、`net user /add`、`reg delete HKLM`）。命中后命令不执行，返回拦截原因；确实要做时带 `confirm=true` 再调一次。环境变量 `OPS_GUARD=off` 可整体关闭
- **审计**：连接、断开、`tunnel_exec`、上传下载、重启、被拦命令都追加一行 JSON

## 限制

1. 服务端本地端口仍是每台一个（40001+），只是不再需要路由器映射
2. 比裸 SSH 多一层封装，延迟增加约 5–15 ms
3. 只转发 TCP，不支持 UDP
4. 大流量靠背压限速，不会把内存吃爆，但单条隧道的吞吐受限于两端各自的 TCP 窗口
5. 客户机侧需要一个 `support-agent` 进程常驻；它断线后按 5 秒起、上限 60 秒的指数退避重连
6. 明文模式（`tls:false`）仅供联调，公网必须开 TLS

## 性能

本机环回实测（64 MiB，明文）：

| 指标 | 裸 TCP | 隧道 | 隧道 + TLS |
| --- | --- | --- | --- |
| 上传 | 800–940 MB/s | 363 MB/s | 298 MB/s |
| 下载 | 700–880 MB/s | 448 MB/s | 283 MB/s |
| 双工 | — | 245 MB/s | 216 MB/s |
| 新建连接 + 首字节 p50 | 0.33 ms | 0.96 ms | 0.98 ms |

协议自身开销约 0.12%（每 60 KiB 一帧，7 字节帧头）。环回数字不代表现场吞吐——公网链路由带宽和 RTT 决定，这个量级的差距不会有感知。

想调大缓冲换吞吐：服务端 `BUFFER_HIGH_WATER` 默认 2 MiB（环境变量 `TUNNEL_HIGH_WATER` 可覆盖），客户机 `STREAM_QUEUE_DEPTH` 默认 64 帧。

## 配套文件

- `support-agent/`：客户机客户端源码、`build.ps1` 打包脚本，以及已经打好的 `dist/support-agent.exe`（8.7 MB，单文件，客户机不需要装 Python）
- `make-tunnel-kit.ps1`：生成带 `support.json`、token、客户端 exe 的 HTTP 隧道版 kit
- `TUNNEL-PROTOCOL.md`：帧格式与握手细节，给后续维护者
