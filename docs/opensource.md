# 开源选型记录

按 [AGENTS.md](../AGENTS.md) 的约定，每个功能动工前先调研开源实现，这里记一行：需求 → 候选 → 选中项 + 原因 → 改动点。

## 2026-10-21 · WhatsApp 聊天记录导入 CRM（2026-10-30 已移除入口）

**需求**：把客户在 WhatsApp 里的聊天记录指定导入 CRM，成本尽可能低。

**候选**：

| 项目 | 星数 | 许可证 | 最近提交 | 结论 |
| --- | --- | --- | --- | --- |
| [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) | 11.4k | MIT | 2026-10-20 | 内置会话阶段首选：纯 Node/WebSocket，无 Chromium，支持历史同步与按需回溯 |
| [wwebjs/whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js) | 22.8k | Apache-2.0 | 2026-10-18 | 备选：需 Puppeteer/Chromium，Windows 安装重 |
| [evolution-foundation/evolution-api](https://github.com/evolution-foundation/evolution-api) | 9.9k | NOASSERTION | 2026-07-14 | 备选：能力全，但依赖 Docker，许可证非标准 |
| [huangguojia/GoodJob](https://github.com/huangguojia/GoodJob) | 88 | Apache-2.0 | 2026-10-20 | **参考实现**：外贸 CRM + WhatsApp 插件，抄它的解析/幂等/同步思路，不抄代码 |
| WhatsApp Cloud API | — | 官方 | — | 否决：拿不到历史聊天记录；2026-10-01 起连人工回复也按条计费 |

**选中**：第一期不接任何协议，用「导出聊天记录 → 解析导入」（零依赖、零风险、零费用），
实现落在 [src/waImport.js](../src/waImport.js)；第二期若要"系统内聊天"再接 Baileys。

**改动点**：

- 新增 `src/waImport.js`、`src/views/pages_wa.js`、`docs/whatsapp-import.md`、`tools/test-wa-import.js`
- 修改 `src/db.js`（`wa_imports` 表）、`src/routes.js`（3 个路由）、`src/views/layout.js`（导航）、`src/views/pages_core.js`（客户详情入口）
- 借鉴 GoodJob：戳内顺序无关解析、按天幂等改写、系统消息过滤
- 自己加：zip 内 txt 零依赖解包、媒体占位标签、日期顺序手动覆盖、导入台账

**许可证**：本项目只借鉴思路不复制代码；若后续 vendor Baileys，按其 MIT 保留 LICENSE 与来源。

## 2026-10-21 · WhatsApp 内置会话（Baileys 通道）

**需求**：在系统内收发 WhatsApp、按业务员隔离、带中文翻译。

**候选**：Baileys（MIT，纯 Node，无 Chromium）／whatsapp-web.js（Apache-2.0，需 Puppeteer）／Evolution API（需 Docker）。

**选中**：**Baileys 7.0.0-rc14** + `qrcode`（页面出码）+ `https-proxy-agent`/`socks-proxy-agent`（出网代理）。
理由：零额外运行时，直接 `npm i` 就能跑；本项目是单进程 Node，不适合再起一个 Docker 网关。

**改动点**：新增 `src/wa.js`、`docs/whatsapp-session.md`、`tools/test-wa-socket.js`；
`src/views/pages_wa.js` 增加会话页；`src/db.js` 增加 `wa_accounts/wa_chats/wa_messages`；
`server.js` 启动后自动恢复登录。

**踩坑记录**：`syncFullHistory: true` 在 7.0.0-rc14 会被服务器以 428 断开，已关闭；
国内网络必须走代理，已实现系统代理自动识别（本机 127.0.0.1:7897）。

## 2026-10-23 · 物流跟踪（供应商发货 / 客户出货）

**需求**：供应链里记录双向物流，一张运单可含多个客户的货（唛头 + 订单号），到点提醒查进度。

**候选**：

| 项目 | 形态 | 结论 |
| --- | --- | --- |
| [Karrio](https://pypi.org/project/karrio-server/) | 自托管统一物流 API（Python） | 否决：要独立服务 + 各家承运商密钥，对单机内网 CRM 太重 |
| [ts-shipment-tracking](https://github.com/0xA-10/ts-shipment-tracking) | TS 库，FedEx/UPS/USPS | 否决：覆盖窄、需 API key |
| 17TRACK / 快递100 | 商业查询 API | 暂不接：按查询计费，且需要配额与重试机制 |
| GoodJob `shipment-ocr.ts` / `tracking-provider.ts` | 参考实现 | 参考了"运单 + 分票 + 轨迹"的拆分方式 |

**选中**：自建台账（运单 / 分票 / 轨迹三张表）+ 页面内到点提醒；查询动作留给业务员（复制单号 / 跳 17TRACK），**不引入任何外部依赖**。

**改动点**：新增 `src/logistics.js`、`src/views/pages_logistics.js`、`docs/logistics.md`；改 `src/db.js`（三张表）、`src/routes.js`（7 个路由）、`src/views/layout.js`（菜单 + 角标）、`src/views/pages_core.js`（仪表盘提醒卡片）、`src/web.js`（同名字段自动收成数组，支持分票多行提交）。

**后续可加**：等真觉得手动查烦了，在 `src/logistics.js` 里加 `fetchTracking(carrier, waybill)` 适配 17TRACK，表结构不用动。

## 2026-10-30 · WhatsApp 收件箱对标优化

**需求**：把现有单窗口 WhatsApp 聊天升级为更接近主流 CRM 的共享收件箱体验，同时保持单进程 Node + SQLite、局域网部署和客户账号隔离。

**GitHub 候选（调研时数据）**：

| 项目 | 星数 | 许可证 | 可借鉴能力 | 结论 |
| --- | ---: | --- | --- | --- |
| [Chatwoot](https://github.com/chatwoot/chatwoot) | 38.6k | MIT | 共享收件箱、会话状态、联系人侧栏、快捷回复 | 产品模型参考；不引入其 Rails/PostgreSQL/Redis 运维栈 |
| [WAHA](https://github.com/devlikeapro/waha) | 7.7k | Apache-2.0 | 会话健康检查、登录态恢复、失败保护 | 运维思路参考；继续使用现有 Baileys 通道 |
| [DeskcommCRM](https://github.com/melgarafael/DeskcommCRM) | 4.9k | MIT | WhatsApp + AI 销售回复、客户上下文 | AI 草稿流程参考；不复制代码 |
| [wacrm](https://github.com/ArnasDon/wacrm) | 2.6k | MIT | 联系人、销售漏斗、AI 回复、消息收件箱 | 三栏收件箱与客户绑定思路参考 |
| [Evolution API](https://github.com/evolution-foundation/evolution-api) | 约 10k | NOASSERTION | 多实例 WhatsApp 网关 | 否决：许可证不清晰且需要额外 Docker 服务 |

**选中**：保留当前 `@whiskeysockets/baileys`（MIT），在其上增量实现收件箱，不替换数据库或部署方式。只借鉴产品能力与可靠性模式，没有复制上述项目代码。

**本次改动**：

- 三栏收件箱、未读/待绑定筛选、会话与客户搜索；
- 客户自动绑定增加账号隔离，仅匹配本人私有客户或公共池；
- 一键新建客户、快捷回复、DeepSeek 回复草稿（人工发送）；
- 图片/视频/语音/文件收发、媒体预览、20MB 上限；
- 按天幂等同步跟进，保留手工记录；
- 未读角标、自动恢复、健康检查和回归测试。


## 2026-10-30 · WhatsApp 收件可靠性修复

**问题**：页面显示在线，但普通客户消息没有落入 CRM；日志出现 `Invalid PreKey ID`、`No session found to decrypt message`。旧版 6.7.24 还存在连接约 60 秒后 `init queries` 超时。

**处理**：

- 升级到 `@whiskeysockets/baileys@7.0.0-rc14`，重新验证 MIT 许可与现有 Node/SQLite 架构兼容；
- 区分“WebSocket 在线”和“消息可解密”：健康检查新增 `receiveState`、`decryptFailures`、事件计数和最后客户来信时间；
- 离线补发的客户消息也计入未读并同步跟进；
- 在线状态移除容易触发手机重复同步提示的“重新连接”按钮；
- 会话损坏时先归档 Signal 会话缓存重建，仍失败才重新扫码，避免反复注册设备。

**数据安全**：修复前完整备份 `data/wa-auth/account-1`；CRM 数据库、客户、产品、跟进和聊天记录均未删除。


## 2026-10-30 · WhatsApp 媒体下载与多语言翻译

**需求**：修复 WhatsApp 图片/附件无法显示或打开；翻译点击后页面不刷新；增加 AI 中译英、法、阿拉伯、西班牙、俄语。

**候选/选中**：
- [undici](https://github.com/nodejs/undici)（MIT）：Node 官方同源的 fetch 实现。现有 Baileys 媒体下载使用 fetch dispatcher，普通 https 代理 Agent 不生效；选用其 `ProxyAgent` 让媒体下载复用现有 HTTP 代理。
- DeepSeek Chat API：继续沿用系统设置中已配置的服务，不新增第三方翻译服务。

**改动点**：
- `src/wa.js`：媒体下载接入 undici ProxyAgent；历史同步时补下载最多 12 个缺失媒体；翻译目标语言参数化。
- `src/web.js`：上传文件支持 Range 请求、补全音视频/Office/ZIP MIME，改善在线播放和文件打开。
- `src/routes.js`、`src/views/pages_wa.js`：单条消息翻译改 Ajax；AI 起草区增加五种目标语言的输入框翻译。

## 2026-10-30 · WhatsApp 原生引用图片/文件

**需求**：会话中可引用文本、图片、文件及其他消息，并以 WhatsApp 原生“回复”形式发送。

**候选/选中**：继续使用现有 `@whiskeysockets/baileys`（MIT），通过其 `sendMessage(..., { quoted })` 原生能力实现；不自行拼接协议消息，也不新增依赖。

**改动点**：
- `src/wa.js`：保存被引用消息 ID、发送者 JID 和预览；从 CRM 历史消息还原 Baileys `quoted` 对象；文本和附件发送均支持引用。
- `src/routes.js`：校验被引用消息属于当前账号和当前会话后才允许发送。
- `src/views/pages_wa.js` 与 `static/css/style.css`：每条消息增加“引用”按钮、输入框引用预览、取消引用和消息气泡内引用卡片。
- `tools/test-wa-inbox.js`：增加图片、文件、文本引用的数据库与还原测试，不实际向客户发送消息。
## 2026-10-30 · WhatsApp 输入框粘贴图片

**需求**：从截图工具、网页或文件管理器复制图片后，直接在 WhatsApp 会话输入框按 `Ctrl+V` 添加为待发送附件。

**选型**：使用浏览器原生 `ClipboardEvent`、`File`、`DataTransfer` 和 `URL.createObjectURL`，不引入第三方剪贴板库。原因是现有系统无前端构建链，现代 Chrome/Edge 已原生支持，且避免额外权限与供应链依赖。

**改动点**：
- `src/views/pages_wa.js`：拦截输入框粘贴事件，将剪贴板图片转为发送附件；增加图片缩略图、文件名、大小、移除按钮及 20MB 前端校验。
- `static/css/style.css`：增加待发送附件预览样式。
- `tools/test-wa-inbox.js`：增加粘贴入口、预览区和发送表单字段的页面回归断言。
## 2026-10-30 · WhatsApp 引用图片打开原图

**需求**：消息气泡中被引用的图片应支持点击，并在新窗口打开原图。

**选型**：使用浏览器原生 `<a target="_blank" rel="noopener">`，不引入灯箱或预览依赖；同时补查最近 500 条消息之外被引用的原消息，使旧消息也能保留原图入口。

**改动点**：
- `src/views/pages_wa.js`：引用图片/附件卡片改为新窗口链接；消息索引补查引用目标记录。
- `static/css/style.css`：增加引用链接悬停与键盘焦点样式。
- `tools/test-wa-inbox.js`：验证引用卡片包含原图链接、`target="_blank"` 和安全属性。

## 2026-10-31 · WhatsApp 多附件选择与逐份发送

**需求**：WhatsApp 会话附件选择器支持一次选择多个文件，也支持一次粘贴多张图片；发送前可逐个移除或全部移除。

**选型/许可**：使用浏览器原生 `FileList`、`DataTransfer`、`ClipboardEvent`、`URL.createObjectURL` 与 `FormData`，不新增第三方依赖，避免引入来源不明的上传组件。前端单次最多 10 个附件、单个文件最大 20MB；后端仍沿用现有 Baileys（MIT）发送链路和 20MB 媒体限制。

**兼容设计**：每份附件单独提交到现有 `/whatsapp/send`，不在一个请求中拼接多个文件，从而保持服务端请求体上限与 WhatsApp 发送节流不变。附件按顺序发送，间隔 1.6 秒；文字和引用关系随第一份附件发送。中途失败时只保留未发送附件，避免重复发送已经成功的文件。

**改动点**：
- `src/views/pages_wa.js`：多文件选择、批量粘贴、附件队列、逐项移除、发送进度和断点重试。
- `static/css/style.css`：多附件预览列表、缩略图、滚动区域和移除按钮样式。
- `tools/test-wa-inbox.js`：覆盖多选入口、附件队列、批量粘贴、逐项移除与逐份发送逻辑。

## 2026-10-31 · WhatsApp 会话切换滚动位置保持

**问题**：点击左侧会话后 AJAX 会替换整个 `#waInbox`，旧节点上的 `.wa-chat-list` 滚动位置随之丢失，导致当前点击会话跳出可视区域；页面滚动位置也可能被浏览器滚动锚定改变。

**方案**：继续使用原生 DOM、History API 和 `requestAnimationFrame`，不新增依赖。刷新前保存页面滚动、会话列表滚动和聊天消息滚动位置，替换后恢复；并自动校正当前会话在列表中的可见区域。聊天内容按轮询刷新时，若用户原本处于底部则继续跟随最新消息，若正在查看历史则保持原阅读位置。

**改动点**：
- `src/views/pages_wa.js`：新增滚动状态捕获、恢复和当前会话可见性校正。
- `tools/test-wa-inbox.js`：增加滚动保持逻辑回归断言。

## 2026-11-02 · WhatsApp 解密失败误报修正

**问题**：`Message absent from node` 出现在关联设备历史同步副本中时，旧逻辑会把任意 CIPHERTEXT stub 都计入解密失败，并在页面上提示用户退出登录重新扫码；但数据库同期仍持续收到客户消息，说明连接并未失效。

**方案**：继续使用现有 Baileys（MIT）事件模型，不新增依赖。解密失败只统计实时 `notify` 事件中的非本人客户消息，排除状态动态、历史同步副本和自身 LID/PN 副本。红色“退出登录并修复”提示仅在“在线、存在失败且本次连接成功接收数为 0”时显示；已经收到消息时只显示非阻断说明，不再建议重新扫码。

**改动点**：
- `src/wa.js`：收紧解密失败计数来源。
- `src/views/pages_wa.js`：区分真实接收中断与单条/历史副本异常。
- `tools/test-wa-inbox.js`：增加误报分级回归断言。
## 2026-11-05 · WhatsApp 会话置顶

**需求**：重要但暂时回不了的会话先置顶，稍后处理；置顶后不能被新消息冲走。

**候选/选型**：属于收件箱核心交互，不需要新库。参考 Chatwoot（MIT）的「置顶会话」交互——置顶项独立排序、列表内有可见标记；不引入其 Rails 栈。实现沿用现有 SQLite + 服务端渲染 + 原生表单，零依赖。

**改动点**：
- `src/db.js`：`wa_chats` 增加 `pinned_at`（空字符串 = 未置顶），走 `ensureColumn` 幂等迁移。
- `src/routes.js`：新增 `POST /whatsapp/chat/:id/pin`，按 `visibleChat` 校验归属，支持 `back` 回跳且只允许站内 `/whatsapp/session` 路径。
- `src/views/pages_wa.js`：列表排序改为置顶优先；行尾增加置顶开关，会话头部增加“置顶/已置顶”按钮；新增“置顶 N”筛选；非搜索状态下置顶会话在各筛选中始终保留。
- `static/css/style.css`：置顶行左侧强调条、行尾置顶按钮与置顶筛选样式。
- `tools/test-wa-inbox.js`：新增置顶写入、排序、筛选、取消置顶和路由注册断言。

## 2026-11-11 · FOEVE 独立站询盘接入

**需求**：官网询盘安全写入 HQ CRM，自动建客户、建联系人和询盘跟进；新客户默认进入公共客户池；在 CRM 新增“独立站询盘”列表与详情页，销售自行选择 Email 或 WhatsApp 回复。

**候选/选型**：

| 方案 | 许可证/依赖 | 结论 |
| --- | --- | --- |
| Cloudflare Worker + D1 + 签名转发 | Cloudflare 托管 | 网站侧采用；Worker 负责 Turnstile、outbox 和重试 |
| 现成 CRM 询盘插件 | 多为 SaaS 或重框架 | 否决：无法直接接入现有 `node:sqlite` 数据模型 |
| Node.js 内置 `crypto` + 自研签名路由 | Node 内置，零新增依赖 | 选用：与现有原生 `http` 路由和 SQLite 完全兼容 |
| 第三方 HMAC / 表单库 | 额外依赖 | 否决：需求可由内置 `crypto` 完成，避免增加攻击面和安装成本 |

**选中**：在 HQ CRM 内新增独立模块 `src/websiteInquiry.js`，使用 HMAC-SHA256 签名、5 分钟时间戳窗口、幂等键和事务写入；不引入任何新的 npm 依赖。

**改动点**：

- `src/db.js`：新增 `website_inquiries` 表及创建时间、客户关联索引。
- `src/websiteInquiry.js`：签名校验、字段归一化、客户复用、联系人/跟进/询盘台账事务写入。
- `src/routes.js`：新增 `POST /api/public/website-inquiry`、`GET /inquiries`、`GET /inquiries/:id`；领取时转交网站询盘跟进。
- `server.js`：仅放行该 POST 公共接口，其他页面和 API 继续要求登录。
- `src/web.js`：保留 JSON 原始请求体供 HMAC 校验，不重新序列化。
- `src/views/layout.js`：客户增长分组新增“独立站询盘”菜单及公共池角标。
- `src/views/pages_core.js`：新增询盘列表、详情、公共池状态、UTM 与 Email / WhatsApp 回复入口。
- `tools/test-website-inquiry.js`、`tools/check-routes.js`：新增接口集成测试与询盘详情路由检查。

## 2026-11-11 · 客户 A/B/C/D 贡献值分层

**需求**：按客户贡献值分为 A/B/C/D 四档；A 类每周固定沟通，B 类每月发送定制化行业简报，C 类进入系统群发，D 类停止主动联系但保留历史数据。

**候选与许可证**：

| 方案 | 许可证/技术栈 | 结论 |
| --- | --- | --- |
| Mautic | GPL-3.0，PHP/MySQL 营销自动化 | 否决：功能完整但需要独立 PHP 服务，和现有 Node + SQLite 数据模型重复 |
| EspoCRM | GPL-3.0，PHP/MySQL CRM | 否决：整站替换成本高，无法直接复用现有客户、收款、PI 和 WhatsApp 数据 |
| SuiteCRM | AGPL-3.0，PHP/MySQL CRM | 否决：部署和二次开发过重，许可证也不适合直接嵌入 |
| GitHub/npm 的 customer segmentation / lead scoring 包 | 搜索结果多为文本分词、演示项目或 SaaS SDK | 否决：没有与现有 SQLite 字段和 A/B/C/D 周期动作匹配的成熟无构建组件 |

**选中**：沿用现有 Node.js 原生路由、SQLite 和 Bootstrap 5，自研轻量规则引擎 `src/customerTiers.js`，零新增依赖。贡献值以近 12 个月实际收款为主，不使用未付款 PI 金额；支持人工覆盖、禁联标记、A 周任务/B 月任务唯一周期键和 C 类限速群发。

**改动点**：

- `src/db.js`：客户增加分层、分数、原因、人工覆盖、禁联字段；新增 `tier_actions` 周期动作台账和 `tier_campaigns` 群发审计表。
- `src/customerTiers.js`：贡献值计算、A/B/C/D 判定、汇率折算、A 周任务/B 月任务去重、人工覆盖和 C 类群发受众过滤。
- `src/views/pages_tiers.js`：客户分层工作台、分层规则、人工调整、分页筛选、C 类群发与最近群发记录。
- `src/views/pages_core.js`、`src/views/ui.js`、`src/views/layout.js`：仪表盘分层摘要、客户列表分层筛选/贡献值、客户详情分层依据、跟进中心分层标签与优先排序、侧栏入口。
- `src/routes.js`：分层重算、人工覆盖、C 类群发、跟进完成后同步周期动作状态。
- `server.js`：启动和每小时检查 A/B 周期动作。
- `tools/test-customer-tiers.js`、`package.json`：新增分层单元/集成测试。

## 2026-11-11 · B 类客户月度行业简报

**需求**：B 类潜力客户每月收到定制化行业简报；素材必须有出处，AI 不得编造数据，发送前必须人工审核，并与现有 B 类周期跟进闭环。

**候选与许可证**：

| 方案 | 许可证/技术栈 | 结论 |
| --- | --- | --- |
| `kevinho/clawfeed` | MIT，AI RSS/Twitter digest、独立 Web 应用 | 架构可参考；不直接嵌入，避免引入其独立数据库与前端运行时 |
| `giftedunicorn/ai-news-bot` | GPL-3.0，Python/Claude/DeepSeek | 否决：GPL-3.0 与现有私有 CRM 兼容成本高，技术栈不同 |
| `run-llama/newsletter-generator` | MIT，实验性 newsletter 生成 | 只作流程参考，未形成可直接复用的 Node + SQLite 组件 |
| `rss-parser` | MIT，Node.js | 选用：与现有原生 Node 服务兼容，只负责解析 RSS/Atom |
| Google News / Bing News RSS | 商业使用限制 | 否决作为系统默认来源，避免条款与再分发风险 |

**选中**：使用 MIT 的 `rss-parser` 解析用户维护的官方 RSS/Atom，复用现有 DeepSeek 与 WhatsApp；新增来源白名单、素材快照、B 类月度草稿、人工审核、防重复发送和跟进自动闭环。

**改动点**：

- `src/db.js`：新增 `briefing_sources`、`briefings` 表。
- `src/briefings.js`：素材源安全管理、SSRF 防护、RSS 抓取、相关性排序、DeepSeek 结构化生成、草稿保存、WhatsApp 发送与跟进状态同步。
- `src/views/pages_briefings.js`：简报工作台、素材源管理、正文预览/编辑、复制与邮件客户端发送。
- `src/routes.js`、`src/views/layout.js`、`src/views/pages_core.js`、`src/views/pages_tiers.js`：入口与路由。
- `tools/test-briefings.js`：临时数据库集成测试，覆盖 B 类限制、素材引用、草稿、发送、防重复和原跟进保留。
- `docs/industry-briefings.md`：构建与运维说明。

## 2026-11-12 · WhatsApp 阿拉伯语方言短消息翻译修复

**问题**：摩洛哥阿拉伯语口语如 `تمن.ءخي`、`لا.ياءخي` 被单条翻译模型误判为“无法识别”，并把拒答结果缓存成译文。

**修复**：

- `src/wa.js`：翻译请求增加最近 6 条对话上下文；明确支持阿拉伯语方言、法语/英语混写、句点分词和拼写变体。
- 翻译提示禁止因文本过短、口语或疑似无意义而拒答；无法完全确定时给最可能译文并标记“词义不确定”。
- 新增拒答识别与自动重试；仍无有效译文时返回错误，不再把拒答写入 `wa_messages.translated`。
- `tools/test-wa-inbox.js`：增加正常译文与旧拒答文本的识别测试。
- 已修正三条历史错误译文。

## 2026-11-14 · PI 添加同款产品自动带出客户上次卖价

**需求**：新建 PI 时，如果当前客户以前买过同一产品，添加该产品后立即显示上一次卖价和来源单据。

**实现规则**：

- 只查询当前账号、当前客户、当前产品的历史 PI / 销售合同 / 商业发票。
- 忽略草稿和已作废单据，按单据日期倒序查找最近一次非零单价。
- 同一张单据有多个同款明细时，以最后一个价格为“上次卖价”。
- 仅在当前单据币种与历史币种一致时自动填入；币种不同只显示提示，由用户确认“填入”。
- 自动价只填入原本为空的单价；用户已经手工输入或修改后，历史价不会覆盖。
- 单据页面显示来源单号和日期，悬停可查看完整来源信息；手工修改后保留历史价提示。
- `/api/customers/:id/last-price` 提供客户级产品历史卖价查询，避免跨客户串价。
- `tools/test-doc-last-price.js` 覆盖最近单据选择、草稿排除、客户隔离、型号回退和前端防覆盖检查。

## 2026-11-14 · WhatsApp Click-to-WhatsApp 广告来源归因

**需求**：客户通过 Meta WhatsApp 广告进入时，需要知道具体是哪一条广告，并把来源保留到会话和客户档案。

**实现**：

- `src/wa.js`：读取 Baileys `contextInfo.externalAdReply`，保存 `sourceId`、`sourceUrl`、`ctwaClid`、`ref`、标题、正文、媒体和原始归因快照。
- 首次广告来源写入 `wa_messages`、`wa_chats` 和 `customers`；同一客户后续点击新广告不覆盖首次来源，只更新最近广告触达时间。
- 客户自动匹配、手动绑定或从 WhatsApp 新建客户时，广告首触信息自动写入客户档案。
- `wa_ad_sources`：按账号和广告 ID 保存业务易读名称、广告系列、广告组和备注，同一广告 ID 的其他客户统一显示。
- `src/views/pages_wa.js`：会话广告条显示广告名称、广告 ID、广告系列、广告组、`ref`、首次进入时间、落地页与复制 ID 操作。
- `src/views/pages_core.js`：客户档案显示广告客户标记和完整首触来源。
- `tools/test-wa-inbox.js`：新增广告回传提取、三层落库、首触保护、自动绑定客户和广告名称映射接口测试。
- `docs/whatsapp-ad-attribution.md`：归因字段、规则和使用说明。

## 2026-11-16 · WhatsApp 聊天输入框布局修复

- WhatsApp 页面增加自动回复总开关后，原有固定高度 `calc(100vh - 330px)` 失效，聊天输入框可能落到可视区外。
- 普通模式改为纵向 Flex 自适应：顶部标题、连接设置和总开关固定，三栏聊天区占满剩余高度。
- 连接与代理设置默认折叠，展开时限制高度并内部滚动。
- 聊天中间内容支持滚动，输入框使用 `position:sticky` 固定在聊天卡片底部。
- 铺满网页模式隐藏连接设置与总开关，三栏区域直接占满剩余窗口高度。
- 已在 1440×900 和 1366×768 下验证普通、展开设置、铺满三种状态，输入框均完整可见。

## 2026-11-16 · 仪表盘每日自动回复总结

- 新增 `src/autoReplyStats.js`，只读打开 `auto-reply/state.db`，按本地日期汇总今日自动回复数据。
- 仪表盘新增“每日自动回复总结”面板：
  - 今日覆盖客户、发送批次、消息数、文件/图片数；
  - 资格追问、待补充信息、转人工、跳过、错误；
  - 精准/待追问/人工复核/放弃及 AI 高/存疑/低分布；
  - 自动回复批次、客户、素材包、文件四项每日额度进度；
  - 最近 10 条动作及结果原因。
- 面板同时显示自动回复总开关和 worker 运行状态，并提供 WhatsApp 快捷入口。
- 使用真实今日数据验证：3 个客户、3 条资格追问、0 个文件、跳过/冷却数据均正确显示。

## 2026-11-19 · WhatsApp 未读会话优先排序

**需求**：WhatsApp 新到未读消息后，对应会话需要自动跳到列表最前面，方便优先处理。

**候选/选型**：参考 Chatwoot（MIT）的收件箱优先级模型——未读为第一排序信号，其次按最后消息时间倒序；不引入 Chatwoot 的 Rails 服务，继续使用现有 SQLite + 服务端渲染，零新增依赖。

**落地**：
- `src/views/pages_wa.js`：新增确定性会话比较器；普通会话先按是否未读分组，再按最后消息时间倒序；SQL 预排序同步采用未读优先，避免 300 条截断前遗漏旧未读会话。
- 置顶会话继续单独分组，现有“置顶不在全部栏重复显示”和自动回复置顶拦截规则不变。
- `tools/test-wa-inbox.js`：新增未读排序回归断言。

## 2026-11-20 · WhatsApp 客户侧栏下次跟进展示修正

**需求**：存在逾期任务和较新的未来计划时，客户侧栏“下次跟进”应展示最近的未来计划；逾期任务仍保留在跟进中心，不覆盖或删除历史任务。

**候选/选型**：参考成熟 CRM 将 overdue task 与 next scheduled task 分开呈现的收件箱语义；该修正仅为现有 SQLite 查询排序，无需引入依赖或移植完整开源系统。

**改动**：
- `src/views/pages_wa.js`：排序时先选未来日期，再选最近未来日期；没有未来日期时回退显示最早逾期任务。
- `tools/test-wa-inbox.js`：验证未来计划优先展示且逾期记录仍在页面/数据中。

## 2026-11-20 · WhatsApp 客户侧栏快速查看单据

**需求**：在 WhatsApp 客户与跟进侧栏中显示客户单据，替换自动同步规则说明，便于销售直接打开单据。

**候选/选型**：沿用当前系统 Bootstrap/服务端渲染与已有单据详情页链接；该侧栏属于局部 CRM 上下文，无需额外组件库或依赖。

**改动**：`src/views/pages_wa.js` 按当前用户和已绑定客户查询最近 8 张非采购单据，展示编号、类型、日期、状态、币种和金额并链接到详情页；无数据时显示空状态。`static/css/style.css` 增加紧凑单据列表样式；`tools/test-wa-inbox.js` 覆盖客户范围、详情链接与旧提示移除。

## 2026-11-20 · WhatsApp 未读筛选排除置顶会话

**需求**：未读列表不展示已置顶会话，置顶列表和其他筛选规则保持不变。

**候选/选型**：沿用现有收件箱筛选模式，无需引入新组件或依赖；未读视图只渲染未读且未置顶会话，避免通用置顶分组逻辑重新插入置顶项。

**改动**：`src/views/pages_wa.js` 在未读过滤阶段排除置顶会话，并跳过未读视图的置顶补回逻辑；`tools/test-wa-inbox.js` 验证置顶未读排除且普通未读保留。

## 2026-11-19 · CRM 数据助理切换为 Codex

**需求**：将 CRM 数据问答从 DeepSeek 切换为 Codex，同时保留 WhatsApp 草稿、翻译和行业简报使用的 DeepSeek 配置。

**候选/选型**：采用 OpenAI Codex CLI（Apache-2.0），本机已有 CLI，可用 `codex exec` 非交互执行；该命令支持临时会话与只读沙箱。未新增 npm 依赖，不把 coding agent 的工作目录指向 CRM 项目。

**落地**：
- `src/codexAssistant.js`：封装限流、问题/上下文长度限制、临时隔离工作目录、只读执行、超时和临时文件清理。
- `src/routes.js`、`src/views/pages_ai.js`、`src/views/layout.js`：数据助理改走 Codex CLI，页面说明当前账号数据范围和 CLI 计费边界。
- `src/views/pages_docs.js`：保留 DeepSeek Key 设置供其他 AI 工作流使用，并明确其用途不包含 Codex 助理。
- `tools/test-codex-assistant.js`：验证提示词约束、只读参数、回答提取与临时目录清理。

## 2026-11-20 · WhatsApp 翻译改为谷歌免费机翻

**需求**：翻译不再依赖 DeepSeek Key/额度，改为谷歌免费机翻，不接需要 Key 的翻译 API。

**候选（2026-11-20 调研）**：

| 方案 | 许可/形态 | 结论 |
| --- | --- | --- |
| Google Cloud Translation API | 官方，需 Key，按字符计费 | 否决：用户明确不要接 API/不要付费 |
| [@vitalets/google-translate-api](https://github.com/vitalets/google-translate-api) | MIT，Node 库 | 只作参考：确认 `client=gtx` 免费端点、单次约 5000 字上限、429 限流；不引入依赖，避免 TKK 提取失效和额外传递依赖 |
| `translate.googleapis.com/translate_a/single?client=gtx` | 谷歌翻译网页端免费端点，无 Key | **选中**：一次 GET 返回 JSON，现有 `undici` ProxyAgent 可直接复用，零新增依赖 |

**改动点**：

- `src/wa.js`：`callTranslate` 从 DeepSeek Chat API 切换到谷歌免费端点（主 + 备），保留原接口签名和译文存储；复用 WhatsApp 出网代理，增加内存缓存、限流提示和错误明确返回。
- `src/routes.js`、`src/views/pages_wa.js`、`src/views/pages_docs.js`：文案改为「谷歌翻译」，说明不再需要 DeepSeek Key。
- `docs/whatsapp-session.md`、`tools/test-wa-inbox.js`：更新使用说明与无网络自测。

**限制**：该端点非官方，谷歌可能限流或变更；已做主备切换和失败提示，重要商务数字仍以原文为准。

## 2026-11-20 · 获客系统借鉴 GoodJob CRM 改造

**需求**：参考 GitHub GoodJob CRM 的获客系统改造独立的 `lead-gen/`，主系统零改动。

**候选与许可证**：`huangguojia/GoodJob`（约 215★，Apache-2.0，Node/TypeScript + 本地库）作为主要参考；theHarvester（GPL-2.0）、google-maps-scraper（MIT 但强依赖 Google/代理）否决。详见 `lead-gen/docs/opensource.md`。

**选中思路**：只借鉴 GoodJob 的「Provider 开关 → 候选清洗 → 人工审批 → 线索」闭环与可解释加权评分，不复制代码，不引入 MySQL/Redis/海外 API。

**改动点**（全部在 `lead-gen/`）：新增审批阶段与工作流、联系方式证据化、可解释推荐分、Provider 开关、按审批状态导出；引擎版本 1.2.0。`npm test` 44 项通过，页面/接口/xlsx 冒烟全通过，旧库幂等迁移已验证。

## 2026-11-20 · 获客系统接入主 CRM

**需求**：用户明确改变原约定，要求把独立获客系统接入主 CRM：侧栏加入口 + 随主系统自动启动；不做页面内嵌、不做线索转客户数据打通。

**实现方式**（零新依赖）：
- 新增 `src/leadgen-bridge.js`：用 `net` 探测 5101 端口是否已监听，未在线则 `child_process.spawn` 以 `detached` 方式拉起 `lead-gen/server.js`（工作目录指向 `lead-gen/`，日志写 `lead-gen/autostart.log`），并轮询最多约 4 秒确认就绪；`targetFromReq` 按访问请求的 Host 头替换端口为 5101，支持 IPv4 / IPv6，保证局域网客户端跳到同一台主机。
- `src/views/layout.js`：客户增长分组新增「获客核验」入口（`bi-funnel`），`target="_blank"` 新标签打开，不影响当前 CRM 页面；`NAV` 支持可选 `target` 字段。
- `src/routes.js`：新增受登录保护的 `GET /leadgen`，确保服务在线后 302 跳转到 `http://<同主机>:5101`；服务不可用时给出明确报错页，可重试。
- `server.js`：主服务监听成功后异步调用 `ensureLeadGen()`，非阻塞，不改任何 bat 脚本。

**验证**：`npm run check` 78 条路由全过（含 `/leadgen` 302）；单进程内确认桥接可拉起服务、局域网/IPv6 跳转地址正确；端到端确认未登录访问被拦到 `/login`、已登录跳转到 `http://192.168.1.10:5101`。

**注意**：获客系统仍是独立进程与独立库 `lead-gen/data/leads.db`。需重启主系统才会加载新代码并触发自动拉起。

## 2026-11-20 · 获客页共用主 CRM 登录

**需求**：用户要求获客页也共用 CRM 登录，避免 5101 无鉴权裸奔。

**实现方式**（零新依赖，不写主库）：
- 关键事实：浏览器 Cookie 不区分端口，主系统在 5000 设置的 `crm_sid` 访问 5101 时自动带上。
- 新增 `lead-gen/src/crmAuth.js`：以 `readOnly` 打开主库 `data/crm.db`（WAL 模式并发读安全），按 `crm_sid` 查 `sessions JOIN users` 校验 `expires_at>=now AND active=1`，返回登录用户；`loginUrl` 按请求 Host 拼出主系统登录地址（支持 IPv4/IPv6，`CRM_PORT` 可配，默认 5000）。
- `lead-gen/server.js`：`createApp` 传入 `before` 钩子，静态资源放行，其余页面/API 要求登录；未登录 GET 跳 `http://<同主机>:5000/login?next=/leadgen`，未登录 API 返回 401。
- `lead-gen/src/web.js`：用 `AsyncLocalStorage` 暴露 `getRequestContext()`，视图层无需逐层透传即可读取当前用户；`createApp` 用 `ALS.run` 包裹路由处理。
- `lead-gen/src/views.js`：顶栏显示当前登录用户与角色；「主系统」返回按钮改为指向主系统 5000 的 `/dashboard`（原 `/dashboard` 在 5101 上是死链）。
- `src/leadgen-bridge.js`：拉起获客子进程时下发 `CRM_PORT`，多端口部署也能跳对。

**登录闭环**：主系统侧栏「获客核验」→ `/leadgen`（受 CRM 登录保护）→ 302 到 `http://<同主机>:5101`（cookie 自动带上）→ 获客 `before` 校验 `crm_sid` 通过。直接访问 5101 未登录则跳回主系统登录页，登录后 `next=/leadgen` 回到入口。

**验证**：端到端确认未登录访问跳 `http://192.168.1.10:5000/login?next=/leadgen`、有效 cookie 返回 200 且页面含用户名、无效 cookie 被拒；主系统 `npm run check` 78 条与获客 `npm test` 12 项全过。

## 2026-11-21 · AI 外贸工作台（首版）

**需求**：用户给出「超级外贸员」界面截图，要求复刻；随后明确核心是地图采集、客户背调、写开发信，并展示竞品截图（Google 地图数据批量采集 + 联系方式 + 净化结果表格）。

**开源调研结论**：候选对话 UI 库（chatbot-ui 等）多为 0-1 star 或许可证不明，vendor 不划算；项目已有 Bootstrap 5 + 自研视图层 + `pages_ai.js` 对话逻辑，直接手写更合适。**未引入任何第三方组件**。

**地图合规决策（重要）**：竞品用 Google Maps 批量采集海外 POI + 联系方式。按地图合规红线，Google Maps / Apple / 海外 OSM / Mapbox 一律禁止，仅允许腾讯/高德/百度/天地图；且本机 Google 直连不可达、批量扒联系方式涉及 PIPL/GDPR。因此**不做海外 POI 批量采集**，改为腾讯地图「客户开发地图」：把已有客户/线索按国家中心点聚合打点、点选查看、列表联动。海外底图属非默认场景，Key 由用户自行申请后填入系统设置，**代码内只保留占位符，不内嵌任何真实 Key**；提示用户为 Key 配 Referer 白名单。

**实现**（全在主系统，零新依赖）：
- `src/workbench.js`：国家中心坐标表 + 归一化（中英混写合并，如 Nigeria / 尼日利亚 Nigeria → 尼日利亚）、地图点位聚合（客户来自主库、线索来自 lead-gen 库只读）、DeepSeek 对话（带 `buildContext` 的 CRM 上下文 + 外贸人设）、开发信生成（JSON 解析 + 客户资料注入）。
- `src/views/pages_workbench.js`：复刻截图视觉（徽章/大标题/输入框/六张技能卡/工具导航）、地图页、开发信页。
- `src/routes.js`：3 个页面路由 + 2 个 API；`layout.js` 侧栏加入口；`pages_docs.js` + `/settings/tmap` 加腾讯地图 Key 配置项。

**验证**：`npm run check` 全部通过（含 3 条新路由）；端到端确认三页 200、地图占位提示正确、API 错误路径正确；AI 对话实测基于真实 CRM 数据给出尼日利亚重点市场分析。

**已知限制**：地图为国家中心点聚合（非精确坐标，未收录国家用哈希估算并标注）；客户/线索表无经纬度字段；EDM/图片/视频技能为占位；海外新客户批量采集（竞品核心）未实现，见上方合规决策。
## 2026-11-21 · CRM 工作台 UI 统一改版

**需求**：按用户提供的五张工作台截图，统一现有 CRM 的深色紫色视觉与业务导航；保留已有数据和功能，版本号更新为 1.5.0。

**GitHub 调研与许可证**：
- [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm)：MIT，WhatsApp CRM 模板；可参考共享收件箱、会话/联系人并列工作区。其 Next.js + Supabase 与本系统 Node.js 原生 HTTP + SQLite 不兼容，因此只参考交互组织，不移植代码或数据模型。
- [tabler/tabler](https://github.com/tabler/tabler)：MIT，Bootstrap 5 管理后台组件；适合当前 Bootstrap 页面栈。仅借鉴紧凑导航、后台层级和暗色对比，不引入额外 CSS/JS 包，以免影响离线局域网部署。
- Chatwoot：核心仓库 MIT，enterprise 目录另有许可；其收件箱交互可作参考，但 Ruby/Rails 全栈不适合嵌入当前项目。

**落地边界**：现有 WhatsApp 收件箱、客户详情、历史报价/单据、跟进中心和客户星图只重组界面，不改其业务数据。用户随后明确授权建设知识库，由此新增一张空的共享文章表和对应 CRUD 页面；不伪造示例文章，也不修改、迁移或删除既有客户、订单、报价、跟进记录。截图未确认的审批流和销售漏斗不新增。

**改动点**：统一应用外壳、导航分组与暗色工作台样式，版本元数据及界面版本标识同步为 1.5.0。知识库用新表保存团队共享 Markdown 条目，并只允许作者或管理员编辑；CRM 数据助理按问题匹配条目，返回来源链接。

## 2026-11-21 · CRM 共享知识库

**需求**：根据用户提供的知识库界面架构，先建立可渐进填充的共享资料库，并让 CRM 数据助理能引用匹配内容。

**GitHub 调研与许可证**：
- [markdown-it/markdown-it](https://github.com/markdown-it/markdown-it)：MIT，约 2.2 万 GitHub stars，持续维护；选用其成熟 Markdown 解析器，配置 `html: false`，自定义图片只允许 CRM 本地 `/uploads/`、`/static/` 路径。
- [Wiki.js](https://github.com/requarks/wiki)：AGPL-3.0，约 2.9 万 GitHub stars；独立 Node.js/数据库知识平台，整套部署会重复 CRM 账号和数据权限系统，因此不移植。
- [Outline](https://github.com/outline/outline)：GitHub API 未标 SPDX 许可证，且需独立服务；不作为可嵌入组件使用。

**实现**：新增空的 `knowledge_articles` 表；知识内容按产品资料、报价政策、工厂资料、外贸术语、历史经验分类。所有已登录账号可读，作者与管理员可编辑，没有删除入口。AI 回答只附带按问题命中的少量文章，并返回可打开的来源链接；未命中知识不注入上下文。新增测试使用 D 盘隔离临时库，不写入 CRM 正式库。

## 2026-11-21 · CRM 数据助理改回 DeepSeek（统一为一个 AI 入口）

**需求**：系统内 AI 统一为 DeepSeek，CRM 数据助理不再走 Codex CLI。

**候选/选型**：不从零写、不新引依赖。DeepSeek 已有现成实现：`src/workbench.js` 的 `callDeepSeek`（`ai_api_key` / `ai_model`，默认 `deepseek-chat`，调 `https://api.deepseek.com/chat/completions`），WhatsApp 草稿、行业简报、AI 外贸工作台已在用同一套；本次直接复用。

**落地**：
- 新增 `src/aiAssistant.js`：复用 `callDeepSeek`，保留原数据助理的人设与“CRM 数据不可信、禁工具调用”安全提示词、问题/上下文长度限制与 2 路并发限流；上下文先收窄到 24000 字（`callDeepSeek` 内部按 28000 字截断）。
- 删除 `src/codexAssistant.js`（Codex CLI 子进程调用链），`src/routes.js` 的 `/api/ai/chat`（实际路由名；任务简述误写为 `/api/ai/ask`）改走 `aiAssistant.ask`，`/settings/ai` 删掉 `codex_model` 保存逻辑（旧表单提交该字段时直接忽略、不报错）。
- `src/views/pages_docs.js`：删掉“Codex 助理设置”卡片，只留统一的“DeepSeek 设置（系统全部 AI）”。
- `src/views/pages_ai.js`：标题改为“AI 助手（DeepSeek）”，连接区显示当前模型名与 Key 已配/未配，删掉 Codex CLI 登录说明。
- `tools/test-codex-assistant.js` 改为 `tools/test-ai-assistant.js`（桩 fetch 拦截，不联网；临时库，不碰生产数据），`package.json` 的 `test:codex-assistant` 改为 `test:ai-assistant`。
- `docs/PRD-产品需求文档.md` 三处 Codex 描述同步改为 DeepSeek；2026-11-19 的 Codex 切换记录作为历史留痕不动。
- 2026-11-22 WhatsApp 滑不动修复：需求 → 让铺满一屏的 WhatsApp 三栏各自独立滚动、页面本身能滚动。候选 → ① 新引虚拟滚动/自定义滚动条库（overkill：只是高度与 overflow 锁死，不是海量列表性能问题）；② 复用本项目已有模式：flex 纵向 + min-height:0 + overflow:auto（.wa-chat-list 与 .wa-messages 原先就是这么设计的，JS 也按内部滚动器写）。选中 ②，原因：零依赖、零构建、只改 static/css/style.css 一处；改动点：.page-wa .content 由 overflow:hidden 改为 overflow-y:auto，三栏网格加 grid-template-rows:minmax(0,1fr)，三栏各自接上独立滚动。
- 2026-11-22 取消铺满网页、声音提醒移到系统设置：需求 → 删掉 WhatsApp 铺满功能，把声音提醒开关搬到系统设置。候选 → ① 声音提醒改存服务端 settings 表（要改数据库与路由，跨浏览器同步，但用户只在一台电脑上用，收益小）；② 沿用原来按钮的 localStorage（crm_wa_sound，'0' 为关，默认开），只挪渲染位置。选中 ②，原因：零改动存储方式，WhatsApp 页继续只读同一个 key；改动点：pages_wa.js 删铺满按钮/JS/CSS 与声音按钮，加 waSettingsCards 第三张卡“声音提醒”（Bootstrap 开关 + 内联脚本读写同一个 key），test-wa-inbox.js 旧断言改为“不存在”断言。
- 2026-11-22 在新仓库内容 4406b29 上重做取消铺满网页、声音提醒移到系统设置：需求 → 删掉 WhatsApp 铺满功能，把声音提醒开关搬到系统设置。候选 → ① 声音提醒改存服务端 settings 表（要改数据库与路由，跨浏览器同步，但用户只在一台电脑上用，收益小）；② 沿用原来按钮的 localStorage（crm_wa_sound，'0' 为关，默认开），只挪渲染位置。选中 ②，原因：零改动存储方式，WhatsApp 页继续只读同一个 key；改动点：pages_wa.js 删铺满按钮/横幅/JS/CSS 与声音按钮，加 waSettingsCards 第三张卡“声音提醒”（Bootstrap 开关 + 内联脚本读写同一个 key），test-wa-inbox.js 第 15、19 节旧断言改为“不存在”断言；不动 githubUpdate.js、systemRestart.js、codexAssistant.js。
