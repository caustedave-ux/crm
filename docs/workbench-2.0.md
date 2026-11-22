# 外贸AI客服工作台 2.0 — 改动记录

版本：V2.0.0（原 V1.5.0）。不改数据库结构、不改后端路由；只改视图布局与样式，数据复用现有查询，不足时用图片里的示例数字占位并注明。

## 图片对照

| 图片 | 页面 | 改动 |
| --- | --- | --- |
| 图 1 报价与订单 | 报价页 `src/views/pages_quotes.js` `quoteFormPage` | 三栏：左客户与产品、中创建报价单、右 AI 报价助手；报价单号示例 QT-20261118-001、币种 USD、FOB/DDP、交期 20–25 天、目的港 Los Angeles、产品 KNT-25108/25109/25110、总额示例 7,770 / 8,120 USD；AI 面板含价格评估、毛利率 24%、MOQ、交期、风险提示、历史报价、审核状态待确认/提交审批。 |
| 图 2 客户管理 | 客户详情 `src/views/pages_core.js` `customerDetailPage` | 加 AI 客户分析摘要：评级 85/100 高意向、当前阶段样品确认阶段、客户需求、未解决问题 3 项、最近报价、下一步行动 AI 建议、跟进提醒 11月21日 16:00；客户列表页标题显示真实人数，图片示例 128 人仅作对照。 |
| 图 3 WhatsApp | WhatsApp `src/views/pages_wa.js` `sessionPage` | 三栏：左消息列表（全部/未读/待跟进/重点）、中聊天对话（客户头 + 5 个标签页：聊天对话/客户信息/跟进记录/文件资料/订单报价，中英文对照、PDF 附件）、右 AI 智能助手（智能回复/翻译工具/知识检索/快捷短语、需求分析、翻译建议、英文回复+中文翻译、引用知识、确认发送人工审核）。2026-11-21 按图 3 重修：顶部加 4 个统计卡，旧连接/自动回复/铺满块收起，右栏只放 AI 面板，底部加状态条。详见下面“WhatsApp 图 3 修复”。 |
| 图 4 跟进与数据 | 工作台 `src/views/pages_core.js` `dashboardPage` | 顶部 4 卡 + 看板+漏斗：今日待跟进 12、高意向 8、待回复 28、本月成交额 $48,600（示例）；看板 新询盘 8 / 已联系 9 / 已报价 7 / 样品中 5 / 成交 7；转化漏斗 48→36→22→12→7（100%/75%/46%/25%/15%）；国家分布与 AI 跟进建议。 |
| 图 5 知识库 | 知识库 `src/views/pages_knowledge.js` `knowledgePage` | 左分类、中 AI 助手对话、右检索结果与产品关键信息：执手锁 LS-8801 出口美国 MOQ/单价/交期问答、报价与起订量表、交期、美国合规要点、建议；产品关键信息 MOQ 500、交期、合规、参考单价以产品管理为准；AI 判断可信度 96%。 |
| 通用 | 整体主题/导航 | 深色紫色主题见 `static/css/style.css` 末尾 2.0 一节；导航与顶部栏见 `src/views/layout.js`；工作台顶部 4 卡见 `src/views/pages_workbench.js` `homePage`。 |

## 改了哪些文件

- `package.json`：version 1.5.0 → 2.0.0，description 改为 2.0。
- `README.md`：顶部加 V2.0.0 改动说明。
- `static/css/style.css`：末尾追加 2.0 深色主题，新增 `.workbench-2`、`.ai-panel`、`.quote-3col`、`.wa-3col`、`.kanban`、`.wb2-stat-grid`、`.funnel-bar`、`.kb-2col` 等；原有类名保留。
- `src/views/layout.js`：NAV 改为 2.0 十项导航；顶部栏改为「外贸AI客服工作台 2.0 / WhatsApp · AI客服 · CRM · 报价 · 订单 · 知识库」；搜索框占位改为搜索客户、订单、报价、产品；`body` 加 `workbench-2`；登录页标题同步改 2.0。
- `src/views/pages_workbench.js`：`homePage` 顶部加 4 个统计卡（待报价/已报价/样品中/已成交，复用 `quote_history` / `documents` 计数，空库用 18/42/11/7 占位）+ 迷你折线。
- `src/views/pages_quotes.js`：`quoteFormPage` 加 `quote-3col` 与右侧 AI 报价助手面板；报价列表页不变，仍走现有查询。
- `src/views/pages_wa.js`：`sessionPage` 加 `wa-3col`，右侧加 AI 智能助手面板；原有会话、翻译、快捷回复逻辑不动。
- `src/views/pages_core.js`：`dashboardPage` 顶部加 2.0 四卡 + 跟进看板与转化漏斗；`customersPage` 标题显示真实人数；`customerDetailPage` 加 AI 分析摘要面板。
- `src/views/pages_knowledge.js`：`knowledgePage` 顶部加 AI 对话与检索结果/产品关键信息面板；原有分类、列表、文章预览不动。
- `docs/workbench-2.0.md`：本文件。

## WhatsApp 图 3 修复（2026-11-21）

上一轮只加了 `wa-3col` 类名和 AI 面板，但三栏还是 Bootstrap row/col，右栏被“客户与跟进”卡片压住，顶部也没有统计，连接设置/自动回复/铺满三块还挡在上面。这次按图 3 重改了 `src/views/pages_wa.js` 的 `sessionPage`：

