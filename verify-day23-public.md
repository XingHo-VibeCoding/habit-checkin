# Day 23 公网实证记录

> 时间：2026-10-09 下午
> 环境：`habit-checkin-d9giln6ke6594e88b`（上海）
> Base URL：`https://habit-checkin-d9giln6ke6594e88b-1499597872.ap-shanghai.app.tcloudbase.com/api`
> 三个云函数均已部署，版本号 `x-version: day23`

---

## 一、部署生效验证（版本号探针）

部署前 → 部署后：

| 接口 | 部署前 | 部署后 | 结论 |
|---|---|---|---|
| `/health` | `x-version: day20` | **`x-version: day23`** | ✅ |
| `/items` | `x-version: day22` | **`x-version: day23`** | ✅ |
| `/reminders` | `x-version: day20` | **`x-version: day23`** | ✅ |

**为什么用版本号当判据**：控制台显示「部署成功」不可靠 ——
共享文件 `errors-human.js` 没跟上传时，控制台照样显示成功，但一调用就500。
版本号是从函数内部返回的，证明代码真的在跑。

---

## 二、审计成果逐条实证

### ① date 格式对但日子不存在（Day 23 新增校验）

```bash
curl "$B/items?date=2026-02-31"
```
```json
{"ok":false,"error":{"code":"BAD_REQUEST","message":"date 格式对，但不是个真实存在的日子，收到 \"2026-02-31\"（2026 年 2 月没有 31 号这样的日期）。"}}
```

**改前**：200 +空数组（跟「这天真的没待办」完全一样，前端不会报错）

### ② 查询参数拼错（Day 23 新增校验）

```bash
curl "$B/items?titel=x"
```
```json
{"ok":false,"error":{"code":"BAD_REQUEST","message":"不认识的查询参数 \"titel\"。这个接口只认：date、limit、id（都可以不传）；要按某一条查请用路径 /api/items/{id}。"}}
```

**改前**：200 + 全量数据（调用方以为筛过了，其实没筛）

### ③ id 带注入字符（Day 23 新增校验）

```bash
curl "$B/items/%27%20OR%201%3D1"
```
```json
{"ok":false,"error":{"code":"BAD_REQUEST","message":"id 只能含字母、数字、下划线和连字符，收到 \"' OR 1=1\"。"}}
```

**改前**：直接拼进 URL 发给数据库

### ④ reminders 的?date= 被明确拒绝（Day 23 新增）

```bash
curl "$B/reminders?date=2026-10-09"
```
```json
{"ok":false,"error":{"code":"BAD_REQUEST","message":"不支持的查询参数 \"date\"。reminders 表的 remind_at 是时间戳，没有按天过滤这个功能；要按天筛请在拿到全量后自己过滤。"}}
```

**改前**：200 + 全量（筛选被静默丢弃，不产生任何错误信号）

### ⑤ ?id= 兜底通道未被误伤（回归检查）

```bash
curl "$B/items?id=seed-item-01"
```
```json
{"ok":true,"data":[{"id":"seed-item-01","title":"买咖啡豆","plan_date":"2026-10-02","done":1,...}]}
```

⚠️ **这条尤其重要**：④ 那道新守卫差点把 Day 22 特意留的`?id=` 兜底通道打死。
加白名单时特意把 `id` 放进去 —— 容错通道不能被安全检查误伤。

---

## 三、三类错误提示（Day 23 主任务）

### 类① 输入不对 —— 用户自己能改

| 输入 | 返回 | 判据 |
|---|---|---|
| `POST {bad json` | `请求体不是合法的 JSON。检查一下有没有多逗号、单引号，或中文引号「」。` | 指出具体错在哪 |
| `POST title` 300 字 | `title 太长了（300 字），最多 200 字 —— 手机上一行显示不完，请改短。` | 带字数 + 为什么不合适 |
| `POST` 无 id | `缺 id。id 是防重复提交的幂等键，必须由你（调用方）生成并带上，重试时用同一个 id。` | 说清为什么需要 |
| `POST` 无 plan_date | `缺 plan_date（计划做哪一天），格式 "YYYY-MM-DD"，例如 "2026-10-06"。` | 给格式 + 给例子 |
| `PATCH {"id":"new-id"}` | `这些字段不能改：id。可改的只有：title、plan_date、done、done_at。（id 是身份、created_at 是创建时间，都不该被改；想换 id 请删了重建）` | 说清能改什么、为什么不能改 |
| `POST id重复` | `这个 id 已经在清单里了（重复提交）。id 是防重复提交的幂等键 —— 如果你确实想加两条不同的内容，请换一个 id。` | 中文，且**说清了怎么绕过** |
| `GET 不存在的 id` | `清单里没有 id 为 "no-such-id-xyz" 的这一条。` | — |
| `DELETE 已不存在的 id` | `清单里没有 id 为 "xxx" 的这一条 —— 也许已经被删过了。如果你要的是「确保它不在」（幂等删除），加 ?force=1。` | **顺手指路**，不只说不行 |

**关键观察**：主键冲突这条**没有**变成英文的
`duplicate key value violates unique constraint`，
而是中文说明 + 告诉用户「确实要加两条就换id」——
这正是 Day 23「给人看说人话，给排查看留原文」的落地。

