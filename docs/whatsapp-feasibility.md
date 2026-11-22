# WhatsApp 内置会话 + 聊天记录导入 CRM —— 可行性方案（历史文档，导入入口已移除）

> **更新（2026-10-21）**：两层都已完成。
> 第一层「导出聊天记录 → 解析导入」见 [whatsapp-import.md](whatsapp-import.md)；
> 第二层「内置会话（Baileys，主号直连）」见 [whatsapp-session.md](whatsapp-session.md)。
> 动手前参考了开源项目 [GoodJob](https://github.com/huangguojia/GoodJob) 的 WhatsApp 插件（Apache-2.0），
> 借鉴了戳内顺序无关解析、按天幂等改写、系统消息过滤三点。下文保留原始选型分析。

> 结论先说：**功能可做，而且这个系统改造起来不难；但"最低成本"和"零风险"只能二选一。**
> 技术上唯一能同时做到「内置收发」+「把历史聊天记录导进 CRM」的免费路线，是非官方协议（Baileys），
> 代价是违反 WhatsApp 服务条款、有封号风险。官方 API 从 2026-10-01 起连人工回复都按条收费，
> 而且**根本拿不到历史聊天记录**——这决定了它无法满足你的核心需求。

---

## 一、需求拆成三条

1. **内置 WhatsApp**：在 CRM 里直接看会话、发消息，不用切窗口。
2. **指定导入**：挑某个客户、某段对话，导进该客户的跟进/沟通记录，长期可查。
3. **成本尽可能低**：不买号、不买 BSP 套餐、不租服务器。

第 2 条是真正的难点，也是决定路线的关键：**WhatsApp 的官方接口不给历史消息**。

---

## 二、四条路线对比

| 方案 | 软件费 | 月费 | 能否导入历史记录 | 封号风险 | 改造工作量 |
|---|---|---|---|---|---|
| **A. 导出聊天记录 → CRM 解析导入** | 0 | 0 | ✅ 手动，一次一个会话 | 无 | 约 1 天 |
| **B. CRM 内嵌 WhatsApp Web 窗口（新标签）** | 0 | 0 | 手动（同 A） | 无 | 约 0.5 天 |
| **C. Baileys 非官方协议桥（内置会话）** | 0 | 0 | ✅ 自动同步 + 按需拉取 | 中高 | 3~5 天 |
| **D. WhatsApp Cloud API（官方）** | 0 | 每条消息计费 | ❌ 只有走 API 的消息才有 | 无 | 5~8 天 + 企业认证 |
| **E. Evolution API（自建网关）** | 0 | 0 | ✅ 同 C（底层也是 Baileys） | 中 | 2~3 天 + Docker |

补充说明：

- **A**：手机 WhatsApp 里「聊天 → 更多 → 导出聊天」会生成 `WhatsApp Chat with XXX.txt`（+ 媒体 zip）。
  格式固定为 `[2026/10/21, 09:12] 名字: 内容`，附件是 `<媒体已省略>`。解析成结构化消息完全可行。
- **B**：`web.whatsapp.com` 禁止被 iframe 套用（`X-Frame-Options`），只能新开标签或装成桌面壳，本质上没有"内置"感，但零风险。
- **C**：纯 JS/TS 走 WebSocket 模拟 WhatsApp Web 的"关联设备"，**不需要 Chromium**，`npm i` 即可，完美契合本项目（Node 22 原生、无构建链）。
  官方文档明确支持 `messaging-history.set` 历史同步、`syncFullHistory` 全量历史、`fetchMessageHistory` 按需往回翻——正好对应"指定导入"。
- **D**：Cloud API 只能拿到 **通过 API 收发** 的消息；客户过去在手机 App 里的聊天记录无法调取。
  且 Meta 自 2026-10-01 起把 24 小时窗口内的自由文本回复（service message）也改成按条计费，utility 模板失去窗口内免费资格。
  参考：[Wati 2026 定价解读](https://www.wati.io/en/blog/whatsapp-service-message-pricing/)。
- **E**：Evolution API 功能最全（多账号、webhook、对接 Chatwoot/n8n），但依赖 Docker，Windows 上部署偏重；许可证为非标准（NOASSERTION），商用前要看协议。

开源项目信息（2026-10-21 核对）：

| 项目 | 星数 | 许可证 | 最近提交 | 适配度 |
|---|---|---|---|---|
| [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) | 11.4k | MIT | 2026-10-20 | ★★★★★ 纯 Node，首选 |
| [wwebjs/whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js) | 22.8k | Apache-2.0 | 2026-10-18 | ★★★ 需 Chromium，Windows 装包重 |
| [evolution-foundation/evolution-api](https://github.com/evolution-foundation/evolution-api) | 9.9k | NOASSERTION | 2026-07-14 | ★★★★ 能力全，需 Docker |

---

## 三、推荐方案：分两层落地

### 第一层（先做，零风险，1 天）

**导出导入**——不碰任何协议，纯文件解析：

- 页面：`/whatsapp` → 上传 `.txt`（可带 zip）→ 预览解析结果 → 选客户 → 选时间段/勾选消息 → 导入。
- 写入：一条 `activities`（`type='WhatsApp'`，正文为格式化对话），按天合并或按会话合并，可选把媒体存进 `uploads/wa/`。
- 收益：立刻满足"聊天记录可指定导入 CRM"，且完全合规；也是方案 C 失败时的兜底。

### 第二层（确认要"内置会话"再做，3~5 天）

**Baileys 桥**——真正的系统内聊天：

- `npm i @whiskeysockets/baileys qrcode-terminal`，页面扫码登录（关联设备）。
- 会话列表 + 聊天窗口（Bootstrap 现成样式），支持文本/图片/文件/语音，发送与接收。
- 号码自动匹配：JID `8613800138000@s.whatsapp.net` → 归一化手机号 → 匹配 `customers.whatsapp` / `contacts.mobile`，匹配不上则手动绑定。
- "导入 CRM"按钮：把当前会话的选中消息（或整段）一次性写成该客户的跟进记录，附件落到 `uploads/`。
- 历史：优先 `syncFullHistory` 首次同步；老会话用 `fetchMessageHistory` 按需往前拉。

---

## 四、系统内改造点（对应现有代码）

| 位置 | 改动 |
|---|---|
| `src/db.js` | 新增 4 张表：`wa_chats`、`wa_messages`、`wa_imports`、`wa_accounts`；`activities.type` 增加 `WhatsApp` 选项 |
| `src/wa.js`（新增） | Baileys 连接管理、事件落库、媒体下载、发送 |
| `src/waImport.js`（新增） | 导出文件解析（`.txt`/zip）、消息归一化、写 `activities` |
| `src/routes.js` | `/whatsapp`、`/whatsapp/chat/:jid`、`POST /whatsapp/send`、`POST /whatsapp/import`、`/whatsapp/qr` |
| `src/views/pages_wa.js`（新增） | 会话列表 + 聊天窗 + 导入弹窗 |
| `src/views/layout.js` | `NAV` 增加 `{ href:'/whatsapp', key:'wa', icon:'bi-whatsapp', label:'WhatsApp', section:'客户增长' }` |
| `src/views/pages_core.js` | 客户详情页加"关联 WhatsApp 会话 / 导入聊天"入口 |
| `static/js/wa.js`（新增） | 轮询或 SSE 刷新消息 |

数据模型草案：

```sql
CREATE TABLE wa_chats(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT UNIQUE NOT NULL,          -- 8613800138000@s.whatsapp.net
  phone TEXT,                        -- 归一化号码
  name TEXT,                         -- 推送名/通讯录名
  is_group INTEGER DEFAULT 0,
  customer_id INTEGER,               -- 手动或自动绑定
  last_msg_at TEXT, last_msg_text TEXT, unread INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE wa_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT NOT NULL, msg_id TEXT UNIQUE NOT NULL,
  from_me INTEGER DEFAULT 0, type TEXT,   -- text/image/document/audio…
  text TEXT, media_path TEXT, media_mime TEXT,
  quoted_id TEXT, ts TEXT, raw TEXT
);
CREATE TABLE wa_imports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid TEXT, customer_id INTEGER, activity_id INTEGER,
  msg_count INTEGER, range_from TEXT, range_to TEXT,
  created_by TEXT, created_at TEXT
);
```

---

## 五、风险与对策（必须知情）

| 风险 | 说明 | 对策 |
|---|---|---|
| **封号** | Baileys/Evolution 属非官方协议，违反 WhatsApp 服务条款；被判定滥用会封号，且解封成功率低 | **先用副号/新号跑两周**；主号只"读"不"群发"；不在导入包上做批量营销 |
| 协议变动 | WhatsApp 改协议/风控升级会导致掉线 | 锁定 Baileys 版本，关注 release；做好"掉线→重新扫码"提示 |
| 手机在线 | 关联设备要求手机能联网（长时间离线会失效） | 业务员手机常开；或固定一台工作手机挂这个号 |
| 多人共用一号 | 所有业务员看到同一号码的全部会话，存在串号/隐私问题 | 按 `customers.user_id` 过滤会话可见性；或每人一个号 |
| 媒体占空间 | 图片/语音/文件量大 | `uploads/wa/` 独立目录，定期归档；只下载勾选导入的附件 |
| 合规 | 客户聊天记录含个人信息 | 内网存储、按账号授权、导出留痕 |

---

## 六、成本核算

- **软件**：0 元（MIT 开源）。
- **服务器**：0 元（现有 PC 跑 Node 服务；Baileys 内存占用约 100–300 MB，常驻即可）。
- **号码**：0 元（用现有号或一张副卡，副卡约 10–30 元/月）。
- **隐性成本**：封号损失（这个才是真成本）；Baileys 升级维护约每季度半天。

对比官方 API：企业认证 + 专用号（现有号迁移后手机 App 就不能用了）+ 每条消息 0.005–0.08 美元不等，
按每天 50 条回复 × 26 天 ≈ 1300 条/月，粗算 7–70 美元/月，**且依然导不出历史聊天**。

---

## 七、需要你拍板的三件事

1. **号怎么用**：主号直接接（方便，风险高）／副号先跑（推荐）／只读不发送。
2. **第一层先上吗**：先做"导出导入"（1 天、零风险），跑顺了再决定要不要内置会话。
3. **多人可见性**：一个号全员共用，还是按业务员绑定客户隔离？
