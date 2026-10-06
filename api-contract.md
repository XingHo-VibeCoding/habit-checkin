# api-contract.md · 接口契约

Day 15 产出。**这份文件定义「前端和后端之间怎么说话」**，跟具体实现分开 ——
先把契约定下来，后面换云厂商、换语言，只要照着契约实现就行，前端不用跟着改。

> ⚠️ 当前状态（2026-10-06）：`/api/health`、`GET /api/items`、`GET /api/reminders`、`POST /api/items`
> 四个接口已有真云函数（Day 15 / 17 / 18）。`PATCH`、`DELETE` 仍未实现。
> **前端目前仍然完全走 localStorage，还没接后端** —— 接的那天见「前端字段映射」一节。

---

## 通用约定

| 项 | 约定 |
| --- | --- |
| 前端公网地址 | `https://daily-checkin-list.app.workbuddy.host/` |
| 云函数 Base URL | `https://<CloudBase 环境域名>/api`（开通后填，见下「待填」） |
| 请求 / 响应格式 | `application/json; charset=utf-8` |
| 时间格式 | ISO 8601，统一 UTC（`2026-10-02T06:50:00.000Z`）—— 别用本地时间字符串，跨时区会错 |
| 跨域 CORS | ✅ Day 18 已配（`Access-Control-Allow-Origin: *` + `OPTIONS` 预检） |
| 失败结构 | 一律 `{ ok: false, error: { code, message } }`，不用 HTTP 码猜原因 |

**失败结构的理由**：HTTP 状态码只说「哪一类错」（4xx/5xx），说不清「具体哪一步错了」。
把业务错误码放进 body，前端才能给出人话提示（「这条已经删过了」而不是「请求失败」）。

---

## GET /api/health

健康检查。**它的作用不是「证明服务活着」，是「证明整条链路通」** ——
域名解析、HTTPS、云函数冷启动、运行时、返回序列化，任何一环断了它都会失败。
所以它是部署后第一个该访问的接口，也是出问题时第一个该看的。

### 请求

无参数、无 body、无需鉴权。

```bash
curl -s https://<CloudBase 环境域名>/api/health
```

### 响应 200

```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "service": "habit-checkin",
    "time": "2026-10-02T06:50:00.000Z",
    "version": "day15"
  }
}
```

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `ok` | boolean | 固定 `true`。外层统一信封，前端先看它再看 `data` |
| `data.status` | string | 固定 `"ok"`。留着是为了将来能返回 `"degraded"`（依赖降级但还能用） |
| `data.service` | string | 服务名，用于确认「我打的是不是这个环境」—— 环境搞混时这一眼能看出来 |
| `data.time` | string | 服务端当前时间（ISO 8601 / UTC）。用来判断是不是拿到了缓存的旧响应 |
| `data.version` | string | 发版标记。改完云函数没生效时，先看它有没有变 |

### 失败

```json
{ "ok": false, "error": { "code": "INTERNAL", "message": "..." } }
```

约定错误码（`INTERNAL` 是 Day 15 定的，Day 17 补了后两个）：

| code | 场景 |
| --- | --- |
| `INTERNAL` | 未捕获异常 |
| `BAD_REQUEST` | 参数不合法 / 方法不允许 / 请求体格式错 |
| `NOT_FOUND` | 资源不存在 |
| `UNAUTHORIZED` | 未登录 / 身份无效（引入用户体系后才有） |
| `CONFIG_MISSING` | **Day 17 新增**：云函数缺环境变量（拿不到 API Key） |
| `UPSTREAM` | **Day 17 新增**：依赖（PG REST 层）返回非 2xx 或不是 JSON |
| `DUPLICATE` | **Day 18 新增**：主键撞了，即重复提交 |

