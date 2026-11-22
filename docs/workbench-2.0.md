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

## 自动回复：置顶客户死守 + 未置顶客户主动跟进 + 销售破冰打法（2026-11-23）

只改 `auto-reply/`，主系统代码、数据库、产品模型和产品页面一字未动。

### 置顶客户保护：核实了全部 4 条发送路径

`auto-reply/worker.js` 里所有发消息的动作（v1 简单回复、v2 追问、v2 素材包、新增的跟进轮次）都只走 `deliver()` 一个出口，`sendText`/`sendFile` 在 `deliver` 循环里各只有初次和限速重试两处调用。保护点：

- **判定前跳过**：`processChat` 里 `logic.chooseDecision` 第一项就是 `pinned`，置顶会话直接跳过不判定；
- **发送前二次确认**：`deliver()` 发送前重新读库查 `wa_chats.pinned_at`（非空即置顶），置顶了就放弃；置顶状态是会变的，每次发送前都重新读，不用缓存的旧状态；
- **素材包逐条复查**：这次补的漏——原来多条素材是开头发一次检查，发到一半客户被置顶也会继续发完；现在每条发送前都重新读库查置顶，中途被置顶就停下，剩下的不再发；
- **跟进轮次同样过置顶**：候选扫描时先查置顶，发送时再走 `deliver()` 的二次确认。

### 未置顶客户主动跟进（`auto-reply/worker.js` + `config.json` 的 `followup` 段）

- 跟进轮次跟现有轮询走同一套冷却（10 分钟）和每天限额（批次 150、唯一客户 120），不另起一套；每 15 分钟扫描一次候选（`checkMinutes`）。
- 只跟进未置顶会话；只跟进自动回复已经接手过的会话（之前发过自动消息），没碰过的不要主动打扰；群聊、非当前账号会话、人工已接手的会话都不跟。
- 挑最近 24–72 小时没回音的（`minSilenceHours=24`、`maxSilenceHours=72`，刚发消息 2–4 小时内的不要催）；每个客户每轮静默最多跟进 2 次（`maxFollowups=2`），两次没回就停，再发一条礼貌收尾（`sendClosing=true`，发完不再打扰）。
- 客户发来新消息就重置轮次、重新计静默；客户明确说不感兴趣（原话或 AI 判定 `no_purchase_intent`），14 天内不再跟进。
- 跟进内容由 DeepSeek 按破冰打法现生成，角度轮换（第 1 次新款/市场信息、第 2 次价格/交期/试单、收尾礼貌关门），每次都避开已发过的内容，不许重复发同一条；跟进状态记在 `state.db` 的新表 `followup` 里，不写主库。

### 销售破冰打法喂给自动回复（`auto-reply/icebreakers.md` + `auto-reply/qualify.js`）

- 新文件 `auto-reply/icebreakers.md`：四步破冰话术（确认身份→还在做这行→从中国采购过→工厂价跟进）、母语开场+市场数据、要目录四步应对、跟进打法（每次带新价值、已读蓝勾换角度/未读灰勾短重发、60 天节奏、收尾话术）、禁区；末尾有“给自动回复的打法摘要”，每行带场景标签 `[general]/[catalog]/[quote]/[stock]/[followup]/[closing]`。
- `qualify.js` 启动时读这份文件解析标签行：判定提示词按本次场景只取 1–2 条（`PROMPT_VERSION` 升到 v2.3），跟进生成用 `[followup]`/`[closing]` 行；回复语言按客户语言走。
- 挑款规则按产品定位字段 `positioning` 选（高端精品客户只挑定位=高端款，大众流通客户只挑定位=高流通款，定位为空的产品不参与自动挑款），不按材质（不锈钢/铜/锌合金）推断定位。产品模型和页面由另一位代理在加 `positioning` 字段，本轮没碰。
- 大纲 v4 的规则也对上了（`logic.decideQualification`）：要目录的新客户判精准也不直接发全套，改追问（一次一问）；报了采购量、要样品/视频看厂、判精准就转人工；没给具体需求之前一直挖，最多 6 轮（`maxQualifyRounds=6`），到上限转人工并附已挖到的信息摘要；老客户（已有成交/报价记录）要目录/报价/现货直接给，不走三个问题。

### 挖到具体需求才转人工 + 右下角强弹窗通知（`notifications` 表 + `/api/notifications` + `src/views/layout.js`）

