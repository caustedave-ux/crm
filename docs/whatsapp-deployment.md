# WhatsApp 自托管网关：别人怎么部署，我们怎么对齐

> 调研对象（都是目前 GitHub 上最活跃的三个自托管 WhatsApp 网关）：
> [WAHA](https://github.com/devlikeapro/waha) · [Evolution API](https://github.com/evolution-foundation/evolution-api) · [wppconnect-server](https://github.com/wppconnect-team/wppconnect-server)
>
> 结论：它们都把"会话/登录态"当成**需要持久化、可备份、可观测的一等公民**，而不是内存里的临时对象。
> 这正是我们之前栽跟头的地方（登录态丢了要重扫码、进程被杀掉线、出问题只能翻日志）。

## 一、三家的部署形态

| | WAHA | Evolution API | wppconnect-server |
| --- | --- | --- | --- |
| 形态 | 单个 Docker 容器 | 4 个容器：API + 管理前端 + Postgres + Redis | 单个 Docker 容器（内含 Chromium） |
| 会话存储 | 容器内目录 | **volume `/evolution/instances`** | token 目录 + Chromium user-data 目录（可换 Redis） |
| 对外接口 | REST + Swagger + Dashboard | REST + Webhook | REST + Webhook + 管理面板 |
| 鉴权 | API Key | API Key（全局 / 实例级） | `SECRET_KEY`（管理）或 session token（受限） |
| 端口暴露 | `-p 3000:3000` | **只绑 `127.0.0.1:8080`**，靠反代对外 | 21465，`/healthz` 探活 |
| 多账号 | 一个容器多个 session（按 name） | instance 概念，天然多实例 | 多 session |
| 重启策略 | `--rm` / compose restart | `restart: always` | `restart: always` |
| 依赖 | 无（自研 Rust 桥接） | Postgres + Redis | 内置 Chromium |

**三家共有的四个动作**，值得抄：

1. **登录态落到 volume**，容器重建不丢；Evolution 明确把 `instances` 单独挂卷。
2. **`restart: always`** —— 进程崩了自己起来，不靠人盯。
3. **只绑内网**，对外靠 Nginx/Caddy 反代加 TLS + 鉴权（Evolution 直接 `127.0.0.1:8080`）。
4. **健康检查端点**：wppconnect `GET /healthz`、WAHA `/health`、Evolution `/api/health/live|ready`。

## 二、我们的现状 vs 它们

| 维度 | 它们 | 我们（改版前） | 这次是否补上 |
| --- | --- | --- | --- |
| 登录态持久化 | volume | 目录 `data/wa-auth/account-N` | ✅ 本来就有 |
| **登录态备份** | volume 快照/外部备份 | **无** | ✅ **本次新增** |
| 崩溃自动重启 | `restart: always` | 靠 `.bat`，进程死了要手动 | ⚠️ 见第四节 |
| 健康检查 | `/health` `/healthz` | 只有前端状态接口 | ✅ **本次新增 `/api/wa/health`** |
| 优雅退出 | 有 | **无**（Ctrl+C 直接杀） | ✅ **本次新增 SIGINT/SIGTERM** |
| 出网代理 | 各家支持 per-session proxy | 全局代理（自动读系统代理） | 已够用 |
| 重连退避 | 有 | 15s/45s/120s，最多 3 次 | 已对齐 |
| 注册限流 | 部分有 | 3 次/小时、10 次/24h | 已对齐（比它们严） |
| 鉴权 | API Key | 复用 CRM 登录态 | 已够用（内网） |

## 三、这次落地的三件事

### 1. 登录态自动备份 + 自动恢复

Baileys 官方文档明确写着 **`useMultiFileAuthState` 不推荐用于生产**（"there is no guarantee that it's good at session management, and will cause auth errors"）。
自己没有自研 AuthState 的情况下，最实际的兜底就是**多存几份快照**：

- 连接成功后 5 秒，把 `data/wa-auth/account-N/` 整个目录快照到 `data/wa-auth/backups/account-N-<时间戳>/`，**留最近 5 份**
- 正常退出（SIGINT/SIGTERM）时再存一份
- 下次连接时如果发现 `creds.json` 不在，**自动从最近一份快照恢复**，省一次重新扫码

对应代码：`src/wa.js` 里的 `backupAuth / latestAuthBackup / restoreAuthIfMissing`。

> 演练/测试时请用 `CRM_WA_AUTH_DIR` 指到临时目录，别动真实登录态：
> ```powershell
> $env:CRM_WA_AUTH_DIR = 'D:\外贸CRM\tmp-wa-test'
> $env:CRM_WA_LOG      = 'D:\外贸CRM\tmp-wa-test\wa.log'
> ```

### 2. 健康检查 `GET /api/wa/health`

```json
{
  "ok": true, "lib": true, "status": "offline",
  "phone": "8613800138000", "proxy": "http://127.0.0.1:7897",
  "creds": true, "backup": "account-1-20261029103000",
  "sessions": 0, "serverTime": "2026-10-29 10:31:24"
}
```

一眼能看出：依赖装没装、现在什么状态、代理走哪、登录态在不在、有没有备份、内存里有几个会话。
出问题时先打这个，比翻 `server.log` 快。

### 3. 优雅退出

`Ctrl+C` / 关窗口 / `taskkill`（发 SIGTERM）时：

1. 备份登录态
2. 断开所有 socket（`sock.end()`）
3. 关闭 HTTP 服务
4. 退出

避免"creds.json 写了一半被杀 → 下次连 401"这种自己作出来的故障。

## 四、明确没做的，以及为什么

| 想做 | 为什么没做 |
| --- | --- |
| 套 Docker | 用户是单台 Windows 机器，装 Docker Desktop 成本 > 收益；**用 `.bat` + 隐藏进程**已经达到同样效果 |
| 换成 Postgres + Redis | 单机单用户，SQLite 够用；多这俩反而是新的故障点 |
| 自研 AuthState（不走文件） | 工作量大、收益是"更抗并发写入"；我们是单进程低并发，**备份+恢复能覆盖 90% 场景** |
| 加 API Key | 服务本来就在内网、且所有接口都过 CRM 登录态 |
| 多实例/多租户 | 不在需求里 |

## 五、如果要再往前一步

按投入产出排序，后续值得做的三件：

1. **进程存活看护**：写个 `watchdog.ps1`（或任务计划程序）每 5 分钟查 `http://127.0.0.1:5000/api/wa/health`，连不上就重启服务——等价于 Docker 的 `restart: always`。
2. **登录态加密落盘**：GoodJob 用 AES-256-GCM 加密 AuthState；我们目前是明文 `creds.json`。局域网可接受，上公网前必须补。
3. **把 `data/wa-auth/backups/` 纳入日常备份**：现在自动备份的只有数据库（`data/backups/`）。

## 六、一句话总结

别人的部署没什么黑科技，就是四件事：**登录态落盘并可备份、进程挂了能自己起、有健康检查、退出要干净**。
前两件我们已经有了一半，这次把**备份恢复 / 健康检查 / 干净退出**补齐了。