### 类② 配置缺失 —— 只有开发者能修

本地测试实证（386 项里包含）：
- 消息：`服务还没配置好，这不是你操作的问题。需要开发者在 CloudBase 控制台开启 API Key。`
- 判据：`明说「不是你操作的问题」` + `指明该找谁：开发者在控制台开 API Key` + `不带任何密钥值`
- 测试做法：删掉 4 个环境变量名再调一次

### 类③ 上游/网络失败 —— 只能等

本地测试用6 种真实英文报错去撞，全部不泄漏到用户：

| 原始报错 | 用户看到 |
|---|---|
| `getaddrinfo ENOTFOUND api.tcloudbasegateway.com` | `服务暂时不可用，请稍后再试。这不是你操作的问题。` |
| `connect ECONNREFUSED 127.0.0.1:5432` | 同上 |
| `Error: ETIMEDOUT` | 同上 |
| `socket hang up` | 同上 |
| `Unexpected token < in JSON at position 0` | 同上 |
| `connect http://10.0.0.5:8080/internal failed` | 同上 |

**这6 项本地测试能验，公网验不了** ——
要在公网造出这类错误得改控制台配置或断网络，
代价大且不留痕。原文全部进了 `log({ st: 'upstream_detail', raw: ... })`，排查不受影响。

---

## 四、回归验证（确认今天没改坏 Day 17~22 的东西）

| 项| 期望 | 实测 | 结论 |
|---|---|---|---|
| `GET /items` | 9 条 | 9 条 | ✅ |
| `GET /items?date=2026-10-02` | 4 条 | 4 条 | ✅ |
| `GET /reminders` | 正常 | 正常返回 seed 提醒 | ✅ |
| `allow-methods` | GET,POST,PATCH,DELETE,OPTIONS | 一致 | ✅ |

### CRUD 四类闭环（重新验一遍）

```bash
#① POST 新增
curl -X POST -d '{"id":"d23-verify-tmp01","title":"Day23验收临时项","plan_date":"2026-10-09"}' "$B/items"
→ 200 created_at=2026-10-09T09:46:48.605Z, done_at=null

# ② PATCH 改 done
curl -X PATCH -d '{"done":1}' "$B/items/d23-verify-tmp01"
→ 200 done=1, done_at=2026-10-09T09:46:53.801Z     ← done/done_at 联动正确

# ③ GET 回读
curl "$B/items/d23-verify-tmp01"
→ 200 完整返回改后那一条

# ④ DELETE
curl -X DELETE "$B/items/d23-verify-tmp01"
→ 200 deleted=true, row={被删掉的那一条}

# ⑤ 删后再 GET
curl "$B/items/d23-verify-tmp01"
→ 404清单里没有 id 为 "d23-verify-tmp01" 的这一条。
```

### 数据零残留

验收结束后 `GET /items` 回到 **9 条**，
`d23` 前缀的 id **无残留** —— 审计过程没污染库。

---

## 五、密钥排查实证

### 工作区

```bash
grep -rInE "(AKID[a-zA-Z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|CLOUDBASE_APIKEY[[:space:]]*=[[:space:]]*['\"][A-Za-z0-9_-]{16,})" \
  --include="*.js" --include="*.html" --include="*.md" --include="*.json" --include="*.sql" --include="*.py" .
```
**结果：1 条命中** —— `test_logic.js:893  process.env.CLOUDBASE_APIKEY = 'fake-key-for-local-test'`
是测试桩的假值，不是密钥。

### Git 全历史

```bash
git log --all -p --no-color | grep -nE "^\+.*(AKID[a-zA-Z0-9]{10,}|BEGIN [A-Z ]*PRIVATE KEY|eyJ...)"
→ 0 行

git log --all -p --no-color | grep -E "^\+.*(APIKEY|API_KEY|TCB_API|SECRET|TOKEN)[[:space:]]*[:=]" | sort -u
→ process.env.CLOUDBASE_APIKEY = 'fake-key-for-local-test';
  process.env.CLOUDBASE_APIKEY = 'test-key';
```

**结论：全历史 0 条真实密钥，无需作废任何密钥。**

---

## 六、本次抓到的最重要一个坑（不在任务书范围）

**`require('../errors-human.js')` 在仓库里能跑，部署后必然 500。**

- CloudBase 部署把函数包解压成**独立根目录**，父目录不存在
- 部署**不报错**，控制台显示「部署成功」，一调用才 500
- `Cannot find module '../errors-human.js'` 不容易让人联想到路径问题

修法（两个路径都试）：

```javascript
var human = (function () {
  try { return require('./errors-human.js'); }   // 部署后走这条
  catch (e1) { return require('../errors-human.js'); }  // 本地仓库走这条
})();
```

**部署前的验证办法**（不用真部署）：把包复制到独立目录再 require 一次。
修之前 items / reminders 都 FAIL，health 因为不 require 共享文件所以一直 OK
—— **只测一个函数就会漏掉这个问题**。

已记入 `security-checklist-day23.md` 第 6 项。