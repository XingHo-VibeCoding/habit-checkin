# api-contract.md · 接口契约

Day 15 产出。**这份文件定义「前端和后端之间怎么说话」**，跟具体实现分开 ——
先把契约定下来，后面换云厂商、换语言，只要照着契约实现就行，前端不用跟着改。

> ⚠️ 当前状态（2026-10-02）：**云函数还没上线**，CloudBase 开通要 Henry 本人实名（我代替不了）。
> 现在 `/api/health` 只有一个**静态 mock**（见文末），用来把链路打通、把契约验一遍；
> 真云函数开通后要把它替换掉，路径和返回结构保持这里定义的不变。

---

## 通用约定

| 项 | 约定 |
| --- | --- |
| 前端公网地址 | `https://daily-checkin-list.app.workbuddy.host/` |
| 云函数 Base URL | `https://<CloudBase 环境域名>/api`（开通后填，见下「待填」） |
| 请求 / 响应格式 | `application/json; charset=utf-8` |
| 时间格式 | ISO 8601，统一 UTC（`2026-10-02T06:50:00.000Z`）—— 别用本地时间字符串，跨时区会错 |
| 跨域 CORS | **Day 16–20 再配**（今日不做）。未配之前浏览器直连会被拦，只能服务端 curl 验 |
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

约定错误码（今天只用得到 `INTERNAL`）：

| code | 场景 |
| --- | --- |
| `INTERNAL` | 未捕获异常 |
| `BAD_REQUEST` | 参数不合法（Day 16+ 的业务接口才用） |
| `NOT_FOUND` | 资源不存在 |
| `UNAUTHORIZED` | 未登录 / 身份无效（Day 16+ 引入用户体系后才有） |

---

## 尚未实现的接口（Day 16–20，今天只占位，不实现）

这些**先写在这里是为了让前端知道将来会有什么**，避免到时候接口来回改。
今天一动都不要动 —— 任务清单里「今日不做：真实业务接口、数据库建表、跨域配置」明确排除了。

| 接口 | 用途 | 状态 |
| --- | --- | --- |
| `GET /api/items` | 拉取清单 | 未实现 |
| `POST /api/items` | 新增一条 | 未实现 |
| `PATCH /api/items/:id` | 改（勾掉 / 改名） | 未实现 |
| `DELETE /api/items/:id` | 删除 | 未实现 |
| `GET /api/reminders` | 拉取提醒 | 未实现 |
| `GET /api/anniversaries` | 拉取倒数纪念日 | 未实现 |

⚠️ **前端现在仍然完全走 localStorage**（`habit-checkin:v1` 一个 key），
不是"先用着 mock 以后切" —— 是**今天根本不接后端**。上面这些接口落地前，数据不会上云。

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
| 环境 ID | —— | 控制台「环境概览」里的 `envId` |
| 云函数 Base URL | —— | HTTP 访问服务域名 |
| 剩余额度 / 到期日期 | —— | 控制台「费用中心」（今天要交的截图里就要这三样） |

---

## 今天的验收方式

1. `curl` 健康检查 → 返回上面那个 JSON（`ok: true`）
2. 手机浏览器打开前端公网地址 → 同伴能打开
3. 本文件在仓库里

**当前只有 2、3 达成**，1 是静态 mock（地址见下），真云函数等开通。

静态 mock 地址：`https://daily-checkin-list.app.workbuddy.host/api/health.json`
（⚠️ 不是真云函数，是发布目录里的一个 JSON 文件，用来验「前端能不能按契约解析」。
CloudBase 开通后要换成 `/api/health`。）