- 顶部加 4 个统计卡：今日消息（当天 `wa_messages` 计数）、在谈客户（已绑定客户的会话数）、待跟进（`activities` 到期数）、本周询盘（近 7 天有消息的会话数）；空库时用图片数字 126 / 28 / 12 / 37 占位，↑+18% / ↑+32% 是图片里的示例涨幅。
- 连接设置、自动回复总开关改成默认收起的 `<details>`，点开才看；“WhatsApp 铺满网页”那条大横幅删了（铺满功能后于 2026-11-22 彻底取消，见“取消铺满网页”一节）。
- 三栏改成真 grid：左 300px、中自适应、右 330px，1200px 以上三栏，以下堆叠。左栏标题改为“WhatsApp 消息”，筛选改为全部 / 未读 / 待跟进（新增 `followup` 筛选：未读或置顶）/ 重点（置顶），搜索占位改为“搜索客户 / 关键词 / 标签...”。
- 中间栏顶部加客户头（头像、姓名 ★、国家/状态标签、备注/置顶/电话/档案按钮）和 5 个标签页：聊天对话 / 客户信息 / 跟进记录 / 文件资料 / 订单报价，点标签页前端切换不刷新；客户信息复用原来的 `sideHtml`，跟进/文件/订单另查现有 `activities` / `documents` 表，不改数据库。
- 右栏只放 AI 智能助手面板，占满右栏高度；底部按钮补了“插入资料”，AI 回复建议标题注明“示例”。
- 底部加状态条：WhatsApp 已连接（带号码）/ AI 模型 DeepSeek / 知识库已加载 / CRM 已同步。

没改的：`static/css/style.css` 末尾补 `.wa-top-stats`、`.wa-tabs`、`.wa-status-bar`、`.wa-chat-head-2`、`.wa-adv-details` 等样式；数据库、后端路由、WhatsApp 连接、自动回复逻辑、轮询/发送脚本均未改。

## AI 已统一为 DeepSeek（2026-11-21）

系统内 AI 不再分两套，全部走同一个 DeepSeek Key 和模型：

- 入口：WhatsApp 草稿（`src/wa.js`）、行业简报（`src/briefings.js`）、AI 外贸工作台（`src/workbench.js` 的 `chat` / `compose`）、CRM 数据助理 AI 助手（新增 `src/aiAssistant.js`，复用 `workbench.js` 的 `callDeepSeek`，不另写 fetch 逻辑、不新增依赖）。
- Key 在哪里填：系统设置 → “DeepSeek 设置（系统全部 AI）”，填 DeepSeek API Key；模型默认 `deepseek-chat`，可在同一处改。
- 原 Codex CLI 调用链已删：`src/codexAssistant.js` 已删除，`/api/ai/chat` 改走 DeepSeek，设置页不再有“Codex 助理设置”卡片，界面上不再出现 Codex / ChatGPT / OpenAI 字样。未配 Key 时打开 AI 助手提问会提示“未配置 DeepSeek API Key，请先到系统设置 → DeepSeek 设置填写”。
- 注意：上下文先收窄到 24000 字（`callDeepSeek` 内部按 28000 字截断），超长客户/单据列表问答时只取前面部分。

## 未改的

- 数据库结构、鉴权、WhatsApp 连接、单据模板、Excel 导入导出均未改；后端路由只改了 AI 助理相关两处（`/settings/ai` 删 `codex_model` 保存、`/api/ai/chat` 改走 DeepSeek），见上节。
- 2026-11-21 改 DeepSeek 时已跑 `npm run check`（88 条路由全过，`/ai`、`/settings` 均为 200）与 `node tools/test-ai-assistant.js`（通过）；未 `npm install`、未手动长期跑 `node server.js`。注意：本机检查副本当时没有 `node_modules` 和正式数据库，`npm run check` 是用临时种子库 + `/tmp` 下的最小依赖桩跑的，导出/PDF 等路由在桩环境下未做真实验证，到用户 Windows 电脑上拉取后、重启前最好再跑一次 `npm run check`。

## 本地验证

1. 双击 `启动系统.bat`。
2. 打开 http://127.0.0.1:5000 ，用现有账号登录（默认 admin / admin123，首次登录后请改密码）。
3. 依次看：工作台（顶部 4 卡+看板）、报价管理→新增报价（三栏+AI 助手）、WhatsApp（三栏+AI 助手）、客户管理→任一客户详情（AI 摘要）、知识库（AI 对话）、AI 助手（标题应为“AI 助手（DeepSeek）”，连接区显示当前模型与 Key 状态）、系统设置（只有“DeepSeek 设置（系统全部 AI）”，不再有 Codex 卡片）。

## 全站配色审计（2026-11-21）

查了全部页面入口：`src/views/` 下 12 个 `pages_*.js`（约 45 个 `page()` 调用，覆盖仪表盘、客户/产品/库存/供应商、询盘、报价、订单、跟进、客户池、知识库、AI 助手、行业简报、模板、设置、物流、货款、数据统计、客户分层、工作台/地图/开发信、WhatsApp）+ `src/routes.js` 全部 GET 路由。结论：之前不是“都没改”，而是“改了一半”。

原因：`static/css/style.css` 有 4 层（基础 → 纸墨浅色 → 1.5.0 深紫 → 2.0）。1.5.0 层是完整的深紫主题（旧紫 `#7134b5`、旧底 `#191323`/`#211a2d`），2.0 只覆盖了部分组件；凡是 2.0 没写规则、或 1.5.0 用了 `!important` / ID 选择器的地方，显示的都是 1.5.0 的旧紫或浅色。所有登录后页面都走 `page()`（body 带 `workbench-2`），结构上已统一，漏的是样式层。

本次修掉的不一致（都在 2.0 一节末尾追加规则，目标色：底 `#0f0f1a`、面 `#1e1e2e`/`#262638`、紫 `#7c3aed`/`#a855f7`）：

