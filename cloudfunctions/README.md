# cloudfunctions/ · 云函数源码与部署步骤

| 目录 | 提供哪个接口 | 状态 |
| --- | --- | --- |
| `health/` | `GET /api/health` | ✅ Day 15 已上线 |
| `items/` | `GET` + `POST /api/items` | ✅ Day 19 已上线（`day19`） |
| `reminders/` | `GET /api/reminders` | ✅ Day 19 已上线（`day19`） |
| `test_logic.js` | —— 本地逻辑测试（**222 项全通过**） | ✅ 本机可跑 |

> **Day 19 重构提示**：`items/` 和 `reminders/` 各自拆成了两个文件 ——
> `index.js` 是接口层（接请求 / 调函数 / 返响应），`*Repository.js` 是数据访问层（只管查库）。
> 详情见下面第 0.5 节。上传 zip 时**必须整包部署**，只传 `index.js` 云端会找不到 repository。

本机跑测试（不需要 CloudBase，不联网也能跑）：

```bash
node cloudfunctions/test_logic.js
```

它把 `https.request` 换成假的，检查方法守卫、参数校验、查询串拼接、信封形状、错误处理。
**它不验证真实数据库** —— 真实链路靠第 4 步 curl 公网地址来验。

---

## 0.5. 分层结构（Day 19 重构后）

判断一段代码该放哪层，问一句：**「换掉数据库，这段代码要不要改？」**
要改 → 放 repository；不用改 → 留在接口层。

```
   HTTP 请求
      │
┌─────────────▼──────────────────────────────┐
│  接口层  index.js                （Day 19 拆出）│
│  · 只认 method 和 query/body 参数             │
│  · 参数校验（缺字段 / 超长 / 日期不真实）      │
│  · 决定返回 200 / 201 / 400 / 405 / 409 / 500 │
│  · 包装信封 {ok:true,data} / {ok:false,error} │
│  ❌ 不写任何 SQL、不拼查询串、不碰 https      │
└─────────────┬──────────────────────────────┘
              │  repo.list() / repo.insert(row)
              ▼
┌─────────────────────────────────────────────┐
│  数据访问层  *Repository.js       （Day 19 新增）│
│  · 拼 PostgREST 查询串（select / order / limit）│
│  · 发 https 请求、带API Key                   │
│  · 设置 Prefer 头                            │
│  · 解析 JSON、把 409 / 23505 识别成主键冲突    │
│  ❌ 不做参数校验、不组装响应体                 │
└─────────────┬──────────────────────────────┘
              ▼
        PostgREST 网关 → PostgreSQL
   （api.tcloudbasegateway.com，service_role 绕过 RLS）
```

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `items/index.js` | 354 | items 接口层 |
| `items/itemsRepository.js` | 178 | items 全部数据库交互 |
| `reminders/index.js` | 116 | reminders 接口层 |
| `reminders/remindersRepository.js` | 130 | reminders 全部数据库交互 |

**为什么 repository 放在各自函数目录里、不放公共目录？**
CloudBase 按函数独立打包 —— `require('../db')` 在云端找不到文件。共用代码只能走 HTTP 调用另一个函数。
两个 repository 有少量重复（拼查询串、带 Key），这是**故意的**：跨函数共用要付出一次网络往返的代价，
对这种「一次 HTTP 调用」的工具不值得。重复比耦合便宜。

**重构的铁律：行为不许变。**验证办法见第 4.5 节。

---


## 0. 先拿服务端 API Key（两个函数共用，只需做一次）

> ⚠️ 这是凭据。**不要把它贴进聊天窗口、不要提交进仓库、不要写进前端代码。**
> 只在控制台里从「API Key 配置」页复制到「云函数环境变量」页。

1. CloudBase 控制台 → 左下角 **环境管理**
2. 中间菜单 **环境配置 → API Key 配置**
3. 页面**下半部分**「服务端 API Key」区域 → **创建 API Key**
4. 名称随便填（比如 `habit-func`）→ 创建 → **立刻复制明文**

| 别踩 | 说明 |
| --- | --- |
| 明文只显示一次 | 弹窗关掉就再也看不到，只能删了重建 |
| 别拿 Publishable Key | 页面上半部分那个是**客户端**用的，映射成 `anon` 角色，查不到数据。要下半部分的**服务端** Key |
| 单个环境最多 5 个 | 够用，别重复建 |

---

## 1. 建云函数 `items`

1. 左侧 **云函数** → **新建云函数**
2. 函数名填 **`items`**；运行环境 **Node.js 18**（16 也行，代码没用 18 的新特性）；
   创建方式 **空白函数**