**为什么后两个要单独成码，不合并进 `INTERNAL`**：它们的排查动作完全不同 ——
`CONFIG_MISSING` 要去函数配置里补环境变量，`UPSTREAM` 要去查数据库和网关。
合并成一个码的话，每次出错都得先读消息再猜是哪一类，部署阶段的排障速度会掉一半。
`DUPLICATE` 同理：它是**正常业务结果**（用户手快点了两下），不是故障，
报成 500 会让监控误判，也会让前端弹「服务器出错了」这种吓人的提示。

---

## GET /api/items（Day 17 已实现）

拉取清单条目，读的是 PostgreSQL 的 `items` 表。

### 请求

```bash
curl -s https://<CloudBase 环境域名>/api/items
curl -s "https://<CloudBase 环境域名>/api/items?date=2026-10-02"
curl -s "https://<CloudBase 环境域名>/api/items?limit=2"
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `date` | 否 | 不过滤 | `YYYY-MM-DD`，只返回 `plan_date` 等于它的行。格式不对直接 400，不往下拼 SQL |
| `limit` | 否 | `100` | 返回条数上限，取值 **1–200**。设上限是因为不设的话 `?limit=99999999` 会把读接口打成全表扫描 |

### 响应 200

```json
{
  "ok": true,
  "data": [
    {
      "id": "seed-item-01",
      "title": "读一章书",
      "plan_date": "2026-10-02",
      "done": 0,
      "created_at": "2026-10-02T00:00:00.000Z",
      "done_at": null
    }
  ]
}
```

**`data` 就是数据库行的原样数组，字段名用数据库列名**（`plan_date` 而不是前端的 `date`）。

为什么不在这里就转成前端的形状：转换规则记在本文件「前端字段映射」一节，
但**转换动作留到前端接入那天（Day 20）做**。两端同时改，一旦字段名对不上，
分不清是接口错了还是前端错了 —— 现在这样「库里有什么接口就吐什么」，出错时一眼能定位。

排序固定为 `plan_date` 升序、同日期按 `created_at` 升序，前端拿到即可直接渲染，不用再排。

### 失败

| 情况 | 响应 |
| --- | --- |
| 方法不是 GET | 405 `BAD_REQUEST` |
| `date` 不是 `YYYY-MM-DD` | 400 `BAD_REQUEST` |
| `limit` 非数字 / <1 / >200 | 400 `BAD_REQUEST` |
| 云函数没配 API Key | 500 `CONFIG_MISSING` |
| 数据库 REST 层报错 | 500 `UPSTREAM`（消息里带上游状态码） |

### 它怎么读到数据库的

云函数不直连 PostgreSQL 的 TCP 端口 —— **体验版环境里 TCP 直连是走不通的**（内网要内网互联、外网开关也不给开）。

走的是 CloudBase 自带的 PostgREST 层：

```
GET https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/items?select=*&limit=100
Authorization: Bearer <服务端 API Key>
```

API Key 被网关解成 `service_role`，绕过 RLS。
**为什么用 service_role 而不是转发调用方 token**：本环境还没做用户体系，表上也没有 RLS 策略，
RLS 开着但零策略 = 拒绝所有非 service_role 的访问，转发 token 那条路会查到 0 行。

**SQL 注入怎么防**：代码里没有拼接原始 SQL。查询条件（`date`、`item_id`、`limit`）都是作为 URL 参数传给 PostgREST，
`date` 和 `limit` 在拼 URL 之前会先校验格式，`item_id` 会 `encodeURIComponent`。PostgREST 自己会把这些参数当绑定值处理，
不存在字符串拼接 SQL 的注入面。等价于「参数化查询」，只是交互协议是 HTTP 而不是 `PREPARE`。

---

## POST /api/items（Day 18 已实现）

新增一条清单条目。**这是第一个会改数据库的接口** —— Day 15–17 全是只读，
写操作第一次进来，防重复提交就成了核心问题。

### 请求

```bash
curl -s -X POST https://<CloudBase 环境域名>/api/items \
  -H 'Content-Type: application/json' \
  -d '{"id":"lq8f2k","title":"读一章书","plan_date":"2026-10-06"}'