- 卡片：1.5.0 的 `.card` 带 `!important`（`#191323`），2.0 原规则压不过，全站卡片都是旧底；已补 `!important` 统一为 `#1e1e2e`。
- 删除/警告类描边按钮：`.btn-outline-danger`（23 处，含“退出登录并修复”）、`.btn-outline-warning`（7 处，含“暂停”）、`.btn-outline-dark`（1 处，“查看客户”）在基础层是白底白字/黑字，1.5.0 从未覆盖；已补深色描边 + 悬停填充。
- 跟进任务页：`.fu-task` 整组是白卡白底（标题、备注、优先级、空状态全是浅色），已整组改深色，逾期改红边。
- 工作台首页：输入卡、6 张技能卡、AI 回复框全是白卡，主标题 `#16233a` 藏青字在深色底上几乎看不见，发送按钮是绿色渐变；已整组改深色 + 紫色渐变，标题改 `#f1f1f8`。
- 客户开发地图页：整块白底面板 + 藏青标题（同样看不见）；侧栏、国家行、提示条已改深色，地图本身（腾讯瓦片）仍是浅色，属正常。
- 写开发信页：标题藏青字看不见、`生成结果`蓝色字；已改浅紫。
- WhatsApp：筛选当前项、分页面当前页、自己的消息气泡是旧紫 `#7134b5`/`#692bb0`，已统一为 2.0 渐变；消息区分类背景用了 ID 选择器，2.0 压不过，已补 `!important` 统一底色；客户详情动态里的日汇总气泡/标签/黄条（`waRender`）是浅色，已改深色；配对码浅蓝框已改深紫框（二维码本身留白底，保证能扫码）。
- 提醒类 alert：2.0 通用规则盖掉了红/黄/绿/蓝区分，全变成同一种灰；已补回深色 tint。
- 徽章/顶栏：`text-bg-primary` 旧紫、`新建单据`旧紫按钮、仪表盘大标题块旧渐变，已统一为 2.0 紫。
- 进度条轨道（仪表盘、客户分层）是浅灰，已改深色；顶栏提醒数字小 pill 是浅灰，已改深色。
- 登录页：body 原来没有 `workbench-2`，卡片是 1.5.0 旧底，顶部色条是珊瑚/黄色（全站唯一的珊瑚黄）；已加 `workbench-2` 类并改紫色条。
- AI 助手聊天：用户气泡是 Bootstrap 蓝、AI 回复和“思考中”是白底白卡；已改紫色渐变/深色气泡。
- 客户详情广告框、WhatsApp 配对码框是浅蓝框，已改深紫框；头像/图片占位符 30 处浅色内联色（`#eef3f9`/`#f8fafc` 等）已批量换深色；获客核验报错页是独立白页，已加深色底。

特意保留的（不是漏改）：

- `.doc-paper` 单据纸张：单据详情里的纸张预览、打印页、PDF 导出、模板预览 iframe 里的白纸——单据本身就是一张纸，刻意留白。
- 地图瓦片、二维码白底：扫码和看地图需要浅色底。
- 仪表盘 4 个统计图标的彩色 tint（紫/蓝/琥珀/绿）：1.5.0 靠更高特异性保留，是有意的区分色。
- `text-bg-*` 其余徽章的深色 tint：1.5.0 的深色版本可读且不刺眼，只把主色紫统一成 `#7c3aed`。

验证：改完跑 `npm run check` 与 `npm run test:wa`（见下节）。本地再看一遍：登录页、跟进任务、工作台首页、地图页、开发信页、AI 助手（发一句看气泡）、客户详情（广告客户框、动态里的 WhatsApp 汇总）、WhatsApp（筛选/分页/自己的消息）。

## WhatsApp 设置移到系统设置（2026-11-22）

WhatsApp 页顶部原来有两块可折叠的设置区，占地方又和聊天抢位置，现已整个移到系统设置：

- **移走的第一块：WhatsApp 连接与代理设置**——原来在 WhatsApp 页顶部，标题右边显示 online。内容原样搬过去：连接状态徽章、手机号、最后客户来信、扫码连接 / 刷新二维码 / 暂停 / 退出登录并修复 / 解除锁定、配对码登录、出网代理保存与测试连通、尝试次数与锁定提示。
- **移走的第二块：自动回复总开关**——原来在 WhatsApp 页顶部，显示“配置已开 · Worker 未运行”，右边有“重新启动 Worker”绿色按钮，下面写“已置顶客户永不自动回复；发送前还会再次检查置顶和人工回复。现货 PDF 1 个，默认全部发送。”内容原样搬过去：开关状态、Worker 重启/关闭按钮、现货素材说明、仅管理员可操作的限制都不变。

**现在的位置**：系统设置页 → DeepSeek 设置下方，两张独立卡片，标题就是“WhatsApp 连接与代理设置”和“自动回复总开关”，卡片样式和设置页其他卡片一致（2.0 深色紫色）。连接是按账号的，业务员也能在设置页连自己的号；开关本身仍只限管理员操作。

**WhatsApp 页留了什么**：两块 details 都删了，顶部只留一行小提示——“连接与自动回复设置已移到系统设置 → WhatsApp 设置”，后面带当前连接状态和自动回复状态两个徽章，点链接去设置页。聊天三栏、顶部统计、底部状态条都不动。顺带补了一个小地方：原来“已置顶”三个字只在自动回复的说明文字里出现，置顶会话的聊天头部没有可见标记，移走设置后自测会找不到它；现在置顶会话的头部标签区会直接显示“已置顶”。

**路由改动**：`src/routes.js` 新增 `waBack(ctx)`，7 条相关 POST 路由（自动回复开关、扫码连接、配对码、解除锁定、退出登录、暂停、代理保存、代理测试）提交后按表单里的 `back` 字段跳回：从设置页提交回 `/settings`，从 WhatsApp 页提交回 `/whatsapp/session`，只认这两个白名单值。表单字段、提交地址、按钮行为都没变，只是换了个地方渲染。

验证：`npm run check` 与 `npm run test:wa`（见下节）。本地再看一遍：打开系统设置，两张 WhatsApp 卡片在 DeepSeek 设置下方；打开 WhatsApp 页，顶部只有一行提示，没有重复的开关和按钮；在设置页点一次“重新启动 Worker”，应跳回设置页并提示成功。

## WhatsApp 页面滑不动修复（2026-11-22）

**用户反馈**：WhatsApp 页铺满一屏但上下滑不动，聊天内容被截断看不到全貌，输入框也被顶出视口。

