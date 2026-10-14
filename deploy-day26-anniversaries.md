# Day 26 部署手册：纪念日接云端（逐步操作版）

代码全在本地且测试全绿。**线上还什么都没动** —— `anniversaries` 表没建，
`/api/anniversaries` 路由也不存在，所以现在纪念日还是纯 localStorage。

本手册每一步都给了：**在哪点 → 填什么 → 怎么验 → 错了长什么样**。
卡在哪一步就停在那一步，别往下走 —— 后面的步骤依赖前面的结果。

**总耗时估计**：15–25 分钟（其中 API Key 那步要找一次明文）。

---

## 动手之前：准备两样东西

| 要用的 | 在哪 / 是什么 |
|---|---|
| 部署包 | `D:\Vibe Coding\cloudfunctions\anniversaries.zip`（19017 字节，4 个文件） |
| 服务端 API Key | 腾讯云 CloudBase 控制台 → 环境管理 → 环境配置 → API Key 配置 → **下半部分「服务端 API Key」** |

⚠️ **API Key 明文只显示一次。** 如果以前配 `items` 时没存下来，得重新生成一个新的。
⚠️ **别用上半部分的 Publishable Key** —— 那是 anon 角色，查不到任何行（会返回 0 行，不报错）。

环境信息（自动填好了，核对一下就行）：

```
环境 ID：habit-checkin-d9giln6ke6594e88b
Base URL：https://habit-checkin-d9giln6ke6594e88b-1499597872.ap-shanghai.app.tcloudbase.com/api
```

---

## 第 1 步：建表（5 分钟）

**在哪点**：CloudBase 控制台 → 你的环境 `habit-checkin` → 左侧 **数据库** → **PostgreSQL** → 顶部切到 **SQL 编辑器**（或「新建查询」）

**粘贴这段**（⚠️ 只粘这一段，**不要跑 `db/schema.sql` 整份** —— 它开头是 `DROP TABLE IF EXISTS`，会把已有的 `items` / `reminders` 连同你的真实数据一起删掉）：

```sql
CREATE TABLE anniversaries (
  id           VARCHAR(36)  NOT NULL,
  title        VARCHAR(200) NOT NULL,
  happen_on    CHAR(10)     NOT NULL,
  yearly       SMALLINT     NOT NULL DEFAULT 0,
  created_at   VARCHAR(32)  NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_anniversaries_happen_on CHECK (happen_on LIKE '____-__-__'),
  CONSTRAINT chk_anniversaries_yearly     CHECK (yearly IN (0, 1))
);
```

点**执行 / 运行**。

**怎么验**：控制台不报错就是成功。然后点左边的**表列表**，应该多出一张 `anniversaries`，
点进去能看到 5 列（id / title / happen_on / yearly / created_at）。

**如果报错**：

| 报错 | 意思 |
|---|---|
| `relation "anniversaries" already exists` | 表已经建过了，跳到第 2 步（无害） |
| `syntax error` | 大概是 `LIKE '____-__-__'` 里的下划线被输入法或编辑器改掉了，重新手动敲一遍 |
| `permission denied` | 你连的不是那个环境，看一眼顶部的环境名 |

---

## 第 2 步：灌 3 条示例数据（2 分钟，可选但建议做）

**在哪点**：还是 SQL 编辑器

**粘贴这段**（先删后插，重复跑不会翻倍）：

```sql
DELETE FROM anniversaries WHERE id LIKE 'seed-%';
INSERT INTO anniversaries (id, title, happen_on, yearly, created_at) VALUES
  ('seed-anniv-01', '生日',       '2000-05-20', 1, '2026-10-10T00:00:00.000Z'),
  ('seed-anniv-02', '认识纪念日', '2000-10-06', 1, '2026-10-10T00:00:00.000Z'),
  ('seed-anniv-03', '拿到学位证', '2027-06-30', 0, '2026-10-10T00:00:00.000Z');
```

点执行。

**怎么验**：SQL 编辑器应该回 3 行受影响。然后跑这句确认：

```sql
SELECT id, title, happen_on, yearly FROM anniversaries ORDER BY created_at;
```

