# 获客核验系统 - 开源调研与选型留痕

> 按 AGENTS.md 铁律：动手前先调研开源实现。记录日期 2026-11-20。

## 需求拆解与关键词

| 功能点 | 中文关键词 | 英文关键词 |
|---|---|---|
| 线索发现 | 外贸获客、B2B 客户搜索 | lead generation, B2B prospecting |
| 信息富集 | 客户背调、企业画像 | lead enrichment, company enrichment |
| 多源验证 | 交叉验证、社媒核验 | multi-source verification, OSINT, social signals |
| 行业/规模识别 | 行业分类、员工规模 | industry classification, company size, employee count |

## 候选调研（GitHub / npm / 行业产品）

| 候选 | 类型 | 技术栈 | 许可证 | 匹配度评估 |
|---|---|---|---|---|
| lead-research-agent | GitHub 开源 | Python + Twitter/LinkedIn API | MIT | 依赖付费 API（Proxycurl/PhantomBuster），需海外网络，不匹配本项目 Node 栈 |
| sales-lead-scraper-tool | GitHub 开源 | Python + Scrapy 类 | MIT（存疑） | Python 栈，需 Google/LinkedIn API，中文与国内网络不友好 |
| lead-enrichment (CocoLoop Skill) | Skill | Bash + jq + curl | - | 思路可借鉴（多源+评分+批量），但依赖 LLM 与海外网络 |
| theHarvester / Maigret / Sherlock | OSINT 开源 | Python | GPL 等 | 侧重邮箱/用户名枚举，非公司行业规模画像；GPL 需注意 |
| Clearbit / Hunter.io / Apollo / ZoomInfo | 商业 API | SaaS | 商业 | 数据质量最高，但付费 + 需海外网络 + 无法局域网自持 |
| 跨境魔方 / 特易 / 小满 OKKI 等 | 国内商业软件 | SaaS | 商业 | 符合外贸场景，但闭源付费，无法集成进现有局域网 CRM |
| Bing 搜索 HTML + 官网 JSON-LD/OpenGraph | 公开标准 | 免密 HTTP | 公开数据 | **选中**：零依赖、免密、可局域网自持、可审计 |

## 选型结论

**采用「官网为锚点 + 搜索引擎间接索引 + 可插拔 API 增强」的自研轻量方案**，理由：

1. **网络现实约束**：实测本环境 Google / DuckDuckGo / LinkedIn / Facebook / Instagram 直连不可达或被反爬（LinkedIn 返回 999）；Bing 搜索结果受本地化污染；仅公司官网直连稳定可用。硬爬社媒不可行。
2. **合规与可持续**：官网公开的 JSON-LD（schema.org/Organization）、OpenGraph meta 是网站主动公开的机器可读数据；社媒验证通过官网自身的外链（公司自己声明的社媒账号）完成，比爬平台更可靠也更合规。
3. **项目栈匹配**：Node 22 内置 `node:sqlite` + 原生 fetch + 零新依赖，符合项目「无构建链、局域网自持、部署简单」偏好；Excel 复用主系统已有 `exceljs`。
4. **可审计**：所有结论保留来源 URL、原文片段、采集时间，冲突显式标记，缺失留空不编造——符合行业成熟实践。

## 借鉴的成熟方法论

- **多源交叉验证**：单一来源不采信，字段级多来源投票（来源权重 × 一致性 × 数量加成）
- **置信度分级**：confirmed / weak / conflict / missing 四态，而非简单布尔
- **证据链留痕**：每条声明可追溯到来源与原文（参考 OSINT 工具的 evidence 模型）
- **分层评分**：行业/规模/官网/社媒高权重，描述类仅作佐证不参与打分
- **宁缺毋滥**：搜索结果做公司名相关性过滤，防止搜索引擎本地化污染进入画像

## 补充调研：社媒直读通道（用户反馈代理开通后）

用户反馈Facebook可连通后复测，发现本机代理端口 `7897` 可访问 Google / Instagram，但：
- Facebook 官方页直连返回 400（代理层拦截）
- LinkedIn 官方页直连返回 403（Cloudflare 人机验证）