**原来为什么滑不动（只改 CSS，不动 DOM/JS）**：
1. `.page-wa .content` 在桌面端（≥992px）是 `height:100dvh` + `overflow:hidden`，整页锁死，超出视口的内容直接被裁掉，页面本身没有滚动条。
2. `.wa-3col` 是 `display:grid`（2.0 规则），配 `align-items:start` 且没有 `grid-template-rows`，隐式行按最高一栏的内容撑高；内容一超高就溢出 `.content`，被第 1 条裁掉。
3. 中间栏 `.wa-col-mid` 只是普通 block div，不是 flex 纵向容器，`.wa-messages` 的 `flex:1` 没有父容器可撑，`height:auto` 撑满全部消息高度；JS 里 `scrollTop = scrollHeight` 的内部滚动永远触发不了，输入框被顶到视口外。
4. 右栏 `.ai-panel` 没有设置 overflow，AI 面板底部同样被裁。

**改了哪几层（都在 `static/css/style.css`，三栏宽度与 2.0 深色紫色不变）**：
- `.page-wa .content`：`overflow:hidden` 改为 `overflow-y:auto`，页面本身能滚动（兜底）；顶部统计、提示行、底部状态条加进 `flex:0 0 auto`，不会被压扁。992–1199px 三栏上下堆叠时，整页滚动。
- 桌面端（≥1200px）三栏网格：加 `grid-template-rows: minmax(0, 1fr)` + `align-items: stretch`，行高锁死在容器剩余高度；每栏 `.wa-col` 改为 `display:flex; flex-direction:column; min-height:0`。
- 左栏：会话卡 `flex:1; min-height:0`，`.wa-chat-list` 独立滚动。
- 中栏：聊天头和 5 个标签页固定不动；聊天面板改为 flex 纵向，`.wa-messages` 占满剩余高度独立滚动，输入框钉在栏底；客户信息/跟进记录/文件资料/订单报价 4 个面板各自独立滚动。
- 右栏：`.ai-panel` 占满栏高独立滚动。

**现在怎么滑**：左会话列表、中聊天消息区、右 AI 面板各滚各的，互不干扰；消息多时在中间栏里滑到最下面能看到最新消息和输入框；视口特别矮、内容实在放不下时，整页也能上下滑。

验证：`npm run check` 与 `npm run test:wa`（见下节）。本地再看一遍：打开 WhatsApp 页，滚轮在左中右三栏各试一次，中间栏滑到底应看到最新消息和输入框；窗口拉矮后整页应能滚动，顶部统计和底部状态条不被压没。

## 取消铺满网页，声音提醒移到系统设置（2026-11-22）

用户要求：WhatsApp 页右上角三个按钮——“连接与自动回复设置”“声音提醒：开”“铺满网页”——铺满取消，另外两个进系统设置。

- **铺满网页功能整个删掉**：页头“铺满网页”按钮（`#waFullscreenBtn`）、`setWaFullscreen`、Esc 退出逻辑、`localStorage` 的 `crm_wa_fullscreen` 记忆、铺满横幅（`.wa-focus-bar` / `.wa-focus-exit`）和 `body.wa-focus-mode` 全部 CSS 规则都清了。铺满横幅的 HTML 早已不在（上次移设置时已删），这次清的是剩下的按钮、JS 和 CSS；`tools/test-wa-inbox.js` 里对应的旧断言也改成了“不存在”断言，全仓再搜不到 `wa-focus` / `waFullscreen` / `crm_wa_fullscreen`。
- **“连接与自动回复设置”按钮**：本轮代码里页头已没有这个按钮（上次移到设置页时已拿掉，WhatsApp 页只留一行“连接与自动回复设置已移到系统设置 → WhatsApp 设置”的提示链接），这次核实无残留；设置页里两张卡——“WhatsApp 连接与代理设置”“自动回复总开关”——原样保留，一字未动。
- **“声音提醒”移到系统设置**：设置页 → 两张 WhatsApp 卡下方新增第三张卡“声音提醒”，开关是 Bootstrap 开关样式，拨一下就生效，不用提交。存储方式没变，还是原来那个按钮的 localStorage：`crm_wa_sound`，`'0'` 为关、缺省/其他值为开，默认开。WhatsApp 页只读这个值决定来新消息时响不响铃，不再渲染按钮；响铃本身（浏览器音频双音提示、只对客户来信触发、未读数照常显示）没变。
- **WhatsApp 页顶上现在剩什么**：标题“WhatsApp 收件箱”+副标题，右边只剩三个徽章（N 个会话 / N 条未读 / N 个待绑定），没有按钮了；下面依次是 4 个统计卡、移到设置的提示行、三栏聊天、底部状态条。布局和 2.0 深色紫色不变。

验证：`npm run check` 与 `npm run test:wa`（见下节）。本地再看一遍：打开 WhatsApp 页，右上角没有按钮；打开系统设置，WhatsApp 三张卡都在，拨一下声音提醒开关，再回 WhatsApp 页等一条客户消息，应按开关响铃/静默。

## 取消铺满网页，声音提醒移到系统设置（2026-11-22，在新仓库内容 4406b29 上重做）

背景：上一节那次改动推上 GitHub 后，仓库 main 在 2026-11-22 21:36 被一个单提交“脱敏开源版 2.0”（4406b29）覆盖，旧改动没了；这份新内容里的 WhatsApp 页右上角三个按钮（“连接与自动回复设置”“声音提醒：开”“铺满网页”）都还在。本节是在这份新内容上重新做的同一件事，只改这份代码，不碰备份，不动 githubUpdate.js、systemRestart.js、codexAssistant.js。