```

body 是一个 JSON 对象，字段如下（**只认这些，多一个都报错**）：

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `id` | ✅ | string | **幂等键**，由调用方生成。重试时必须用同一个 id。见下节。只能含字母数字 `-` `_`，≤36 字 |
| `title` | ✅ | string | ≤200 字，前后空格自动 trim，不能是空串或纯空格 |
| `plan_date` | ✅ | string | `YYYY-MM-DD`，且**必须是真实存在的日子**（`2026-02-31` 会被拒） |
| `done` | ❌ | 0/1 | 默认 `0`。其它值一律拒绝（不收 `"0"` 字符串） |
| `created_at` | ❌ | string | 省略则取服务器当前时间（UTC ISO 串） |
| `done_at` | ❌ | string \| null | 默认 `null`。给了就必须是能解析的时间串，且 `done` 必须是 1 |

⚠️ **前端字段名不能直接发**：`date` / `createdAt` / `doneAt` 发过来会被拒（报「不认识的字段」）。
这是故意的 —— 静默忽略会得到一个 `plan_date` 为空的请求，数据库只回一句
`NOT NULL violation`，指向错误的排查方向。转换表见「前端字段映射」。

### 响应 201

```json
{
  "ok": true,
  "data": {
    "id": "lq8f2k",
    "title": "读一章书",
    "plan_date": "2026-10-06",
    "done": 0,
    "created_at": "2026-10-06T06:50:00.000Z",
    "done_at": null
  }
}
```

`data` 是**数据库回读的那一行**（`Prefer: return=representation`），不是回显发出去的请求体。
两者理论上相同，但用回读能证明「真的写进去了」，而不是「我以为写进去了」。
`data` 是对象不是数组 —— 一次 POST 只对应一行。

### 防重复提交：为什么 id 必须由调用方生成

**要防的是什么**：同一条内容被提交两次 —— 用户手快点两下「添加」、网络卡了自动重发、页面卡住用户又点了一次。

**不要防的是什么**：内容不同的两条。今天读两本书，第二本不叫重复，不该被挡。

**机制**：`id` 是主键，做幂等键。同一条内容提交两次带的是同一个 id，第二次撞主键 → `409`。

```
同一个 id 第一次  →  201，库里多一行
同一个 id 第二次  →  409 DUPLICATE，库里行数不变
不同的 id 两次    →  两条 201，两行都入库（合法，不该被挡）
```

**为什么 id 不能由服务端生成**：那样每次请求都是「新的一条」，手快点两下就插两条，
幂等键形同虚设。**发请求的一方必须持有 id** —— 只有它知道「这两条是不是同一件事」。

**为什么不靠「标题查重」**：会把合法内容也挡掉；而且查重和插入之间有时间差（两个请求都查到
「没有」→ 都插 → 两行都进去了），是竞态，比不防更糟。

**⚠️ 为什么代码里死也不能加 `Prefer: resolution=merge-duplicates`**：
那个头会把主键冲突从「报错」变成**静默 upsert** —— 重复提交不报错，
还把老那一行覆盖成新内容。这比不防更糟，因为用户以为在新增，实际在悄悄改数据。
本地测试里有一条断言专门盯这个（`Prefer 头绝不含 resolution`），改坏了立刻红。

### 失败

| 情况 | 响应 | 说明 |
| --- | --- | --- |
| 同 `id` 已存在 | `409 DUPLICATE` | 提示里会说「换一个 id」 |
| 缺 `id` / `title` / `plan_date` | `400 BAD_REQUEST` | 提示是中文，直接可展示 |
| `title` 超 200 字 | `400 BAD_REQUEST` | |
| `plan_date` 格式错或日子不存在 | `400 BAD_REQUEST` | |
| `done` 不是 0/1 | `400 BAD_REQUEST` | |
| `done=0` 却给了 `done_at` | `400 BAD_REQUEST` | 自相矛盾 |
| 出现不认识的字段 | `400 BAD_REQUEST` | 提示会列出「不认识哪个字段 + 允许哪些」 |
| body 不是合法 JSON / 是数组 | `400 BAD_REQUEST` | 数组不接受（今日不做批量） |
| 上游 4xx（约束不满足） | `400 BAD_REQUEST` | 消息带上游原文 |
| 上游 5xx | `502 UPSTREAM` | |
| 方法不是 GET/POST/OPTIONS | `405 BAD_REQUEST` | |

**所有校验都在打数据库之前做完**：非法输入一个字节都不会写进库里。
理由是数据库的 CHECK / NOT NULL 是最后一道防线，不是输入校验 ——
靠它们挡下请求，拿到的是 PostgreSQL 的原文报错，不是能给人看的提示。

### `2026-02-31` 这种「格式对但日子不存在」为什么单独查

数据库的 CHECK 只验形状（`LIKE '____-__-__'`），`2026-02-31` 能过。
所以代码里多查一层真实存在性（含闰年）。
宁可现在告诉用户「这天不存在」，也别写进去之后排序时才发现。

---

## GET /api/reminders（Day 17 已实现）

拉取提醒，读的是 PostgreSQL 的 `reminders` 表。

### 请求

```bash
curl -s https://<CloudBase 环境域名>/api/reminders
curl -s "https://<CloudBase 环境域名>/api/reminders?item_id=seed-item-01"
```

| 参数 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `item_id` | 否 | 不过滤 | 只返回挂在这条清单下的提醒 |
| `limit` | 否 | `100` | 同 `/api/items` |

⚠️ **不传 `item_id` 时，独立提醒（`item_id` 为 `NULL`）也会一起返回** —— 这是刻意的。
前端要画的是「今天所有会响的提醒」，不是「某条清单的附属品」，所以默认不过滤。

### 响应 200

```json
{
  "ok": true,
  "data": [
    {
      "id": "seed-rem-05",
      "item_id": null,
      "title": "高铁去上海",
      "remind_at": "2026-10-05T01:00:00.000Z",
      "lead_minutes": 60,
      "done": 0
    }
  ]
}
```

同样用数据库列名。排序固定 `remind_at` 升序。

`item_id` 为 `null` 的行就是独立提醒 —— 这正是 Day 16 把 `item_id` 定成**可空**的原因。

### 失败

同 `/api/items`，外加：`item_id` 超过 64 字符 → 400 `BAD_REQUEST`（防畸形输入进 URL）。

---

## 尚未实现的接口（Day 20+，只占位）

这些**先写在这里是为了让前端知道将来会有什么**，避免到时候接口来回改。

| 接口 | 用途 | 状态 |
| --- | --- | --- |
| `GET /api/items` | 拉取清单 | ✅ **Day 17 已实现**，Day 19 重构为分层 |
| `GET /api/reminders` | 拉取提醒 | ✅ **Day 17 已实现**，Day 19 重构为分层 |
| `POST /api/items` | 新增一条 | ✅ **Day 18 已实现**，Day 19 重构为分层 |
| `PATCH /api/items/:id` | 改（勾掉 / 改名） | 未实现（第 4 周） |
| `DELETE /api/items/:id` | 删除 | 未实现（第 4 周） |
| `GET /api/anniversaries` | 拉取倒数纪念日 | 未实现（**表也没建**） |

⚠️ **前端现在仍然完全走 localStorage**（`habit-checkin:v1` 一个 key）。
上面三个接口已经能读写真数据，但前端还没接 —— 接的那天要同时做字段映射（见数据模型一节）。

---

## Day 19 重构说明（实现细节，不影响本契约）

**契约层面零改动** —— 路径、字段名、状态码、响应形状、错误码全部不变，
所以这份契约在 Day 19 前后完全适用。变的只有代码内部怎么组织：

| | 重构前 | 重构后 |
| --- | --- | --- |
| items | `items/index.js`（查库+ 接口混在一起，464 行） | `items/index.js`（接口层，354 行）+ `items/itemsRepository.js`（数据访问层，178 行） |
| reminders | `reminders/index.js`（170 行） | `reminders/index.js`（接口层，116 行）+ `reminders/remindersRepository.js`（数据访问层，130 行） |

分层判据：**「换掉数据库，这段代码要不要改？」** 要改 → repository；不用改 → 接口层。

部署探针：两个函数的响应头 `X-Version` 都从`day18`/`day17` 变成了 `day19`。

回归验证结果见 `cloudfunctions/README.md` 第 4.5 节（含两个踩过的坑：返回顺序会变、
比对前要排除自己刚写入的数据）。


---

## 数据模型（Day 16）

脚本都在 `db/`：`schema.sql`（建表）、`seed.sql`（种子）、`verify.sql`（select 验证）、
`verify_local.py`（本地 SQLite 实跑，**11/11 通过**）、`db/README.md`（控制台执行步骤）。
**表结构就是从本文件推导的**：契约里写 `/api/items` 和 `/api/reminders`，表就是 `items` 和 `reminders`。

### 两张表与关联字段

| 表 | 存什么 | 字段 |
| --- | --- | --- |
| `items` | 每日清单条目 —— 今天要勾的那几件事 | `id` PK、`title`、`plan_date`、`done`、`created_at`、`done_at` |
| `reminders` | 提醒 —— 到点要响的那几件事 | `id` PK、**`item_id` FK**、`title`、`remind_at`、`lead_minutes`、`done` |

**关联字段：`reminders.item_id` → `items.id`**

- 有值 = 这条提醒挂在某条清单上，清单删了它跟着删（`ON DELETE CASCADE`）
- **为 NULL = 独立提醒**，跟任何清单无关（比如「高铁去上海」）
- 所以 `item_id` **必须可空**：定成 `NOT NULL` 的话，独立提醒这种真实存在的数据就存不进来

### 约束一览

| 表 | 约束 | 挡住什么 |
| --- | --- | --- |
| 两表 | `PRIMARY KEY (id)` | 重复 id |
| `reminders` | `FOREIGN KEY (item_id) → items(id) ON DELETE CASCADE` | 指向不存在的清单；删清单留孤儿提醒 |
| `items` | `CHECK (plan_date LIKE '____-__-__')` | `'2026/10/02'`、`'明天'` 这类不规范的日期 |
| 两表 | `CHECK (done IN (0, 1))` | 布尔位被写成 2 |
| `reminders` | `CHECK (lead_minutes >= 0)` | 负数提前量 |
| 两表 | `NOT NULL` + `DEFAULT` | 缺字段、缺默认值 |

### 映射到上面的接口

| 接口 | 落到哪张表 |
| --- | --- |
| `GET/POST/PATCH/DELETE /api/items` | `items` |
| `GET /api/reminders` | `reminders`（可带 `?item_id=` 过滤挂在某条清单下的） |
| `GET /api/anniversaries` | ⚠️ **尚未建表**，按 Day 16 降级条款可延到 Day 19–20 |

### 前端字段映射（Day 20 前端接入时照此转换）

| 前端（localStorage） | 数据库 |
| --- | --- |
| `items.date` | `plan_date` |
| `items.createdAt` / `doneAt` | `created_at` / `done_at` |
| `reminders.at` | `remind_at` —— ⚠️ 前端存的是**本地时间串**，入库要转 UTC |
| `reminders.lead` | `lead_minutes` |

⚠️ **GET 和 POST 都不做这层转换，直接用数据库列名。**
理由写在 `/api/items` 一节 —— 转换动作推迟到前端接入那天，
避免接口和前端同时改、字段名对不上时定位不了是哪边的锅。
所以这张表是**接前端那天**的对照表，不是接口的验收项。
POST 更是**主动拒绝**前端字段名（发 `date` 会得到「不认识的字段：date」）。

### 与 CloudBase 的关系

`db/` 下的 SQL 刻意写成 **PostgreSQL / MySQL / SQLite 都能跑的子集**：
云端没开通时我本地用 SQLite 实跑验证，Henry 在控制台 PostgreSQL 里直接跑。
类型一律挑三家都认的（`VARCHAR(n)` / `CHAR(n)` / `SMALLINT` / `INT`）。

**可重复执行是怎么做到的（两个脚本手段不同，因为诉求不同）**：

| 脚本 | 手段 | 代价 |
| --- | --- | --- |
| `schema.sql` | `DROP TABLE IF EXISTS` + `CREATE TABLE`（先删子表再删父表） | ⚠️ **会连同真实数据一起删**，只在建表 / 重置环境时跑 |
| `seed.sql` | `DELETE FROM t WHERE id LIKE 'seed-%'` + `INSERT` | ⚠️ 会删掉 `seed-` 前缀的行，所以真实数据 id 绝不能用这个前缀 |

为什么 seed 不用 upsert：MySQL 写 `INSERT IGNORE` / `ON DUPLICATE KEY UPDATE`，
PostgreSQL 写 `ON CONFLICT DO NOTHING`，SQLite 写 `INSERT OR IGNORE` ——
**三套方言不通用**；跨方言是硬要求（要能本地验），所以选了 DELETE + INSERT。

控制台执行步骤与 select 验证语句见 `db/README.md` 与 `db/verify.sql`。

---

## 前端怎么在「真数据 / mock」之间切

现成的开关（Day 8 就有，不用新写）：

| 网址 | 看到什么 |
| --- | --- |
| `?state=mock` | 假数据版（3 条清单 + 2 条提醒），演示和截图用 |
| `?state=empty` | 空态 |
| `?state=loading` | 骨架屏 |
| `?state=error` | 取数据失败的样子 |

将来接真实 API 时**只改 `fetchState()` 内部那一小块**，页面与渲染不用动 —— 这是当初把数据层抽出来的目的。

---

## 待填（CloudBase 开通后回来补）

| 项 | 现在 | 补什么 |
| --- | --- | --- |
| 环境 ID | `habit-checkin-d9giln6ke6594e88b` | ✅ 已拿到 |
| 云函数 Base URL | `https://habit-checkin-d9giln6ke6594e88b-1499597872.ap-shanghai.app.tcloudbase.com/api` | ✅ 已拿到 |
| 剩余额度 / 到期日期 | ✅ 到期 **2027-04-02 23:59:59** / 资源点 **2999.91 / 3000 点**（已用 0.09 点） | 控制台「套餐用量」或「环境购买」页面（今天要交的截图里就要这三样） |