应该看到 3 行（生日 / 认识纪念日 / 拿到学位证）。

> 这 3 条是示例数据。想清掉就跑一次 `DELETE FROM anniversaries WHERE id LIKE 'seed-%';`

---

## 第 3 步：新建云函数 `anniversaries`（5 分钟）

**在哪点**：左侧 **云函数** → 顶部 **新建** 按钮

按下面填：

| 表单项 | 填什么 | 说明 |
|---|---|---|
| 函数名称 | `anniversaries` | **必须一模一样**，第 4 步的路由要按这个名字配 |
| 运行环境 | **Node.js** | 跟 `items` 保持一致 |
| 上传方式 | **zip 上传** | ⚠️ 见下方 |
| 文件 | 点「选择文件」→ 选 `D:\Vibe Coding\cloudfunctions\anniversaries.zip` | |

**⚠️ 为什么必须传 zip，不能粘贴代码**：
包里有 **4 个文件**。只传 `index.js` 的话，云端会 `Cannot find module`，
而且**部署的时候不会报错**（控制台只校验 index.js 在不在），
要到实际调用才 500 —— 那种「部署成功但一调用就炸」最难查。

zip 里这 4 个文件（我已经解开核对过，一个不缺）：

```
index.js                    ← 接口层
anniversariesRepository.js  ← 数据访问层
errors-human.js             ← 中文错误提示（漏了这个 500）
package.json
```

点**创建 / 确定**。

**怎么验**：函数列表里出现 `anniversaries`，状态正常（绿色）。

**如果报「找不到 index.js」**：zip 选错了（可能选成了目录）。必须是那个 `.zip` 文件本身。

> 🔴 **2026-10-14 实战教训（这条警告就是为它写的）**：把 `anniversaries` **文件夹**
> 当成 zip 上传，云端只有 3 个文件 —— **文件夹里没有 `errors-human.js`**
> （它放在上一级 `cloudfunctions\` 目录，打包脚本特意把它打进 zip）。
> 结果：上传不报错，一调用就 `FUNCTIONS_INVOCATION_FAILED`，排查花了半天。
> **鉴别方法**：文件选择框里 `anniversaries` 📁 和 `anniversaries.zip` 📦 长得很像，
> **认准带 zip 图标 / `.zip` 后缀的那个**。
> **部署后必查**：函数代码 → 文件树里必须看到 **4 个文件**，少一个就重传。

---

## 第 4 步：配环境变量（5 分钟）

**在哪点**：左侧 **云函数** → 点进 `anniversaries` → **函数配置** / **配置与代码** → **环境变量**

加这两个（点「添加变量」两次）：

| 变量名 | 变量值 |
|---|---|
| `CLOUDBASE_APIKEY` | 你准备的服务端 API Key（明文粘进去） |
| `ALLOWED_ORIGINS` | `https://daily-checkin-list.app.workbuddy.host,http://localhost:8000` |

**`ALLOWED_ORIGINS` 的两个坑**（`api-contract.md` 里写着）：

1. **逗号分隔，不要加空格**。上面那个值里的逗号后面**没有空格**，照抄。
2. **`localhost` 和 `127.0.0.1` 是两个不同的源。**
   只写 `http://localhost:8000` 的话，用 `http://127.0.0.1:8000` 打开本地页面会被跨域拒。
   两个都想用就写三个：`https://...,http://localhost:8000,http://127.0.0.1:8000`

⚠️ **`ALLOWED_ORIGINS` 不要写 `*`**。留空的话函数会返回「配置缺失」而不是悄悄放行所有人 ——
这是刻意的设计：显性的失败好过隐性的降级。

⚠️ **环境变量不跨函数共享**。`items` / `reminders` 配过了不代表这个函数有，
每个函数都要各自配一遍。

点**保存**。

**怎么验**：
```bash
curl -s https://habit-checkin-d9giln6ke6594e88b-1499597872.ap-shanghai.app.tcloudbase.com/api/anniversaries
```
这时**还没建路由**，所以预期是 **404**（或网关的「找不到路由」提示）。
看到 404 说明请求确实到了网关、只是没有路由对应它 —— 这是正常的，往下一步走。