3. 进函数 → **函数代码** → 把仓库里 `cloudfunctions/items/index.js` **整段粘进去**，覆盖掉模板
4. 点 **保存并安装依赖**（`package.json` 没有依赖，不用上传；只粘 `index.js` 就够）
5. 函数配置 / 高级配置 → **环境变量** → 加一条：

   | 变量名 | 值 |
   | --- | --- |
   | `CLOUDBASE_APIKEY` | 第 0 步复制的服务端 API Key |

   > 有些版本的控制台在「函数配置」里直接有「**开启 API Key**」开关，开了它会自动注入，
   > 那就不用手动填。**两种都行，代码里两个名字都认**（`CLOUDBASE_APIKEY` 优先）。
   > 判断依据：部署后 curl，如果返回 `CONFIG_MISSING` 就说明没注入成功，回来手动填环境变量。

---

## 2. 开 HTTP 访问服务

1. 左侧 **HTTP 访问服务** → **新建**
2. 路径填 **`/api/items`** → 关联云函数 **items** → 方法 **GET**
3. 记下默认域名（跟 `/api/health` 是同一个）：
   `https://habit-checkin-d9giln6ke6594e88b-1499597872.ap-shanghai.app.tcloudbase.com`

---

## 3. `reminders` 照抄一遍

同样的三步，把 `items` 换成 `reminders`：

- 云函数名 **`reminders`**，代码贴 `cloudfunctions/reminders/index.js`
- 环境变量同样加 `CLOUDBASE_APIKEY`（**每个函数是独立的包，得各自配一遍**）
- HTTP 路径 **`/api/reminders`** → 关联函数 **reminders**

> 为什么不做成一个函数 + 两条路由：CloudBase 按函数打包，两条路由指向同一个函数时
> 要靠 `event.path` 分辨，而不同控制台版本给的字段不一样，赌不起。
> 两个函数各自独立、各自知道自己是干嘛的，出错面最小。代价是公共逻辑重复了一份
> （`items/index.js` 和 `reminders/index.js` 里那段读库代码是一样的）—— 这是刻意的取舍，
> 等函数数量到四个以上再考虑抽公共层走 zip 上传。

---

## 4. 验证（我这边能 curl，把域名给我就不用你判断）

部署完把「HTTP 访问服务的默认域名」告诉我，或者你自己打开浏览器看也行。

### 4.1 正常读

```bash
curl -s https://<默认域名>/api/items
curl -s https://<默认域名>/api/reminders
```

期望：`{"ok":true,"data":[ ... ]}`，`data` 是数组，各 6 条（seed 数据）。

### 4.2 加练：查询参数

```bash
curl -s "https://<默认域名>/api/items?date=2026-10-02"        # 只返回那一天的
curl -s "https://<默认域名>/api/items?limit=2"                  # 只返回 2 条
curl -s "https://<默认域名>/api/reminders?item_id=seed-item-01" # 只返回挂在这条清单下的
```

### 4.3 错误路径（也得是「设计好的错」，不是 502）

| 请求 | 期望 |
| --- | --- |
| `?date=2026/10/02` | 400 `BAD_REQUEST`，消息说 date 要 `YYYY-MM-DD` |
| `?limit=0` / `?limit=201` / `?limit=abc` | 400 `BAD_REQUEST` |
| 用 POST 请求 | 405 `BAD_REQUEST` |

### 4.4 证明「接口读的是真数据库」

光返回 6 条还不够 —— seed 数据写死在前端也能伪造出同样的结果。
**必须改一行库里的数据，看接口跟着变**：

1. 控制台 → PostgreSQL → SQL 编辑器，执行：

   ```sql
   UPDATE items SET title = '读两章书' WHERE id = 'seed-item-01';
   ```

2. 重新 `curl /api/items`
3. 期望：第一条的 `title` 变成「读两章书」 ← **这一变，链路就证明是真的了**

验完改回去：

```sql
UPDATE items SET title = '读一章书' WHERE id = 'seed-item-01';
```

（具体原值以 `db/seed.sql` 里写的为准。）

---

## 4.5. 重构后怎么证明「行为没变」（Day 19 加）

改完代码、光跑通一次**不算验证** —— 新代码能返回 200 只说明它没崩，不说明它跟以前一样。
要证的是「**输出和重构前逐字段一致**」。

### 三步

**① 部署前先录基线。** 重构之前就把当前线上响应存下来，这是唯一的对照组：

```bash
BASE=https://habit-checkin-d9giln6ke6594e88b-1499597872.ap-shanghai.app.tcloudbase.com/api
curl -s -o before_items.json"$BASE/items" -H "Cache-Control: no-cache"
curl -s -o before_reminders.json  "$BASE/reminders" -H "Cache-Control: no-cache"
```