---

## 验收方式（历史记录）

Day 15 的验收项，全部早已达成：

1. `curl` 健康检查 → `{ ok: true, ... }` ✅
2. 手机浏览器打开前端公网地址 → 同伴能打开 ✅
3. 本文件在仓库里 ✅

Day 17 加的：`GET /api/items`、`GET /api/reminders` 返回真数据 ✅
Day 18 加的：`POST /api/items` 能真写入、能读回、重复提交被拒 ✅

云函数 Base URL（Day 15 开通后拿到，Day 16 起实测可用）：

```
https://habit-checkin-d9giln6ke6594e88b-1499597872.ap-shanghai.app.tcloudbase.com/api
```

---

## 附录：CloudBase 开通与部署步骤（给 Henry 照着点）

⚠️ 菜单名会随着控制台改版微调，**找不到就把当前页面截给我**，别硬猜。
这版是 2026-10-02 按当时的控制台整理的，未经实测。

### 0. 先确认要不要开

| 项 | 情况 |
| --- | --- |
| 需要什么 | 腾讯云账号（**微信扫码就能登录**）+ **实名认证**（身份证 / 人脸） |
| 费用 | 按量计费，新用户通常有免费额度，超出才扣费。**建议开通后设一个费用告警** |
| 我能不能代办 | **不能** —— 实名这一步只能本人 |
| 卡住怎么办 | 见文末「卡住的降级」 |