---

## 第 5 步：配 HTTP 路由（5 分钟）

**在哪点**：左侧 **云函数** → **HTTP 访问服务**（有的版本叫「API 管理」/「HTTP 网关」）→ **新建路由**

| 表单项 | 填什么 |
|---|---|
| 路径 | `/api/anniversaries` |
| 目标函数 | `anniversaries` |
| **方法** | **GET / POST / PATCH / DELETE 四个全勾** |
| **路径透传** | **开启** |

点创建。

**⚠️ 两个必须记住的坑**：

1. **四个方法要全勾。** Day 22 踩过：漏勾 `PATCH`，表现是「新增删除能用，修改不能」，
   代码明明上线了。
2. **必须开「路径透传」。**
   `PATCH /api/anniversaries/xxx` 和 `DELETE /api/anniversaries/xxx` 的 id 在**路径里**，
   不开这个开关网关不会把 id 传给函数，函数会回 400 并提示你开路径透传。

**怎么验**（这条是整个部署的关键判据）：
```bash
curl -i https://habit-checkin-d9giln6ke6594e88b-1499597872.ap-shanghai.app.tcloudbase.com/api/anniversaries
```

应该看到：

- 状态行 `HTTP/1.1 200 OK`
- 响应头里有 `X-Version: day26`
- 响应体是 `{"ok":true,"data":[...3 条 seed...]}`（第 2 步灌的那 3 条）

**`X-Version` 是部署探针** —— 以后改了云函数但行为没变，先看这个字段变没变。

**如果不对**：

| 现象 | 原因 |
|---|---|
| 404 | 路由没建成功，或路径拼错了（检查有没有多余的斜杠） |
| `CONFIG_MISSING` | 环境变量没配上，回到第 4 步 |
| 200 但 `data: []` | 表建了但没数据 → 回去跑第 2 步 |
| 400 说「路径透传」 | 第 5 步那个开关没开 |

---

## 第 6 步：端到端跑一遍六步链路（3 分钟）

打开 Git Bash 或 PowerShell，先设一个变量省得每次敲长地址：

```bash
BASE=https://habit-checkin-d9giln6ke6594e88b-1499597872.ap-shanghai.app.tcloudbase.com/api
ID="probe-$(date +%s)"
```

按顺序跑，每条都要看结果：

**① 读（列出全部）**
```bash
curl -s $BASE/anniversaries
```
预期：`{"ok":true,"data":[...3 条 seed...]}`

**② 新增**
```bash
curl -s -X POST $BASE/anniversaries -H 'Content-Type: application/json' \
  -d "{\"id\":\"$ID\",\"title\":\"部署验证\",\"happen_on\":\"2001-11-11\",\"yearly\":1}"
```
预期：状态 `201`，响应体里 `id` 就是你刚生成的 `$ID`，`yearly: 1`

> `id` 带时间戳是必须的 —— id 是幂等键，写死一个的话第二次发必然 409（主键冲突）。

**③ 回读确认**
```bash
curl -s $BASE/anniversaries/$ID
```
预期：200 + `{"ok":true,"data":{"id":"$ID","title":"部署验证",...}}`

**④ 改（把每年重复改成只那一天）**
```bash
curl -s -X PATCH $BASE/anniversaries/$ID -H 'Content-Type: application/json' \
  -d '{"yearly":0}'
```
预期：200 + `yearly: 0`

> 这一步过了就说明**路径透传是开着的**。如果报 400 且提示「路径透传」，回第 5 步。

**⑤ 删**
```bash
curl -s -X DELETE $BASE/anniversaries/$ID
```
预期：200，响应体里有 `{"deleted":true,"row":{...那一条的内容...}}`