**② 部署后再抓一次**，然后算**集合指纹**（排序无关）：

```python
import json, hashlib
def rows(f): return json.load(open(f))["data"]
def setfp(rs):                      # 排序无关：按 id 排完再哈希
    return hashlib.sha256(
        json.dumps(sorted(rs, key=lambda r: r["id"]),
                   sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()[:16]
print(setfp(rows("before_items.json")) == setfp(rows("after_items.json")))
```

**③ 再手工过一遍错误路径** —— 指纹只能证明成功路径一致，失败路径得逐个点：
405 / 400 / 409 / 500各打一次，看状态码和 `error.code` 对不对。

### ⚠️ 两个已经踩过的坑

**坑一：不要用「响应字节完全相同」当判据。**
Day 19 实测：重构后 `GET /items` 的指纹变了，逐行排查后发现**数据一个字段没变，
只是返回顺序换了**（`seed-item-02` 和 `seed-item-03` 换了位）。
原因是 PostgREST 不带 `order` 时，返回顺序由数据库的执行计划决定，
SQL 写法一变，计划可能就变。→ 所以必须用**排序无关的集合指纹**。

**坑二：比对前先排除你自己刚写进去的数据。**
跑 POST 验证时会真往库里加一行，行数从 11 变 12，指纹必然不同。
比之前要先把那条 id 过滤掉，否则会把「预期内的新增」误判成「行为变了」。

### 结论长什么样

| # | 项 | 重构前 | 重构后 |
| --- | --- | --- | --- |
| GET /items | 行数 + 集合指纹 | 11 行 / `60ad761a81b262bc` | 11 行 / `60ad761a81b262bc` ✅ |
| GET /reminders | 行数 + 集合指纹 | 6 行 / `5da32782f5e24351` | 6 行 / `5da32782f5e24351` ✅ |
| GET /reminders?item_id=… | 行数 + 集合指纹 | 1 行 / `0638666fe6e32a71` | 1 行 / `0638666fe6e32a71` ✅ |
| POST /items 新 id | 状态码 | 201 Created | 201 Created ✅ |
| POST 同 id 重复 | 状态码 + 老数据 | 409，且`created_at` 不变 | 409，且 `created_at` 不变 ✅ |
| POST /reminders | 状态码 | 405 | 405 ✅ |
| OPTIONS /items | 状态码 + 允许方法 | 204 / `GET, POST, OPTIONS` | 204 / `GET, POST, OPTIONS` ✅ |
| 响应头 `X-Version` | 值 | `day18` / `day17` | `day19` / `day19` ✅ |

`X-Version` 是**部署探针** —— 它变了才说明新代码真上线了。
响应没变但 `X-Version` 没变，通常是压根没部署成功（见第 5 节排障表）。

---

## 5. 排障表

| 现象（看 `error.code`） | 意思 | 怎么办 |
| --- | --- | --- |
| `CONFIG_MISSING` | 云函数没拿到 API Key | 手动加环境变量 `CLOUDBASE_APIKEY`。**报错消息里会列出当前可见的相关变量名**，照着对一下拼错没 |
| `UPSTREAM` + 401 / 403 | Key 无效或权限不够 | 多半是拿成了 Publishable Key（anon 角色）。换服务端 API Key |
| `UPSTREAM` + 404 或 `relation does not exist` | 表不存在 / 没暴露 | 回 PostgreSQL 确认 `items`、`reminders` 在 `public` schema 下；必要时重跑 `db/schema.sql` + `db/seed.sql` |
| `data` 是 `[]` 但不是报错 | 表是空的 | 重跑 `db/seed.sql` |
| `UPSTREAM` + 超时 | 网关没通 | 确认环境 ID 是 `habit-checkin-d9giln6ke6594e88b`（代码里也写死兜底了这个值） |
| 改了代码但结果没变 | 没重新部署 / 缓存 | 看响应头 `X-Version`（重构后应是 `day19`）；curl 加 `-H "Cache-Control: no-cache"` |

---

## 6. 仍然刻意不做的事

| 不做 | 原因 |
| --- | --- |
| `PATCH` / `DELETE` 接口 | 第 4 周（Day 20+）的事 |
| 批量写入 | 没有批量需求，先把单条写入做扎实 |
| 改接口路径和字段名 | 契约写在 `api-contract.md`，**契约不许动** |
| 前端接进来 | 数据形状已定死，前端字段映射（`date` ↔ `plan_date` 等）待接 |
| 鉴权 / 用户体系 | 还没有用户概念，全靠 service_role 直读 |