- **铺满网页功能整个删掉**：页头“铺满网页”按钮（`#waFullscreenBtn`）、铺满横幅（`.wa-focus-bar` / `.wa-focus-exit` / `#waFullscreenExit`）、`setWaFullscreen`、Esc 退出铺满、点击 `#waFullscreenBtn / #waFullscreenExit` 的委托分支、`localStorage` 的 `crm_wa_fullscreen` 记忆，以及 `static/css/style.css` 里所有 `body.wa-focus-mode` / `.wa-focus-bar` 规则（共三处：基础样式区、深色覆盖区、2.0 三栏布局区）都清了。`tools/test-wa-inbox.js` 第 15 节旧断言改成“不存在”断言，全仓再搜不到 `wa-focus` / `waFullscreen` / `crm_wa_fullscreen` / “铺满网页”（只剩测试里“必须不存在”的断言）。
- **“连接与自动回复设置”**：WhatsApp 页头那个去设置页的链接拿掉了；设置页里两张卡——“WhatsApp 连接与代理设置”“自动回复总开关”——原样保留，一字未动。
- **“声音提醒”移到系统设置**：`waSettingsCards` 现在返回三张卡，第三张就叫“声音提醒”，在两张 WhatsApp 卡下方，开关是 Bootstrap 开关样式，拨一下就写 localStorage，不用提交。存储方式没变，还是原来那个按钮的 localStorage：`crm_wa_sound`，`'0'` 为关、缺省/其他值为开，默认开。WhatsApp 页只读这个值决定来新消息时响不响铃，不再渲染按钮；响铃本身（浏览器音频双音提示、只对客户来信触发、未读数照常显示）没变。卡片上写明了只保存在这台浏览器里，换电脑或清浏览器数据后要重新开。
- **WhatsApp 页顶上现在剩什么**：标题“WhatsApp”+副标题“客户会话 · CRM 档案 · AI 销售助手”，右边只剩三个徽章（N 个会话 / N 条未读 / N 个待绑定），没有按钮了；下面依次是 4 个统计（今日客户消息 / 今日活跃会话 / 待处理跟进 / 近 7 天报价）、三栏聊天。布局和 2.0 深色紫色不变。

验证：`npm run check` 与 `npm run test:wa`（见下节）。本地再看一遍：打开 WhatsApp 页，右上角没有按钮；打开系统设置，WhatsApp 三张卡都在，拨一下声音提醒开关，再回 WhatsApp 页等一条客户消息，应按开关响铃/静默。

## WhatsApp 页最右边加上下滚动（2026-11-22）

背景：用户截图里 WhatsApp 页右栏 AI 助手底部被截断（“引用知识”只露一半），页面最右边没有滚动条，拉不到底。

根因（只动 CSS，不动 JS 与页面结构）：桌面端（≥992px）`.page-wa .content` 是 `height:100dvh + overflow:hidden`，整页锁死，超出视口的内容直接被裁掉，页面本身永远没有滚动条；右栏 AI 面板的内部滚动（`.wa-ai-tab-panel{overflow:auto}`）本身是通的，但用的全站 8px 浅灰细滚动条，在深色面板上几乎看不见，用户找不到、拉不到底。

改动（只改 `static/css/style.css`，3 处）：

- **页面最右边能上下滚动**：`.page-wa .content` 的 `overflow:hidden` 改为 `overflow-x:hidden; overflow-y:auto`（沿用 2026-11-22 那次滑不动修复的做法）。平时三栏各滚各的、页面不出现滚动条；内容一旦超出视口高度，页面本身在最右边出现滚动条，能把整个页面拉到底。横向仍锁死，避免三栏被横向撑开。
- **右栏滚动条看得见**：`.wa-ai-tab-panel` 加深色紫色滚动条样式——滑块紫色 `#7c3aed`、悬停 `#a855f7`、轨道深色 `#211a2d`、宽 10px；`.page-wa .content` 的页面滚动条也用同一套紫色样式。
- **网格最低高度**：`.wa-inbox.wa-3col` 加 `min-height:420px`。视口很矮时三栏会被 flex 压到内容最小高度以下，里面的 `overflow:hidden` 会直接裁掉输入框等内容、页面又报不出溢出、滑不动；锁一个 420px 下限，压不下去时宁可让页面纵向滚动，也不锁死。824px 高的常规窗口三栏约 560px，不受影响。

没动的地方：左边会话列表、中间聊天消息区、输入框固定在底部，都没动；窄屏（992px 以下）三栏上下排列时页面滚动本来就正常，没动。

验证（真实 Chromium 渲染，视口 1617×824，与用户截图一致；临时种子库 + 最小依赖桩，验证完已清）：修复前实测页面不滚动（`pageScrolls:false`）、`.content` 是 `overflow:hidden`、右栏面板内容 570px 比可见 464px 高、能内部滚动但滚动条看不见；修复后右栏面板拉到底能看到“引用知识”5 条知识（截图已确认），左列表（693/380）与消息区（846/187）照常各自滚动、输入框固定在底部；1617×500 与 1617×320 的矮窗口下页面滚动条出现、拉到底输入框能看到；800×900 窄屏三栏堆叠、整页滚动（文档高 3572px）。`npm run check` 全部通过，`npm run test:wa` 全部通过。

## WhatsApp 聊天消息区改大、输入框完整可见（2026-11-22）

背景：用户说中间栏“会话框太小了，打的字看不到，聊天内容只能看到一两行”。截图红框圈的是中间栏：5 个页签（聊天对话/客户信息/跟进记录/文件资料/订单报价）、客户头（Prdeep Kumara）、会话备注、广告卡片（Door Lock Supplier · MOQ 5 Cartons），最下面是输入框“输入消息，可粘贴图片，Ctrl+Enter 发送”和发送按钮。

根因（真实 Chromium 实测，视口 1617×824，与用户截图一致；临时种子库 15 条消息 + 最小依赖桩，验证完已清）：

- 中间栏卡片高 514px、内容 658px，溢出 144px；卡片是 `height:100% + overflow:hidden` 的 flex 纵向，消息区只能分到 `min-height:120px`，15 条消息只看到 2 条（消息区 scrollHeight 1438）。
- 固定占位一共 570px：页签 48 + 客户头 73 + 会话备注 47 + **广告条 181** + 绑定栏 49 + 输入区 137 + “管理快捷回复” 35。其中广告条最占地方，181px 的大卡片只放了一条广告信息。
- 输入框 `rows=2` 只有 53px 高，输入区底部离视口底边只剩 17px；用户真实数据里输入区被顶出视口、截掉一半，打的字看不到。
- “管理快捷回复”折叠块在输入框下面、视口 824px 折叠线之外（y 915–950），根本看不见。

改动（`src/views/pages_wa.js` + `static/css/style.css`）：

