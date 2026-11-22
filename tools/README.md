# 云端同步工具

把电脑版 CRM 的本地 SQLite（`data/crm.db`）与小程序云端数据库双向对齐。

**独立工具，不修改主系统任何代码**，只读写数据库。

## 用法

在 `D:/外贸CRM` 目录下执行：

```bash
node tools/sync-cloud.js              # 双向同步
node tools/sync-cloud.js --dry        # 只看差异，不写入（建议先跑这个）
node tools/sync-cloud.js --verbose    # 打印差异样本，便于排查
node tools/sync-cloud.js --local-wins # 冲突一律以本地为准（修复云端残缺字段时用）
node tools/sync-cloud.js --push-only  # 只把本地推到云端
node tools/sync-cloud.js --pull-only  # 只把云端拉回本地
node tools/sync-cloud.js --table products,customers  # 只同步指定表
```

首次使用先 `npm install`（在 tools 目录内），或已装好直接用。

## 同步的表

`customers` `contacts` `activities` `documents` `products` `stock_movements`

只同步两端都有的字段。电脑版独有的字段（供应商、公海、模板、AI 相关等）不上传。

## 冲突规则

1. 按更新时间判断：取 `updated_at` 和 `created_at` 里较大的一个（两端口径一致），新的一方覆盖旧的一方。
2. 时间相同则以**本地为准**（电脑版是主数据源）。
3. 云端字段为空、本地有值时，拉取不会用空值覆盖本地（防止抹掉真实数据）。
4. **不同步删除**：一端删掉的记录不会在另一端删除，避免误删扩散。

## 注意

- 同步时不要同时用电脑版大量写入，避免 SQLite 锁冲突。
- 产品图片不参与同步：电脑版用 `image` 字段，小程序用云存储的 `images`，两边各管各的。
- 每次推送后会调用 `fix_identity_seq` 校准云端自增序列，保证小程序新增记录不会主键冲突。
- 云端写入依赖行级权限策略，历史共享数据（`owner_id='__seed__'`）允许读写；新建的私人数据只在本人账号下可见。