**选中 r.jina.ai 文本阅读器**作为社媒读取方案：
- 类型：公开的文本提取服务（把网页转 Markdown），有免费额度
- 理由：无需平台 API Key / 无需登录，能读到 FB/LinkedIn 公开主页的 `Company size`、`Industry`、粉丝数、地址、邮箱等硬指标；走本地代理即可用
- 落地：`src/socialReader.js`，流程 = 公司名推导主页 URL → r.jina.ai 转文本 → 正则解析字段 → 统一 evidence
- 风险与降级：r.jina.ai 为第三方服务，可能限流/变更；系统做成可插拔（`jina_base` / `jina_reader` 设置项），关闭后自动回退到官网外链验证

## 二次开发 / 改动点

基于上述公开标准从零实现（无第三方代码直接 vendor），代码位于：
- `src/sources.js`：可插拔 provider（website / bing / 社媒 site 搜索 / 预留 google_cse / serpapi）
- `src/socialReader.js`：社媒主页直读（r.jina.ai + 代理）
- `src/net.js`：支持 HTTP 代理的 fetch 层（复用主系统 undici）
- `src/verify.js`：交叉验证与置信度引擎
- `src/normalize.js`：行业/规模中英文词典
- 未使用 GPL 组件；未修改主系统任何文件。

## 二次调研：借鉴 GoodJob CRM 的获客闭环（2026-11-20 晚）

**需求**：用户要求参考 GitHub 上 GoodJob CRM 的获客系统改造本系统。

**候选调研**：

| 项目 | 星数/许可证 | 结论 |
| --- | --- | --- |
| [huangguojia/GoodJob](https://github.com/huangguojia/GoodJob) | 约 215★，Apache-2.0（`whatsapp-plugin/` 为 GPL-3.0） | **主要参考**：同为 Node/TypeScript + 本地库，获客链路是「Provider 搜索 → 清洗 → 人工审批 → 线索 → 客户」，评分可解释、证据不污染主数据 |
| [laramies/theHarvester](https://github.com/laramies/theHarvester) | 18.4k★，GPL-2.0 | 否决：侧重邮箱 OSINT，GPL 与私有 CRM 集成成本高，无清洗/审批闭环 |
| [omkarcloud/google-maps-scraper](https://github.com/omkarcloud/google-maps-scraper) | 约 4k★，MIT | 否决：强依赖 Google Maps/代理与海外网络，本环境不可行 |
| OptiCrawl 等 SerpAPI + 邮箱工具 | MIT / 商业 | 否决：需要 Key/海外网络，缺审批与证据链闭环 |

**GoodJob 可借鉴点（只借鉴思路，未复制代码）**：
- Provider 统一契约与开关：未配置 Key 的源自动跳过，不阻塞其他源（`backend/src/lead-providers.ts`、`provider-contract.ts`）
- 候选独立表 → 清洗 → **人工审批** → 线索 → 客户；候选阶段绝不污染正式数据（`prospect-candidate-pipeline.ts`、`prospect-lead-conversion.ts`）
- 可解释加权推荐分：验证等级 + 置信度 + 具名联系人 + 渠道 + 多源，冲突扣分（`prospect-contact-enrichment.ts`）
- 联系方式只从证据正则抽取，不猜测、不做 MX/SMTP 可达验证
- 只记录官方站点/搜索摘要证据；`NON_COMPANY_HOSTS` 过滤社媒平台，避免把平台页当公司官网

**本次落地**：
- `leads` 加 `stage / reviewed_at / review_note / recommend_score`（旧库幂等迁移），新增 `src/workflow.js` 审批流转；
- `src/verify.js` 从已有 FB 证据抽取邮箱/电话，新增「基础可信 70 + 联系方式 20 + 多源佐证 10 - 冲突扣分」的可解释推荐分；
- `src/sources.js` 支持设置页勾选 Provider，`src/views.js`、`static/leads.js` 增加审批按钮、推荐分展示与设置开关；
- `src/exporter.js` 增加推荐分/推荐等级/审批状态列，并支持按审批状态导出；
- 引擎版本升级到 1.2.0；`npm test` 44 项通过（32 逻辑 + 12 审批），页面/API/xlsx 冒烟全通过。