**⑥ 再删一次 —— 这条是收尾判据**
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $BASE/anniversaries/$ID
```
预期：**404**

> 必须是 404，不能是 200。
> 「删不存在的行」返回 200 意味着接口在**谎报成功** —— 数据可能压根没删掉，
> 而调用方以为已经清干净了。404 + `NOT_FOUND` 才是正确行为。

---

## 第 7 步：发前端页面（3 分钟）

**⚠️ 顺序很重要**：先发页面再通云端，页面会显示「纪念日空着」（走 localStorage 兜底），
分不清是半成品还是真没数据。**所以第 6 步全绿之后再发页面。**

**先做发布前的四步冒烟**（我在本地已经全跑过一遍，你可以再核一次）：

```bash
cd "/d/Vibe Coding"
# ① JS 语法
"C:/Users/MILK/.workbuddy/binaries/python/envs/default/Scripts/python.exe" -c "
import re,io
h=io.open('index.html',encoding='utf-8').read()
io.open(r'C:/Users/MILK/.workbuddy/tmp/d26.js','w',encoding='utf-8').write(
  '\n'.join(re.findall(r'<script[^>]*>(.*?)</script>',h,re.S)))
" && "C:/Users/MILK/.workbuddy/binaries/node/versions/22.22.2-5/node.exe" --check "C:/Users/MILK/.workbuddy/tmp/d26.js" && echo "JS OK"

# ② id 空引用
"C:/Users/MILK/.workbuddy/binaries/python/envs/default/Scripts/python.exe" db/check_ids.py
```

**然后发布**：拷文件 → 触发发布。

```bash
cp index.html .deploy/
cp sw.js .deploy/          # ⚠️ Day 25 的 sw.js 之前漏拷过，线上 404
cp manifest.json .deploy/
cp assets/*.jpg assets/*.png .deploy/assets/
```

> ⚠️ **发布目录是 `.deploy/`，不是仓库根目录**（避免文档被公网读到）。
> ⚠️ **png 也要拷**（看板娘是透明立绘，jpg 存不了 alpha）。
> ⚠️ **发布不自动同步** —— 每次改完都要手动重新发一次。

**怎么验**（发布后）：

```bash
curl -s -o /dev/null -w "sw.js=%{http_code} " https://daily-checkin-list.app.workbuddy.host/sw.js
curl -s https://daily-checkin-list.app.workbuddy.host/ | grep -c "apiGet('/anniversaries')"
```
预期：`sw.js=200`，且 grep 计数 ≥ 1（说明线上是新版）

然后浏览器打开 `https://daily-checkin-list.app.workbuddy.host/`：

| 看什么 | 预期 |
|---|---|
| 页面底部那行字 | 「数据来自云端数据库」（不是「部分退回本地」） |
| F12 → Application → Service Workers | `sw.js` 已激活 |
| 页面的检查台/诊断面板 ② 区 | 有「纪念日」一行，显示 3 行 |
| 点「倒数」那一栏 | 能看到「生日」和它的倒数天数 |

---

## 出问题怎么查

### 页面底部显示「部分退回本地（数据库没读到）」

打开诊断面板看「哪些退回本地」那一行，它会直接点名是哪个接口、以及失败原因原文。

| 失败原因里出现 | 含义 | 怎么修 |
|---|---|---|
| `CORS` | `ALLOWED_ORIGINS` 没包含当前域名 | 回第 4 步。注意 `localhost` 和 `127.0.0.1` 是两个源 |
| `CONFIG_MISSING` | 函数没拿到 API Key | 回第 4 步；报错消息里会列出当前可见的变量名，照着对拼写 |
| `NOT_JSON` | 网关/代理拦了，不在函数这一层 | 检查路由方法有没有全勾 |
| `HTTP 404` | 路由没建或路径拼错 | 回第 5 步 |

### 纪念日区一直空着，但 items 正常

八成是路由没建或方法没全勾 —— `anniversaries` 是**新函数**，
部署最容易出半成品（函数传了但路由没建 / 环境变量没配）。
诊断面板的纪念日那一行会直接显示 HTTP 状态码。

### 改了一次没生效

先看响应头的 `X-Version`。还是 `day26` 之外的旧值 → 云函数没重新部署。
是 `day26` 但行为没变 → 缓存，清一下再试。

---

## 回退

云端回退很简单：**把 `/api/anniversaries` 这个路由停用**即可。
前端会自动退回 localStorage（写入策略是「先改本地、再发网络」），**本地数据一直都在**。

表要不要留着无所谓 —— 它不影响 `items` / `reminders`，也没有外键指向它。