- **消息区定高 560px**（≥992px）：不再被上面几块挤压，框内滚动看历史；打开会话时页面自动滚到底，最新消息和完整输入框一次可见。
- **广告条收成一行**（181px → 66px）：只留徽章 + 标题 + 广告 ID，元信息/文案/落地页/复制 ID 收到“详情”折叠里；“标记广告”还在。备注能加、广告信息能看，功能一个没删。
- **“管理快捷回复”移到输入框前面**：原来在输入框下面、被 sticky 输入区盖住看不见；它里面有自己的表单 `#waSaveReply`，不能嵌进发送表单 `#waSendForm`，所以是平级前移。
- **输入框 rows=2 → 3（71px），加自动长高**：多打几行跟着长，最高 160px 后框内滚动；打 5 行字实测长到 110px，长高时页面自动跟随滚动，发送按钮始终可见。
- **页面不再锁 100dvh**：`.page-wa .content` 改成 `height:auto + min-height:100dvh`，文档滚动；网格行高 `minmax(0,1fr)` 改 `auto`，行高由中间栏内容决定。左右两栏不定高会出问题（左侧列表最多渲染 300 个会话，会把行撑爆），所以左右栏给显式高度 `calc(100dvh - 250px)`、最小 480px，`position:sticky; top:80px` 跟随滚动；中间栏和卡片高度随内容。
- **页签、客户头、输入框、左右栏都贴住**：页签 sticky 置顶（top:0）、客户头 sticky（top:48px）、输入框 sticky 置底、左右栏 sticky（top:80px）。这里有个坑：sticky 会被祖先的 `overflow:hidden/auto` 锁在不滚动的容器里失效，所以 `.content` 横向、`card`、卡片体、`chat` 页签的 overflow 从 hidden/auto 改成了 `clip`（只裁剪、不产生滚动容器，sticky 才能贴住窗口滚动），实测贴住后才算完。
- **窄屏（992px 以下）消息区定高 44vh**：原来 686 行的 `.wa-messages{height:44vh}` 本是窄屏本意，但被全局 718 行 `.wa-main-tab-panel[data-wa-main-panel="chat"]>.wa-messages{flex:1 1 auto;height:auto}` 以更高优先级盖掉，消息区按 15 条内容撑到 1354px、页面拉到 3737px、输入框在三屏之外。这次用更高优先级把它拉回来：44vh、框内滚动。

没动的地方：左边会话列表、右边 AI 助手栏、页面最右边紫色滚动条（上次加的）都保持不动；备注和广告卡片的功能都在；数据库、后端路由、WhatsApp 连接、自动回复逻辑、轮询/发送脚本均未改。

验证（真实 Chromium 渲染，视口 1617×824；临时种子库 + 最小依赖桩，验证完已清）：修复前消息区 120px、只看 2 条、输入框 53px 且被顶出视口；修复后消息区 560px、**一次看到 6 条气泡（约 14 行文字）**、输入框 71px（打 5 行字长到 110px）、发送按钮始终完整可见；页签 0–48px、客户头 48–113px、左右栏 top 80px 都贴住；矮窗口 1617×600 下同样 6 条可见、输入框贴底；窄屏 800×824 下消息区 363px（44vh）、5 条可见、输入框完整可见。`npm run check` 与 `npm run test:wa`（见下节）。

## 深色背景上的黑色文字修复（2026-11-22）

背景：用户说“系统内有些文字还是黑色，在紫色背景下看不见”。

根因（静态排查 + 真实 Chromium 逐元素对比度实测，视口 1617×824；临时种子库 + 最小依赖桩，验证完已清）：

- **表格文字纯黑**：Bootstrap 的 `.table > :not(caption) > * > *` 用 `--bs-table-color`（默认 `--bs-emphasis-color:#000`）直接给 td 上色，2.0 的 `.workbench-2 .table { color: ... }` 只改了 table 本身、盖不到 td。客户、产品、设置三页的表格全是 #000 字压在 #191323 背景上，对比度 1.16。
- **表单 label 深灰**：全局 `.form-label { color:#4b4e55 }`，在深色卡片和深色登录卡片上对比度 2.17，写开发信、设置、登录页全中招。
- **地图国家名反白**：`.workbench-2 a`（0,1,1）优先级高于 `.wb-country`（0,1,0），把白色地图面板里的国家名链接染成浅色 #f1f1f8，白底白字对比度 1.12。
- **星标地图面板是深色**：`.starmap-panel` 在 style.css 里被 `!important` 锁成深色 #191323，但 `src/views/pages_map.js` 内联 `<style>` 里的 `.sm-*` 还是白色主题的深色字（#1a2233 等），客户名、单据名在深色面板上看不见；悬停背景 #f4f6fa 也是浅色。
- **占位符**：仪表盘待办输入框、知识库搜索框是非 `.form-control` 的裸 input，`.form-control::placeholder` 盖不到，#757575 压在 #3b3b3b 上（2.43）。
- **白色卡片上的浅灰次要文字也偏淡**：工作台输入框占位符 #aab4c2、技能副标题 #9aa5b4、输入提示 #94a0b0、地图侧栏说明 #a0aab8、地图未配置提示 #8a95a5、国家统计 #8b97a8，白底对比度 2.1–2.96。

改动（只改颜色，不改布局和结构）：

