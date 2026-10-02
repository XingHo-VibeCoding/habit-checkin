# db/ · 数据库脚本与执行步骤

Day 16 产出。**表结构是从 `api-contract.md` 推导的**，不是另起一套：
契约里写的是 `/api/items` 和 `/api/reminders`，所以表就是 `items` 和 `reminders`。

| 文件 | 作用 |
| --- | --- |
| `schema.sql` | 建表（主键 / 外键 / CHECK 约束 / 索引）。**可重复执行** |
| `seed.sql` | 示例数据，两张表各 6 行。**可重复执行** |
| `verify.sql` | select 验证语句，在控制台跑来确认数据对 |
| `verify_local.py` | 本地 SQLite 实跑验证，不用等云端开通（11/11 通过） |

> **状态（2026-10-02）**：`schema.sql` / `seed.sql` / `verify.sql` 三份脚本已在
> **CloudBase PostgreSQL** 控制台实跑通过 —— 建表成功、两表各 6 行、
> select 验证第 ⑤ 条查出独立提醒 2 行（高铁去上海、牙医预约）。

---

## 一、在 CloudBase 控制台执行

### 1. 打开 PostgreSQL 数据库

Henry 截图显示环境里默认就是 **PostgreSQL 数据库**，已经有使用记录，**不需要再去开通 MySQL**。

1. 打开云开发平台 → 左侧 **PostgreSQL 数据库**
2. 进 SQL 编辑器 / 执行窗口

⚠️ PostgreSQL 也是按需计费，体验版只有 3000 点，用完记得留意额度。

### 2. 跑 schema.sql

进 SQL 执行窗口 → 把 `db/schema.sql` **整段粘进去** → 执行。

- 期望：无报错，出现 `items` 和 `reminders` 两张表
- ⚠️ **这个脚本会 DROP 掉同名表**（这是「可重复执行」的代价）。只在建表 / 重置环境时跑。

### 3. 跑 seed.sql

同窗口清空 → 粘 `db/seed.sql` → 执行。

- 期望：插入成功，`items` 6 行、`reminders` 6 行
- 可以**再执行一次**验证幂等：行数应该还是 6 / 6，不报错

### 4. 跑 verify.sql 验证

把 `db/verify.sql` 里的每条语句**单独**粘进去执行（不要整段一起跑，某些控制台一次只回一个结果集）。

---

## 二、select 验证步骤与期望结果

| # | 语句 | 期望 |
| --- | --- | --- |
| ① | 统计两张表行数 | `items` = **6**，`reminders` = **6** |
| ② | 列 `items` 全部字段 | 6 行；已完成的 3 条 `done_at` 有值，未完成 3 条是 `NULL` |
| ③ | 列 `reminders` 全部字段 | 6 行；其中 `item_id` 为 `NULL` 的有 2 行 |
| ④ | `JOIN items` 查挂着的提醒 | **4 行**（seed-rem-01 ~ 04） |
| ⑤ | 查 `item_id IS NULL` | **2 行**（高铁去上海、牙医预约） |

---

## 三、本地先验一遍（不依赖云端）

```bash
python db/verify_local.py
```

用 SQLite 在内存库里跑完三个 SQL 文件，11 项检查：
建表 / schema 重复执行不报错 / 两表各 ≥5 行 / seed 重复执行不报错且行数不变 /
JOIN 出 4 条 / 独立提醒 2 条 / 级联删除 / 外键拦截 / verify.sql 语句可执行。

---

## 四、两个必须记住的约定

1. **`seed-` 前缀是种子专用的。** `seed.sql` 会先删掉 `id LIKE 'seed-%'` 的行再插入。
   真实数据的 id 绝不能用这个前缀（前端 `uid()` 生成的是 base36 串，天然不会撞上）。

2. **时刻统一 ISO 8601 UTC。** 前端 `reminders.at` 现在是本地时间串 `'YYYY-MM-DDTHH:mm'`，
   入库那天要转成 UTC，不能原样搬 —— 这条记在 `api-contract.md` 的迁移清单里。