### 1. 开通环境

1. 打开 `https://console.cloud.tencent.com/tcb`（或搜「腾讯云 云开发 CloudBase」）
2. 微信扫码登录 → 按提示完成实名
3. 「新建环境」：环境名填 `habit-checkin`，计费方式选**按量计费**（先用免费额度）
4. **记下环境 ID**（形如 `habit-checkin-1a2b3c4d`）← 这是要交的截图要素之一

#### ⚠️ 选「免费体验版」要先领兑换码（2026-10-02 实测）

控制台里**免费体验版不是直接点就能开**，它会要求填一个兑换码。领码要走公众号，**不在控制台里**：

| 步 | 做什么 |
| --- | --- |
| 1 | 微信搜索公众号 **「腾讯云开发 CloudBase」** → 关注 |
| 2 | 在公众号对话框里发送 **「领取兑换码」**（就这五个字，别加别的） |
| 3 | 公众号自动回一个专属兑换码（20 位左右的字符串）→ **复制下来** |
| 4 | 回控制台新建环境页 → 环境名填 `habit-checkin` → 把兑换码粘进「兑换码」输入框 |
| 5 | 点「立即购买」→ 金额是 **¥0**，不是真扣钱 → 资源到账 |

| 项 | 说明 |
| --- | --- |
| 权益 | 6 个月免费体验资源包 |
| 限制 | **每个账号限领 1 次**；领取后 **30 天内要用掉**，过期作废 |
| 别踩 | 网上教程里贴的示例兑换码（形如 `LRot4KwLFJnNMZLLn8An41`）**是别人领过的，别拿来用**，必须自己领专属的 |
| 备用 | 若页面上**没有兑换码输入框**，说明当前账号已自动发放免费额度，直接点开通即可，不用管上面这几步 |