- 追问上限由 3 轮提到 6 轮：`catalogHandoffReason` 里“答 2 轮就转人工”的分支已删掉，判定提示词（`PROMPT_VERSION` v2.4）写明挖到具体需求为止、最多 6 轮；客户中途不回就停下来走跟进节奏，明确不感兴趣或触发风险词照常转人工/放弃。
- 客户给出具体需求转人工时，worker 调 `POST /api/notifications` 写一条通知（`type=qualified_handoff`，标题写客户是谁，正文是转人工原因 + AI 证据摘要，链接跳到该 WhatsApp 会话）；`GET /api/notifications?unread=1` 供前端轮询，`POST /api/notifications/:id/read` 标已读；24 小时内同一会话同类未读通知只留一条，不重复刷屏。
- 前端在 `layout.js` 里每 25 秒轮询一次：新通知来了就在所有页面右下角弹一张大卡片（深色紫色主题、紫色粗边框），写清楚客户是谁、要什么，带【去跟进】（跳到该 WhatsApp 会话）和【知道了】（关闭并标已读）两个按钮；弹窗常驻不自动消失，多条可以叠起来；未读数同时挂进顶部铃铛下拉列表第一行。声音复用系统设置的 `crm_wa_sound` 开关（'0' 为关，默认开），与 WhatsApp 页同一套双音提示。
- 弹窗只针对“客户给出具体需求”这类转人工事件（`decision.notify` 为真）；低精准、风险拦截、挖满 6 轮仍未给具体需求的转人工只记日志、不弹。额度/缺素材类 hold（缺报价文件、素材包/文件额度用尽、无可用素材）自 2026-11-23 起也不弹强通知（否则占 24 小时去重位，真正的转人工通知会被吞掉），只记日志，AI 已生成的回复有就照常发给客户。置顶客户本来就不走自动回复，不受影响。

### 自测

`node auto-reply/selftest.js` 123 项全过（新增 15 项：挖到具体需求才转人工、已挖信息摘要、强弹窗通知的表/接口/前端轮询）。`npm run check` 与 `npm run test:wa` 通过。

## Bug 修复与小幅精进（2026-11-23）

按静态走读清单修了一批 bug（高 2 / 中 12 / 低 12），红线没碰：置顶永不自动碰、要目录先问后发（一次一问、6 轮上限）、定位挑款、跟进节奏、广告预算逻辑、GitHub 自动升级、数据库只做加法、没动密码密钥。验证：`npm run check`（92 条路由）全过、`npm run test:wa` 全过、`npm run test:auto-reply` 144 项全过（123 项旧用例 + 21 项新增/修正）；`/api/documents/:id/pdf` 在桩环境下失败仍是本机无 Chrome，不是代码 bug。

### 自动回复 worker（`auto-reply/worker.js` + `logic.js` + `qualify.js`）