- `static/css/style.css`：
  - `.workbench-2 .table` 补 `--bs-table-color: var(--wb2-text)`（#f1f1f8）——表格文字改走变量，td 才能吃到。
  - `.workbench-2 .form-label` 与 `.login-body .form-label` → #d5d2e0。
  - `.workbench-2 input::placeholder, .workbench-2 textarea::placeholder` → #9a9ab0（盖裸 input）。
  - `.workbench-2 .wb-map-wrap a` → #243149（白面板里的链接恢复深色字）。
  - `.workbench-2 .doc-paper a, .workbench-2 .wb-answer a` → #0d6efd（白纸、白答案卡里的链接恢复蓝色）。
  - `body.workbench-2` 加 `color-scheme: dark`（原生日期选择器图标、滚动条按深色渲染）。
  - 2.0 深色文字补丁块：描边按钮在深色卡片上提亮（success #4ade80、danger #f87171、warning #fbbf24、info #67e8f9，边框 #2e2e44、悬停 #262638）；文字工具类提亮（`.text-secondary` #a9a3bd、`.text-success` #4ade80、`.text-danger` #f87171、`.text-primary` #8ab4f8）；`.form-select` 下拉箭头换浅色（stroke %23c4b5fd）；侧栏分组标题、页脚 #6b6b85 → #8b8ba3；`.wa-fold>summary` #0d6efd → #7fb3e8。
  - 白色孤岛反向修正（深色规则漏进白容器时拉回来）：`.doc-paper` 里的 `.text-muted`、`.text-secondary`、`.text-success`、`.text-danger`、`.text-primary` 恢复浅色主题值（#6c757d、#198754 等），`.list-group-item .text-muted` → #6c757d。
  - 删掉了之前误加的 `.starmap-panel .btn-outline-*` 白底规则——面板实际是深色，2.0 描边按钮（浅字 #d1d1e0）才是对的。
- `src/views/pages_workbench.js`：`.wb-title` #16233a → #f1f1f8；`.wb-sub` #7a8698 → #a9a3bd；`.wb-note` #aab4c2 → #9a9ab0；地图、写开发信 h4 行内 #16233a → #f1f1f8；“生成结果” #2f6fb0 → #7fb3e8；白卡片次要文字加深：`#wbInput::placeholder` #aab4c2 → #8a95a5、`.wb-skill .s` #9aa5b4 → #7a8698、`.wb-input-hint` #94a0b0 → #7a8698、`.wb-map-side .sub` #a0aab8 → #6b7688、`.wb-country .c` #8b97a8 → #6b7688、地图未配置提示 #8a95a5 → #5b6879。
- `src/views/pages_map.js`：星标面板整套改深色——面板 #191323、标题/客户名/单据名 #eee7f4、次要文字 #b9aec8、边框 #40324f/#463752、悬停 #251a34；ECharts 提示 #999 → #c9c9d4。

没动的地方：白色单据纸（`.doc-paper`）、打印页、PDF 导出的黑色文字是故意留白的，没动；WhatsApp 收到的消息气泡（#f1f3f5 底 + #212529 字）、`.text-bg-light` 徽章、图片占位符、`.wb-answer h6`（白卡片上的 #2f6fb0）都没动；布局、结构、路由、数据库均未改。

验证（真实 Chromium 渲染，视口 1617×824；临时种子库 + 最小依赖桩，验证完已清）：逐元素算对比度，13 页（登录、仪表盘、工作台、地图、写开发信、客户、产品、报价、WhatsApp 会话、设置、知识库、统计、单据）从 28 处对比度 <3.0 降到 1 处，唯一 1 处是工作台标题渐变字（`color:transparent` + 背景裁剪渐变，审计误报，肉眼可见）。抽查值：表格字 #f1f1f8、登录/写开发信/设置 label #d5d2e0、地图国家名 #243149、星标面板 #191323 底 + #eee7f4 字 + #b9aec8 次要文字、描边按钮 success #4ade80 / danger #f87171、白纸 muted #6c757d。`npm run check` 全部通过（88 条），`npm run test:wa` 全部通过。

## 产品管理 × 知识库产品资料合并（2026-11-22）

背景：用户确认合并方案（见 `~/workspace/crm-product-merge-plan.md`，基线 3c725fd），并要求删除服装示例资料。原则：`products` 是唯一事实源，知识库文章是“挂在产品上的说明文字”，不再另抄一份规格价格；只借 GitHub 开源 PIM 的数据模型（UnoPim 属性族/变体、Akeneo 父子两级、Part-DB 附件），不装系统。

### 数据库（`src/db.js`，启动迁移自动跑，老库自动升级）

- 新建 `product_categories`（id/name/parent_id/sort_order）、`product_attachments`（id/product_id/kind/title/file_path）两张表；首次为空时写入初始分类：锁体、把手、锁芯、合页、其他。
- `products` 加列：category_id、material、finish、moq、moq_unit（默认 PCS）、lead_time_days、sample_lead_time_days、status（默认“在售”）、specs（JSON，类别专属参数）、description；`knowledge_articles` 加列 product_id；补三个索引。
- 删除服装示例文章（迁移里自动删）：只删 category='产品资料' 且标题含针织/开衫/提花/毛衣/卫衣/服装/Jacquard/Cardigan/Knit/针织衫、标题不含“锁”的文章，或正文含“提花开衫”的文章；门锁五金文章不受影响。知识库页顶部写死的提花开衫示例问答同步换成执手锁 LS-8801 示例（材质 304 不锈钢拉丝、MOQ 500 PCS、交期 15 天）。

### 数据迁移（`tools/migrate-products.js`，只出清单、不写库）

- `node tools/migrate-products.js`：按品名/型号关键词给现有产品预分分类（锁体/把手/锁芯/合页/智能锁/门吸），扫描“产品资料”文章标题/正文命中某产品型号或品名即候选关联；输出控制台摘要 + `data/product-migration-suggestions.md`（建议分类、未分类、建议关联、未匹配四节）。分类与关联请人工确认后在页面里手工改，不要直接跑 SQL 写库。

### 页面（`src/views/pages_core.js`、`src/views/pages_knowledge.js`、`src/views/layout.js`）

