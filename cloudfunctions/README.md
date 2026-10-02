# cloudfunctions/ · 云函数源码与部署步骤

| 目录 | 提供哪个接口 | 状态 |
| --- | --- | --- |
| `health/` | `GET /api/health` | ✅ Day 15 已上线 |
| `items/` | `GET /api/items` | ⏳ Day 17 待部署 |
| `reminders/` | `GET /api/reminders` | ⏳ Day 17 待部署 |
| `test_logic.js` | —— 本地逻辑测试（**37 项全通过**） | ✅ 本机可跑 |

本机跑测试（不需要 CloudBase，不联网也能跑）：

```bash
node cloudfunctions/test_logic.js
```

它把 `https.request` 换成假的，检查方法守卫、参数校验、查询串拼接、信封形状、错误处理。
**它不验证真实数据库** —— 真实链路靠第 4 步 curl 公网地址来验。

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

## 5. 排障表

| 现象（看 `error.code`） | 意思 | 怎么办 |
| --- | --- | --- |
| `CONFIG_MISSING` | 云函数没拿到 API Key | 手动加环境变量 `CLOUDBASE_APIKEY`。**报错消息里会列出当前可见的相关变量名**，照着对一下拼错没 |
| `UPSTREAM` + 401 / 403 | Key 无效或权限不够 | 多半是拿成了 Publishable Key（anon 角色）。换服务端 API Key |
| `UPSTREAM` + 404 或 `relation does not exist` | 表不存在 / 没暴露 | 回 PostgreSQL 确认 `items`、`reminders` 在 `public` schema 下；必要时重跑 `db/schema.sql` + `db/seed.sql` |
| `data` 是 `[]` 但不是报错 | 表是空的 | 重跑 `db/seed.sql` |
| `UPSTREAM` + 超时 | 网关没通 | 确认环境 ID 是 `habit-checkin-d9giln6ke6594e88b`（代码里也写死兜底了这个值） |
| 改了代码但结果没变 | 没重新部署 / 缓存 | 看响应头 `X-Version`（应是 `day17`）；curl 加 `-H "Cache-Control: no-cache"` |

---

## 6. 这两个接口今天刻意不做的事

| 不做 | 原因 |
| --- | --- |
| 写接口（POST / PATCH / DELETE） | Day 18 的事。今天是只读，写坏了要重跑 seed |
| 改表结构 | Day 16 刚定稿 |
| 前端接进来 | 数据形状先定死，前端字段映射（`date` ↔ `plan_date` 等）Day 18 再做 |
| 鉴权 / 用户体系 | 还没有用户概念，全靠 service_role 直读 |