- **H1 游标重试**：`tick()` 原来循环结束后无条件把游标推到 `maxId`，AI 判定失败/发送失败只记日志，一次网络抖动就永久丢回复。现在 `processChat`/`processQualified` 返回成功与否，游标只推进到连续处理成功的最后一条，失败即停下本轮、下次重跑；跳过/拦截/观察模式算处理完，照常越过。
- **M1 跟进窗口**：`followupDue()` 第 2 次跟进与收尾原来只看距上次跟进是否满 24 小时，停工/重启后静默 30 天的客户也会收到跟进和收尾。现在同时要求总静默时长落在 24–72 小时窗口内，超出不跟、不发收尾。
- **M2 转人工通知口径**：`decideQualification()` 里 unknown 分支的“报采购量/要样品”hold 原来没带 `notify`，与 high 分支不一致，现已补上；high 分支追问到上限原来不论客户是否真给过具体需求都 `notify:true` 且理由写“已给具体需求”，现在只有至少 2 个强信号（产品已具体 + 目的国/数量/贸易条款等）才 notify，否则理由如实写“追问 6 轮仍未给具体需求”且不弹通知。
- **M3 额度 hold 不占通知去重位**：缺报价文件、素材包额度满、文件额度满、无素材四条 hold 原来都调 `notifyHandoff`（顶着“客户给出具体需求”标题弹窗、占 24 小时去重位），且直接 return 丢弃 AI 已生成的回复。现在这四条不调通知、只记日志，`verdict.reply` 有就照常发给客户。
- **M4 老客户直发交叉核对**：原来只看 AI 的 `signals.existingCustomer`，误判一次就能让未绑定新客户跳过追问直接拿素材。现在 `decideQualification` 多一个 `customerBound` 参数，worker 传入会话是否已绑定客户（`!!chat.customer_id`），只有已绑定才算老客户直发。
- **M5 人工接手误判文件消息（验证成立，带一处修正）**：前提修正——文件消息入库时 `text` 不是空，而是种类标签（`src/wa.js` 的 `storeMessage`：无 caption 时取 `KIND_LABEL`，如 `[文件]`/`[图片]`），但结论成立：标签文本永远比对不上 `sent_log` 草稿，5 分钟窗口一过，机器人自己发的素材包就被误判为人工接手、跟进永久停摆（直到客户再发消息才重置）。修复：`getLastMsg` 多取 `kind`/`ts`，文件类消息再拿 `sent_log` 里机器人发件记录做时间 proximity 比对（30 分钟内发过文件即认机器人）。残留边界：人工在机器人发文件后 30 分钟内从手机发文件会被认成机器人，但跟进只在 24 小时静默后才触发，影响有限。
- **M6 拒接判定收紧**：`isRefusal()` 原来“不用了/no thanks”命中即 14 天禁跟进，“这个型号不用了，换另一个”也被禁。现在只有整条消息就是拒绝/明确结束对话才算，带“换、另一个、其他型号、another/other model”的一律不算。
- **M7 追问轮数**：`ask` 分支原来 `verdict.reply` 为空也已提前把 `ask_rounds` 加 1，白白耗一轮。现在保存判定时先不加，只有成功发出追问后才 `UPDATE … SET ask_rounds=ask_rounds+1`。
- **M8 素材去重**：素材包部分发送成功原来即记 `sent` 并置去重 key，剩余文件 168 小时内被去重抑制、永远补发不了。现在 `deliver()` 多返回 `sentFiles`/`sentTexts`，只有全部文件发成功才置 key，部分失败不置 key、下次可重试/补发。
- **L4 置信度归一化（验证成立）**：`qualify.js` 的 `judge()` 里 AI 返回百分制（如 82）原来大于 1 直接按 1.0 处理（50 也变 1.0），`minHighConfidence 0.82` 形同虚设；与 `logic.normalizeConfidence`（大于 1 除以 100）不一致。现在改成大于 1 除以 100 再夹紧到 [0,1]。
- **L5 风险日志空词**：`HARD_STOP` 命中时日志用的 `hitSensitive` 可能为空（`defect`/`damaged` 只在 `HARD_STOP_RE` 里、不在 `sensitiveWords` 里），原来会写“命中高风险词，转人工：”后无词。现在日志写实际命中的模式（`match(HARD_STOP_RE)[0]`），取不到写“高风险内容”。
- **L10 精准度归一化**：`normalizePrecision()` 里 `"not qualified"` 含 `qualified` 子串会被判 high（仅当 AI 不按枚举返回时触发）。现在把 `not qualified` 的判断放最前面，直接判 low。
- **L12 回复与跟进串行**：`main()` 里 `tick()` 与 `followupTick()` 原来在同一 `setInterval` 里无 `await` 地并发跑（验证：代码里就是 `tick(); followupTick();` 两句并列；本机无 `state.db` 的 `sent_log`，查不到同一会话同分钟两条发送的实例）。现在改成 `tick().then(() => followupTick())` 串行。
- **L11 打法文档**：`icebreakers.md` 第四节转人工节点仍写“客户答了 2 个及以上问题就转人工”，已改成与 v4 一致（报采购量/要样品/正式报价/视频看厂、已给具体需求、追问 6 轮上限仍未给具体需求）。

### 产品 / 通知 / 客户摘要（`src/routes.js`、`src/views/*`、`src/excel.js`）

