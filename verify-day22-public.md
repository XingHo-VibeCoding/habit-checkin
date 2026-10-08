# Day 22 公网实证记录 · PATCH / DELETE

**日期**：2026-10-08 11:58–12:30
**接口版本**：`x-version: day22`
**响应头**：`access-control-allow-methods: GET, POST, PATCH, DELETE, OPTIONS`
**测试 id**：`d22-live-1791431904`、`d22-1791433605`（均已删除，库里不留痕）

---

## 一句话结论

**CRUD 四类操作公网闭环实证全部通过，路径形式（`/api/items/{id}`）零副作用。**

---

## ⚠️ 真根因：HTTP 网关的「路径透传」没开

**我最初判断错了**，以为要改路由路径。实际打开弹窗才发现控制台写明了：

> 关闭路径透传时，后端服务将收到**不带触发路径**的请求；
> 当访问 `/api/items/more/path` 时，后端服务收到的路径为 `/more/path`

**「路径透传」开关是关闭的** —— `/api/items` 这个触发路径被剥掉了，
云函数只看到 `/seed-item-01`。而 `pathId()` 的正则要的是
`/\/api\/items\/([^/?#]+)/`，缺前缀自然匹配不上。

### 修法：只开「路径透传」，**访问路径一个字没改**

控制台 → 左侧 **HTTP 网关** → `/api/items` 那行「编辑」→ 开「路径透传」→ 确定。

**开完之后零副作用**（这四条是判断有没有弄坏的判据）：

```
GET /api/items/seed-item-01  → 1 条  ✅（今天修的 bug 收尾）
GET /api/items?date=2026-10-02 → 4 条  ✅（列表 + 查询参数没坏）
GET /api/items               → 9 条  ✅（列表没坏）
GET /api/items?id=seed-item-01 → 1 条  ✅（query 兜底也没坏）
```

### 快速证伪手法（下次「参数没收到」先打这个）

```
/api/items?id=xxx   → 200     代码对、网关没传
/api/items/xxx      → 400     ← 差异在网关
```

两个都失败才是代码问题。**能把「代码 bug」和「网关配置」当场分开。**

⚠️ **`allow-methods` 头显示四种不代表路由配对了** —— 它只反映代码里的
`ALLOWED` 白名单，跟网关路由无关。路径透传关着时它照样显示四种。

---

## ★ 今天修的第二个 bug：`GET /api/items/:id` 单条查询

**这不是网关的问题，是代码的** —— `handleGet` 压根不读 path 里的 id，
传了 id 也当没传，返回全部 9 条。

**两个问题叠在一起，必须都修**：网关不透传 → id 到不了函数；
代码不读 → 到了也白搭。

这个 bug 藏了 5 天（Day 17~21 一直用 `?date=` 查列表，没人走过单条这条路）。
**没被走过的分支不会被发现。**

改法：
- `itemsRepository.js` 的 `list()` 加id 过滤 + 强制 `limit=1`
- `index.js` 的 `handleGet` 读 `pathId(event)`，**查不到时返回 404 而不是空数组**

---

## CRUD 闭环（路径形式，2026-10-08 12:26 最终验证）

测试 id `d22-1791433605`，全部走 `/api/items/{id}`：

| 步骤 | 请求 | 结果 |
| --- | --- | --- |
| ① POST | `POST /api/items` | ✅ **201**，`created_at` = `04:26:47.970Z` |
| ② GET 单条 | `GET /api/items/d22-…` | ✅ 200，**只1 条**（改之前）|
| ③ PATCH | `PATCH /api/items/d22-…` | ✅ **200** |
| ④ DELETE | `DELETE /api/items/d22-…` | ✅ **200**，回读被删掉的那一行 |
| ⑤ GET 同一路径 | `GET /api/items/d22-…` | ✅ **404** |
| ⑥ 列表 | `GET /api/items` | ✅仍是 9 条，**没弄坏** |

### ★ PATCH 局部更新的证据（第 ③ 步）

body 只送了 `title` 和 `done`，结果：