- 产品详情页新增 `GET /products/:id`（`productDetailPage`）：5 个页签——资料（分类/材质/表面处理/MOQ/交期/状态/专属参数/描述/库存/供应商）、附件、关联知识条目、供应商报价（现有 `supplier_products` 挂接）、历史报价（现有 `quote_history`）。
- 产品列表：加分类、材质、状态三个筛选下拉；列表加分类、MOQ、交期三列，状态非“在售”时品名旁挂徽章；品名链到详情页；筛选条件在芯片/排序/分页间保持。
- 产品表单：加分类下拉、材质/表面处理（可填可选值：不锈钢/锌合金/铜/铝合金/铁；拉丝/镜面/电镀/喷涂/古铜/黑色）、MOQ 与单位、大货/打样交期、状态（在售/下架/停产）、产品描述；类别专属参数按所选分类动态显示（锁体：锁体尺寸/孔距/适用门厚/锁舌材质；把手：长度/孔距/管径；锁芯：长度/偏心距/钥匙数量；合页：尺寸/承重/开合角度），换分类已填值保留，提交时序列化为 specs JSON。
- 附件：`POST /products/:id/attachments`（上传文件 ≤10MB，图片/PDF/Office，或填 /uploads/ 路径、http(s) 链接）与删除路由；`POST /products/:id/link-article` / `unlink-article`（取消关联只断开链接，文章保留）。
- 知识库：文章列表与详情显示关联产品芯片（品名 + 型号，可点进产品详情）；按已关联产品筛选；新建/编辑时分类选“产品资料”必须选关联产品（表单 JS 控制必填 + 后端校验，其他分类不受影响）；从产品详情页“新建关联文章”会预填分类与产品。
- 侧栏导航：“产品管理”放回侧栏（报价与履约分组，报价管理之下）。

### AI 与引用（`src/aiContext.js`、`src/knowledgeBase.js`）

- `buildContext` 的产品块改取结构化字段：分类、材质、表面处理、单价、MOQ、交期、状态、库存、进货价；规则里加“价格、MOQ、交期以结构化数据为准，知识库文章里的数字仅作参考，缺失项标‘待确认’，不编数字”。
- `relevantArticles`：已关联产品的“产品资料”文章得分降权一半；`contextForQuestion` 与 `buildContext` 的知识块对已关联文章只取前 1500 字并标注“已关联产品，价格/MOQ/交期以产品管理为准”。

### 导入导出（`src/routes.js`）

- Excel 导入模板加列：分类、材质、表面处理、MOQ、MOQ单位、大货交期(天)、打样交期(天)、状态；示例行同步更新；填写说明加两行（分类按名称匹配，不存在进“未分类”；状态只能填在售/下架/停产）。导入时新列缺失按空处理、不报错；分类不存在不建分类、不报错。

### 没动的地方

- `supplier_products` 采购镜像与 `syncProductToSupplier` 同步逻辑不动；`product_variants` 变体表按方案放二期，本次未建；报价单、库存、WhatsApp 逻辑未改。

### 待用户人工确认

- 初始分类树已扩到锁体/把手/锁芯/合页/智能锁/门吸/其他，并加了“添加分类”按钮（见下一节）；材质、表面处理的可选项如需增减在页面里直接填即可。
- `data/product-migration-suggestions.md` 里的分类建议与文章关联建议，逐条确认后在页面里手工改。

## 产品分类新增“添加分类”按钮、客户 AI 摘要按真实数据生成、AI 助手学习知识库（2026-11-22）

### 产品分类：新增智能锁、门吸 + “添加分类”按钮（`src/db.js`、`src/routes.js`、`src/views/pages_core.js`）

- 初始分类扩到 7 个：锁体、把手、锁芯、合页、智能锁、门吸、其他；种子逻辑改成逐个补齐，老库升级也会补上智能锁、门吸（只补缺失的，不动已有分类）。
- 产品列表筛选区和新建/编辑产品的分类下拉旁都加了“添加分类”按钮，点开弹窗输入分类名、可选父分类（二级分类），保存后立即出现在下拉和筛选中，不用重启。
- 后端 `POST /products/categories`：校验名字必填（≤30 字）、父分类必须存在、同级不重名；保存后跳回原页，回到产品表单时直接预选刚加的分类。
- 新分类的类别专属参数：智能锁（解锁方式/供电方式/适用门厚/联网方式）、门吸（材质/安装方式/承重/表面处理）。

### 客户管理 AI 分析摘要：根因与修复（`src/views/pages_core.js`、`src/routes.js`）

- 根因：客户详情页的“AI 客户分析摘要”以前是写死的演示文案——样式 2/3 打版、针法/用纱、“更新于 09:54”、意向分恒为 85、“11月21日跟进”，跟哪个客户、哪条跟进、哪张单据都没关系，所以跟实际永远对不上。
- 修复：新增 `buildCustomerAiSummary`，每次打开客户详情都按该客户的真实数据现算，不缓存、不写死——阶段按成交/样品/报价/跟进/接洽规则（与工作台分层一致）、需求取最近 3 条有内容的跟进、未解决问题取未完成且有下次跟进日期的跟进、最近报价取最新一张单据、下一步行动取最近一次待跟进、意向分直接用客户分层分数 `tier_score`。
- 另加“用 AI 重新生成”按钮：`POST /api/customers/:id/ai-summary`，把该客户的资料、跟进、单据喂给 DeepSeek（提示词强制只用给定数据、缺失写“暂无”、不编造），生成后替换面板内容；失败时保留按真实数据计算的版本。

### AI 助手：改走 DeepSeek + 知识库学习回路（`src/routes.js`、`src/views/pages_ai.js`、`src/knowledgeBase.js`）

- `POST /api/ai/chat` 改走 DeepSeek（复用 `src/workbench.js` 的 `callDeepSeek`，用系统设置里的 DeepSeek Key 和模型）；原来走本地 Codex CLI，与设置页说的“系统全部 AI 共用 DeepSeek Key”不一致，现已统一。`codexAssistant.js` 文件保留，未再被路由引用。
- 回答前先按问题关键词检索知识库（全部分类，不只产品资料），把匹配文章放进 DeepSeek 提示，提示词要求知识库内容优先、答不出来说不知道、不要编；回答下面照旧显示引用的知识库文章（标题可点进知识库）。
- 学习回路：每条 AI 回答下面挂“保存到知识库”按钮，点开可改标题、选分类（默认“问答”，新增分类）、选关联产品（可选），点“确认保存”才存成知识库文章（`POST /api/ai/save-to-knowledge`），不自动存；存完下次问类似问题检索就能引用到。分类选“产品资料”时仍要求关联产品。
