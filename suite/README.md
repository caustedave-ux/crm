# 获客工作台（lead-suite）

替代旧 `lead-gen/`（获客核验）服务的新获客系统。**不改动主 CRM 任何代码，不改动 `lead-gen/data/` 下的任何文件。**

## 启动

```bash
cd suite
node server.js
```

或双击 `启动获客工作台.bat`。浏览器打开 `http://localhost:5101`（独立端口，不影响主系统的 5000；环境变量 `LEADGEN_PORT` 可改端口，名字保持不变）。

- 独立数据库：`suite/data/leads.db`（不会碰主系统 `data/crm.db`）
- 零安装：只用 Node 22 内置模块，不新增任何 npm 依赖
- 登录：复用主 CRM 的 `crm_sid` Cookie 登录态，未登录跳主系统登录页

## 首次启动数据迁移

若 `suite/data/leads.db` 不存在、且旧服务 `lead-gen/data/leads.db` 存在，启动时把旧库文件（`.db` 以及同名的 `-wal`、`-shm`，若存在）**复制**过来再打开；复制后对新库执行 `PRAGMA wal_checkpoint(TRUNCATE)`，再 `SELECT COUNT(*) FROM leads` 校验并打一行日志 `[数据迁移] 已从 lead-gen 复制线索库（N 条线索）`。任何一步失败都 catch：打日志、不崩启动、改用空库继续。源文件绝不改动。

## 功能

1. **地图采集**（`/maps`）：关键词 + 城市/地区 + 半径，用官方 Google Places API (New) 批量找海外商家。提交后只创建任务并入队，返回 `task_id`，不做同步搜索；任务进度轮询 `/api/tasks/:id`。无 Key 时返回 `NO_API_KEY` 且零请求。地图展示用 Google Maps JS API script 标签直接引入（Key 只渲染进本页，不打日志）；地图脚本加载失败时降级只显示列表，不阻塞采集。
2. **AI 任务流**（`/tasks`）：任务列表卡片（T-编号、关键词、状态、已解析 x/y、用时、失败原因、重试）+ 底部横向进度时间线。执行器在 `src/tasks.js`（B 交付）。
3. **线索库**（`/leads`、`/lead/:id`）：公司/国家/行业/可信分/状态/审批；详情含画像、证据、联系方式，WhatsApp 联系按钮（取 evidence 里 `field='phone'` 的值拼 `wa.me/<纯数字>`，无电话时置灰），以及开发信区（选模板 → 渲染预览 → 复制/打开 mailto → 标记已发送）。
4. **开发信**（`/letters`）：模板列表 + 新建/编辑/删除（字段 name/lang/subject/body，lang 选 en/fr，body 支持 `{{公司名}} {{国家}} {{产品}} {{联系人}}` 占位符）+ 发送记录列表。批量发送是第二阶段占位：批量群发需配 SMTP、发信间隔与每日上限，防进垃圾箱，本期只做单发。
5. **导入**（`/import`）：CSV / Excel 复制粘贴，按域名/公司名自动去重。
6. **数据源设置**（`/settings`）：Google Places API Key 输入框与 `google_places` 开关、代理（默认 `127.0.0.1:7897`）、请求间隔/超时。Key 只存 settings 表，不进代码、不进日志。

## 与 B 的集成约定（已交付、已联调）

`src/tasks.js`（导出 `createTask/getTask/listTasks/startRunner/runTask/retryTask/estimateCalls`）、`src/letters.js`（导出 `listTemplates/getTemplate/saveTemplate/deleteTemplate/renderTemplate/recordSend/listSendRecords`，另有 `ensureDefaults/getLeadContact`）、`static/tasks.js`、`static/letters.js`。`server.js` 与 `views.js` 直接调它们的导出函数；缺失就是错误，不吞掉。

已确认的调用签名：

- `tasks.createTask({ keyword, location, radiusKm, maxResults })` → 返回含 `id` 的任务对象；任务状态 `queued / running / organizing / done / failed`（`organizing` = AI 整理中）
- `letters.renderTemplate(template, lead)` → `{ subject, body }`（template/lead 可传对象或 id）
- `letters.recordSend({ leadId, templateId, channel, subject, body })`（驼峰参数；前端 POST `/api/send-records` 发的是 snake_case，`server.js` 负责转换）
- `letters.listSendRecords(leadId?, limit?)`、`letters.getLeadContact(leadId)`、`letters.ensureDefaults()`
- 前端接口：`POST /api/tasks`（新建任务）、`GET /api/letter-templates`、`POST /api/letter-templates`、`DELETE /api/letter-templates/:id`、`GET /api/letters/render`（返回 `{ subject, body, contact }`）、`POST /api/send-records`、`GET /api/send-records?lead_id=`

注意：`places.js` 是原样复制，未改逻辑——`collectLeads` 的结果不带 `types`，所以 `tasks.js` 的整理步骤端到端按任务关键词回退映射行业（例如 keyword=`locksmith` 的任务，整批都映射为“门窗与安防五金”）；`types` 优先的分支由 `mapIndustry` 的单元测试覆盖。B 在 `tasks.js` 文件头与测试里明确写了这一点，并注明“`results` 里补上 `types` 字段后无需改本模块即可按每家店的真实类型映射”——是否补这一个字段、以及随之要改 B 测试里写死的回退断言，需 parent 定。

## 不做的事（V1）

- 旧核验引擎（`verify.js`、`sources.js`、`socialReader.js`、`workflow.js`、pipeline-demo、exporter.js）本次不搬；`/verify`、`/api/verify`、`/api/verify-all`、`/api/maps/verify-batch` 已去掉，导出功能 V1 先不做。
- 批量群发开发信（第二阶段）、社媒获客专区（第二阶段，导航为 disabled 占位）。

## 自测

```bash
cd suite
node tools/selftest.js   # 数据迁移、places mock、导入去重；只用 /tmp 临时库，不碰真实数据库
```

`npm test` 还会跑 `tools/test-tasks-letters.js`（B 交付，72 项）。