### 2. 建云函数

1. 左侧「云函数」→「新建云函数」
2. 函数名 `health`；创建方式「空白函数」；运行环境 Node.js（16 / 18 都行）
3. 进函数 →「函数代码」→ 把仓库里 `cloudfunctions/health/index.js` **整段粘进去**
   （`package.json` 不用传 —— 没有依赖）
4. 点「保存并安装依赖」→ 等到状态变成部署成功

### 3. 开 HTTP 访问服务

1. 左侧「HTTP 访问服务」→「新建」
2. 路径填 `/api/health`，关联云函数 `health`，方法 GET
3. **记下默认域名**（形如 `https://xxx.service.tcloudbase.com`）← 要交的截图里地址栏就是这个

### 4. 验证

浏览器或手机打开 `https://<默认域名>/api/health`，应看到：

```json
{ "ok": true, "data": { "status": "ok", "service": "habit-checkin", "time": "...", "version": "day15" } }
```

也可以把域名发我，我 curl 验 —— **我这边能验，就不用你判断对不对**。

### 5. 今天要交的三张截图

| # | 画面里必须有 |
| --- | --- |
| 1 | 地址栏是 `/api/health` + 页面上是上面那段 JSON |
| 2 | 同伴手机上打开 `https://daily-checkin-list.app.workbuddy.host/` |
| 3 | 控制台环境概览：**环境 ID、剩余额度、到期日期**三项同框 |

### 6. 完了把这三样给我

环境 ID、HTTP 域名、额度与到期日期 → 我填进上面「待填」，并 curl 实测一遍写进验收记录。

### 卡住的降级

- **实名卡住 / 不想开** → 先不开。`/api/health` 的静态 mock 已经公网可访问，
  按任务清单的「卡住降级」这已经达标；**Day 20 之前补齐即可**。
- **云函数部署报错** → 把报错原文发我，别自己反复重试。
- **HTTP 访问服务 404** → 多半是路径没关联上，或刚保存还没生效（等 1 分钟再试）。