| 字段 | 改之前 | 改之后 | 判定 |
| --- | --- | --- | --- |
| `title` | `D22 路径形式验证` | `D22 路径形式验证（已改）` | ★ 变了 |
| `done` | 0 | 1 | ★ 变了 |
| `done_at` | null | `2026-10-08T04:26:54.070Z` | ★ 自动补上 |
| `plan_date` | `2026-10-08` | `2026-10-08` | ✔ 没动 |
| `created_at` | `04:26:47.970Z` | `04:26:47.970Z` | ★ ★ 没动 |

**`created_at` 没变最关键** —— 如果它变了，说明这次「改」实际是
「重新插了一行」，会造成老数据静默丢失。

### ★ DELETE 后的证据（第 ④⑤ 步）

```
DELETE → 200，回读 row 里就是被删掉的那一行
再 GET 同一路径 → 404「清单里没有 id 为 "d22-1791433605" 的这一条。」
```

**这就是「删除为什么比新增更容易出事」的直接证据**：
POST 重复发 → 撞主键 409（两发请求天然分开）；
DELETE 重复发 → 第二次「成功地什么都没做」。
返回 200 的话，调用方会以为「我删成功了」，
而真实情况可能是第一次压根没生效 —— 数据还在，却以为已清掉。
**谎报比报错危险得多：报错会让人去查，谎报只会让人接着往下走。**

---

## 边界与错误路径（全部中文报错，已实证）

| 场景 | 状态码 | 错误码 | 消息（实测原文） |
| --- | --- | --- | --- |
| PATCH id 不存在 | **404** | `NOT_FOUND` | 清单里没有 id 为 "not-exist-xyz" 的这一条 —— 可能已经被删了。 |
| DELETE id 不存在 | **404** | `NOT_FOUND` | ……也许已经被删过了。如果你要的是「确保它不在」（幂等删除），加 ?force=1。 |
| GET id 不存在 | **404** | `NOT_FOUND` | 清单里没有 id 为 "…" 的这一条。 |
| PATCH 送 `remark` | **400** | `BAD_REQUEST` | 这些字段不能改：remark。可改的只有：title、plan_date、done、done_at。（id 是身份、created_at 是创建时间，都不该被改；想换 id 请删了重建）|
| PATCH 送 `done:true` | **400** | `BAD_REQUEST` | done 只能是 0（没做）或 1（做完了），收到 true。 |
| POST 送 `date`（错字段名）| **400** | `BAD_REQUEST` | 不认识的字段：date。可写字段只有：id、title、plan_date、done、created_at、done_at。 |
| DELETE 缺 id | **400** | `BAD_REQUEST` | URL 里没有 id。删一条要写成 /api/items/<id>。 |
| `PUT`（契约外）| **405** | — | 响应带 `allow: GET, POST, PATCH, DELETE` |

---

## 单元测试：325 → 339 项，全绿

新增**板块 12：GET 按 id 查单条**（14 项断言）。

⚠️ **写这组断言时踩的坑**：桩把请求选项记在 `captured.path`，
**不是 `captured.url`**（`https.request(opts)` 的 opts 是
`{hostname, path, method, headers, timeout}`）。

断言写成 `captured.url` 时它是 `undefined`，正则测 undefined 一律不匹配 ——
**看起来像代码没生效，其实是断言看错了字段**。
前面那些 POST/PATCH 断言没踩到，是因为它们查 `capturedBody`，没碰 path。

→ **教训：断言失败先打印那个变量本身，别急着改代码。**

---

## 与截图要求的对应

今天要交两张截图：

| 截图 | 拿什么截 | 关键内容 |
| --- | --- | --- |
| **① PATCH 后的数据变化** | 上表「PATCH 局部更新的证据」 | title / done / done_at 变了，`created_at` 没变（**改前 vs 改后逐字段对比**）|
| **② DELETE 后该条不再返回** | 第 ④⑤ 步 | DELETE 回读 row + 再 GET 报 404（**证明不是谎报**）|