- **H2 库存变负双 `ok()`**：`POST /products/:id/stock` 负库存分支调 `ok()` 后缺 `return`，继续 UPDATE 又调一次 `ok()`，第二次 redirect 抛错、一次出库多推一条 flash。现在先 UPDATE 再按正负只调一次 `ok()`（修的过程中发现初版把 `return` 放到了 UPDATE 之前导致负库存没写库，已纠正并用真服务重测：50000 出库后变 -99949999，单次 302、一条 flash）。
- **M9 导入定位/状态**：导入更新原来以原始单元格非空判断是否覆盖，但定位/状态先经归一化，填错的定位（如“高端”）归一化成空会清空原定位，填错的状态归一化成“在售”会覆盖“停产”。现在更新时只有单元格值合法（在 `在售/下架/停产`、`高端款/高流通款` 内）才覆盖，非法值保留原值并记一条导入提示。
- **M10 复制丢定位**：`POST /products/:id/copy` 的 INSERT 列清单漏了 `positioning`，高端款/高流通款复制后变未分类。现在已加进列清单与值（真服务验证：定位 `高端款` 的产品复制后仍是 `高端款`、库存归零）。
- **M11 产品表单校验**：`POST /products/new`、`/products/:id/edit` 原来服务端无校验，空品名、负价格/负 MOQ 可直接入库；`edit`/`delete` 对不存在的 id 也静默返回“成功”。现在品名必填、价格/MOQ 不能为负（`validateProductForm`），`edit`/`delete` 遇到不存在的 id 返回“产品不存在”（真服务验证通过）。
- **M12 通知弹窗**：未读列表 `LIMIT 20` 放宽到 50；弹窗容器 `.notify-toast-stack` 加 `max-height: calc(100vh - 36px)` 与内部滚动，卡片再多也不会顶出视口。
- **L1 模板示例颠倒**：`/api/products/template.xlsx` 示例行里品名/英文品名两列值颠倒（`china door lock` 在品名列、中文在英文品名列），已换过来。
- **L2 去跟进标已读**：弹窗原来只有“知道了”调 `markRead`，“去跟进”是普通链接不标已读，下个页面又弹出来。现在点“去跟进”时也调 `markRead`。
- **L3 客户 AI 摘要**：“最近报价”原来取按 `id` 倒序的第一张单据，后补录的旧日期单据会冒充最近报价，现改按 `issue_date` 倒序（`id` 倒序作平局）；意向阈值 80/60 与分层 B 类门槛 35 口径不一致（分数 50 且有近期报价的客户分层是 B 类重点培育，摘要却写“一般意向”），现改成 80/35，与 `customerTiers.js` 的 `RULES.bScore=35` 对齐（单元验证通过）。
- **L6 导入图片挂行**：`readProductRows()` 原来按“最后一个 `__row` 小于等于图片行”取产品，空行上的图会错挂到上一个产品；同一行多图只取第一张。现在只在图片所在行确实有产品行时才挂图，空行上的图跳过并记一条日志；多图仍取第一张（单元验证：空行图 0 挂接、行内图正确挂接、双图同行挂 2 张取首张）。
- **L7 图片本地路径收紧（验证成立）**：`resolveImage()` 里图片列可填任意服务器本地路径，服务端直接 `readFileSync` 后转存到对外可访问的 `uploads/`（调用者是已登录的导入用户；内容落盘还受图片后缀限制，但任意读 + 任意 `http(s)` URL 抓取仍成立）。现在本地路径只允许 `uploads/` 或 `auto-reply/materials/` 目录内文件，其余返回明确错误；模板里的填写说明同步改成 `uploads/products/CDL-100.jpg` 示例。
- **L8 产品搜索 LIKE 转义**：`productsPage()` 搜索 `LIKE` 未转义 `%`/`_`，搜“%”会匹配全部产品。现在转义 `%`、`_`、`\` 并加 `ESCAPE '\'`（内存库验证：搜 `%` 只匹配含 `%` 的产品）。
- **L9 标已读接口**：`POST /api/notifications/:id/read` 原来不校验 id 是否存在/是否属于当前用户，不存在也返回 `ok:true`。现在不存在或不属于当前用户返回 404“通知不存在”（全新库全 API 流程验证：新建→未读 1→标已读→未读 0→读不存在的 id 返回 404）。

### 验证说明与残留

- 三项检查在桩环境下跑过（`/tmp/verify/node_modules` 的最小桩是上一轮审计后丢失、本轮按同样办法重建的：`exceljs`、`markdown-it`、`rss-parser`、`puppeteer-core`、`undici`、`https-proxy-agent`、`socks-proxy-agent`、`qrcode`；重建脚本在 `/tmp/build-stubs.js`，桩只够起服务和跑检查，不能解析真实 xlsx）。`npm run check` 全过、`npm run test:wa` 全过、`npm run test:auto-reply` 144 项全过（新增 21 项：M1/M2/M4/M6/L10 的行为用例 + H1/M3/M5/M7/M8/L5/L12/L4/L11 的源码断言）。
- 导入路径（M9/L7/L1）与 L6 之外的导入逻辑没法用桩 exceljs 跑真实导入做端到端验证（桩的 `load()` 是空操作），只做了代码走读 + L6 的 FakeWorkbook 单元验证；等有真实 `node_modules` 后建议拿一份真实产品表跑一遍导入回归。
- 验证时发现的环境问题（不是代码 bug）：本机有进程会删掉 SQLite 的 `-wal`/`-shm` 文件（`/tmp` 里的桩目录也是这么丢的），导致临时服务写进已删除的 WAL 后、外部 sqlite3 看不到服务端刚写的提交；验证改用 API 侧读数才对上。临时服务已停，临时库（`data/crm.db` 是为跑 `check` 临时从最新备份拷的）与验证数据已清理。
- 上一轮记下的 16 条路由 SKIP（备份库无单据数据）仍是覆盖缺口，未动种子数据。
