# Day 23 · 安全自查清单

> 审计时间：2026-10-09
> 审计范围：硬编码密钥 / 裸报错 / 非法输入 / .gitignore 完整性
> 方法：**先审计后修复** —— 所有结论都是跑出来的，不是读代码读出来的。
> 每项都配了**可复制的验证命令**，下次改动后照着跑一遍就知道有没有退化。

---

## 结论速览

| # | 审计项 | 结果 | 修了什么 |
|---|--------|------|----------|
| 1 | 硬编码密钥（工作区） | ✅ 0 条真实密钥 | 无需修 |
| 2 | 硬编码密钥（Git 历史） | ✅ 0 条真实密钥 | 无需作废任何密钥 |
| 3 | 裸报错泄漏技术细节 | ⚠️ 抓到 3 处漏网 | 全部改为中文人话 + 原文进日志 |
| 4 | 非法输入 | ⚠️ 62 条里抓到 4 类真问题 | 全部修好，现62/62 |
| 5 | .gitignore 完整性 | ⚠️ 13 类敏感文件里 5 类不挡 | 补规则，现20/20 挡住 |

**关于作废密钥**：用户要求「一旦发现真实密钥，立即作废并重新生成」。
实际扫描结果是**没有发现任何真实密钥**，所以**没有密钥需要作废**。
理由见下面第1、2 项的验证命令输出。

---

## 1. 硬编码密钥 —— 工作区

**结论：0 条真实密钥。**

唯一命中的是测试桩里的假值 `fake-key-for-local-test`（在 `test_logic.js`），
它不是密钥，只是个占位字符串，本地跑测试时用。

### 验证方法

```bash
cd "D:/Vibe Coding"
grep -rInE "(AKID[a-zA-Z0-9]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|CLOUDBASE_APIKEY[[:space:]]*=[[:space:]]*['\"][A-Za-z0-9_-]{16,})" \
  --include="*.js" --include="*.html" --include="*.md" --include="*.json" --include="*.sql" --include="*.py" .
```

**期望结果**：最多命中 `test_logic.js` 里的 `fake-key-for-local-test`，其余为 0。
**怎么算合格**：把命中行逐条打开看，确认值是明显的假值。
只要看到一行像真密钥（长随机串、带真实前缀），立刻按第 10 条处理。

### 密钥现在存在哪

**只在 CloudBase 控制台的环境变量里**，代码里读不到：

```
cloudfunctions/items/index.js       → repo.hasCredential() 读 process.env
cloudfunctions/items/itemsRepository.js  → 读 CLOUDBASE_APIKEY / CLOUDBASE_API_KEY / TCB_API_KEY / API_KEY
```

环境变量名有四种拼法，代码四个都读（Day 17 定论，别改）：
`CLOUDBASE_APIKEY`（node-sdk 文档）/ `CLOUDBASE_API_KEY`（AI-Toolkit）/ `TCB_API_KEY` / `API_KEY`

### 验证方法：确认代码里没有任何硬编码赋值

```bash
grep -rn "CLOUDBASE_APIKEY\s*=\s*['\"]" cloudfunctions/ | grep -v test_logic
```

**期望结果**：0 行。真密钥只允许出现在控制台，不出现在任何 `.js` 里。

---

## 2. 硬编码密钥 —— Git 历史

**结论：0 条真实密钥。无需作废。**

搜了整个 Git 历史（所有分支所有提交的所有 diff），
只有两个测试桩假值：`fake-key-for-local-test` 和 `test-key`。

### 验证方法

```bash
cd "D:/Vibe Coding"
# 第一枪：私钥 / 云密钥 / JWT 特征
git log --all -p --no-color | grep -nE "^\+.*(AKID[a-zA-Z0-9]{10,}|BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})"
# 第二枪：所有「密钥类变量」的赋值行，人工过一遍
git log --all -p --no-color | grep -E "^\+.*(APIKEY|API_KEY|TCB_API|SECRET|TOKEN)[[:space:]]*[:=]" | sort -u
```

**期望结果**：第一枪 0 行；第二枪只有测试桩那两个假值。

### ⚠️ 如果将来真的在历史里发现了密钥，光删代码是不够的

这是本清单最重要的一条。**`git rm` 一个文件不能让密钥失效** ——
它还在历史里，任何人执行 `git log -p` 都能翻出来。

正确处置顺序：

1. **先去控制台作废并重新生成**（这一步最要紧，别拖到最后）
   - CloudBase：环境管理 → 环境配置 → API Key 配置 → 删除旧的 → 新建一个
2. 更新控制台的环境变量为新Key
3. 再清理代码与历史（`git filter-repo` 或BFG，本地小仓库也可直接重建历史）
4. 如果推过远端，通知所有克隆过这个仓库的人**重新克隆**（旧历史还在他们那儿）

顺序反了等于没做：新密钥发出去之前，旧的就已经泄漏了。

---

## 3. 裸报错

**结论：已清零。响应里不再出现任何技术细节。**

### 改前 vs 改后

| 位置 | 改前（用户看到） | 改后（用户看到） |
|------|----------------|----------------|
| POST 上游失败 | `PG REST 返回 503：upstream connect error...` | `服务暂时连不上，这通常不是你的操作问题。稍等一会儿再试。` |
| PATCH 上游失败 | 同上（漏网） | 同上 |
| DELETE 上游失败 | 同上（漏网） | 同上 |
| GET catch | `getaddrinfo ENOTFOUND api.tcloudbasegateway.com` | `服务暂时不可用，请稍后再试。这不是你操作的问题。` |
| 缺API Key | `云函数拿不到 API Key` | `服务还没配置好，这不是你操作的问题。需要开发者在 CloudBase 控制台开启 API Key。` |
| 数据库约束冲突 | `not-null constraint failed: items.title` | `可能有必填项是空的（字段 title）。` |

### 核心原则：给人看的说人话，给排查看的留原文

```
log({ st: 'upstream_detail', raw: String(r.text).slice(0, 300) })  ← 排查看这个
return fail('UPSTREAM', humanUpstream(e))                          ← 用户看这个
```

调试信息**没有丢**，只是从「响应体」挪到了「日志」。
挪动它是为了不让人在页面上看到 `getaddrinfo` 却不知道该找谁。

### 验证方法

```bash
# ① 响应体里不该再有任何 e.message 直吐。
#    grep 会连注释一起命中（我在注释里写了「改前是 String(e.message)」），
#    所以要用 grep -v '//' 把注释滤掉，只看真代码行。
grep -rn "fail('UPSTREAM', String(e.message))\|fail('INTERNAL', String(e.message))" \
  cloudfunctions/*/index.js | grep -v '//'
# 期望：0 行
```

> **踩过的坑**：一開始我直接grep 没滤注释，看到 3 行命中以为没改干净。
> 实际那3 行全是我自己写的「改前」注释。→ **审计类 grep 一定要分清
> 「代码行」和「提到这个字符串的注释行」**，否则会一直追一个不存在的问题。

# ② 三条上游分支都必须包了 humanUpstream
grep -rn "PG REST 返回" cloudfunctions/items/index.js | grep -v "^.*//"
# 期望：每一行的 fail() 参数都是 humanUpstream(...)，不是裸字符串

# ③ 自动验证（这条最硬：拿6 种真实英文报错去撞，检查消息干净）
node cloudfunctions/test_logic.js | grep -A2 "不泄漏到用户"
# 期望：6 种（ENOTFOUND / ECONNREFUSED / ETIMEDOUT / socket hang up / JSON 解析失败 / 内网地址）全部 PASS
```

### 三类错误的分界（为什么不合并成一句「出错了」）

| 类 | 谁能修 | 消息必须包含 |
|----|--------|-------------|
| ① 输入不对 | 用户自己 | **哪个字段错了** + 期望格式 |
| ② 配置缺失 | 只有开发者 | 明说「不是你操作的问题」+ 去哪开 |
| ③ 上游/网络失败 | 只能等 | 明说「不是你操作的问题」+ 稍后再试 |

分开的理由很实际：**下一步动作完全不同**。
① 用户会去改输入，② 用户会去找开发者，③ 用户只能等。
合成一句话「操作失败」会让三类人做同一件事——反复重试。

### 关于 `guessDbReason` 用「推测」措辞的原因

数据库约束错误种类很多（not-null / unique / foreign key / check ...），
不可能全cover。所以每句话都带「可能有」「可能是」。

**猜错比不给更糟**：说「可能是必填项空了」而实际是唯一键冲突，
用户会去把别的字段填上，白折腾一轮。所以认不出来的时候实说「无法理解」。

---

## 4. 非法输入

**结论：62 条畸形输入全部正确处理（62/62）。**

用 `cloudfunctions/audit_day23_input.js` 打的，这个脚本会
把每条畸形输入真打进 `main()`，然后按三条红线判：
不能 5xx、不能泄漏技术细节、必须是中文。

### 抓到并修掉的 4 个真问题

| # | 问题 | 改前 | 改后 | 为什么算 bug |
|---|------|------|------|-------------|
| 1 | `?date=2026-02-31` | 200 + 空数组 | 400 + 说清「日子不存在」 | 格式对但2 月没有 31 号。返回的空数组跟「这天真的没待办」**长得一模一样** —— 数据没丢、前端不报错，只是某天清单永远空的|
| 2 | `event` 是 null | 默默按 GET 处理，返回 200 + 全量数据 | 400 + 说清是网关问题 | 连请求方法都没有说明调用坏了，替它猜一个 GET 等于掩盖故障 |
| 3 | `GET ?titel=xxx`（拼错） | 200 + 全量数据 | 400 + 把参数名还给你 | 静默忽略 → 调用方以为筛过了，其实拿到全量。**不产生任何错误信号**，最难查|
| 4 | `GET /api/items/任意垃圾` | 直接拼进 URL 发给数据库 | 400，格式校验 | PATCH/DELETE 一直有这道校验，唯独 GET 漏了|

### 验证方法

```bash
cd "D:/Vibe Coding"
node cloudfunctions/audit_day23_input.js | tail -6
# 期望：共 62 条非法输入，合格 62，有问题 0

# 常驻回归（审计脚本是一次性快照，这个是每次都跑的）
node cloudfunctions/test_logic.js | grep -A14 "14. Day 23"
# 期望：11 条全PASS
```

### 一个容易踩的坑：这个审计脚本的桩必须发 Buffer

```javascript
//✗ 错：发字符串会在 Buffer.concat 上抛 ERR_INVALID_ARG_TYPE
res.emit('data', '[]');
// ✓ 对：真实 https 响应的 data 事件给的是 Buffer
res.emit('data', Buffer.from('[]'));
```

写错桩的后果是「审计脚本崩了」，看起来像**被测代码有 bug**，
其实是自己桩写错了。判断方法：崩在 `Buffer.concat` 上就是桩的问题。

---

## 5. .gitignore 完整性

**结论：20 类敏感文件全部挡住，且没误伤任何该追踪的文件。**

### 实测方法：造假文件，不能只读规则文本

⚠️ **只看规则文本会漏判** —— 规则写了不代表真的生效，而且 `git check-ignore`
对 `!` 放行规则也会返回匹配（看起来像「误伤」，其实是正常语义）。

所以用 `git add --dry-run` 做最终裁决：

```bash
cd "D:/Vibe Coding"
# 最终裁决：这两个该提交 / 不该提交
git add --dry-run .env.example   # 期望：add '.env.example'（能提交）
git add --dry-run .env           # 期望：fatal: pathspec '.env' did not match any files
```

### Day 23 补的规则（补之前这 5 类完全不挡）

```
*.pem  *.key  *.p12  *.pfx  *.jks  *.keystore
id_rsa  id_dsa  id_ecdsa  id_ed25519
.npmrc  .netrc
secrets.json  secrets.yaml  secrets.yml  credentials.json  *.credentials
*.swp  *.swo  *.swn  *.tmp  *.bak  *.orig  *~
```

补这些的原因是：原来只有 `.env` 一条规则，而它挡的是**文件名**不是**内容** ——
所以「哪天顺手把私钥放成 `id_rsa`、把 API Key 写进 `secrets.json`，
`git add .` 一下就进仓库了」。

### 完整验证方法（照着跑，改完代码复核一遍）

```bash
cd "D:/Vibe Coding"
# ① 敏感文件必须被挡
for f in .env .env.local .env.production .env.example id_rsa id_ed25519 \
         server.key cert.pem store.jks secrets.json secrets.yaml \
         credentials.json .npmrc .netrc app.key notes.swp a.tmp b.bak \
         cloudfunctions/items.zip debug.log .DS_Store; do
  res=$(git check-ignore -v "$f" 2>/dev/null)
  if [ -n "$res" ]; then echo "  挡住  $f"; else echo "  ⚠ 不挡 $f"; fi
done

# ② 反向：该追踪的必须没被误伤
for f in index.html api-contract.md cloudfunctions/items/index.js \
         assets/mascot.png db/schema.sql README.md cloudfunctions/errors-human.js; do
  res=$(git check-ignore -v "$f" 2>/dev/null)
  if [ -n "$res" ]; then echo "  ⚠ 误伤 $f"; else echo "  正常  $f"; fi
done
```

### ⚠️ 这份规则永远不可能穷尽

文件名可以随便起。**真正的兜底是那条纪律：任何密钥都不写进文件，只写进控制台的环境变量。**
`.gitignore` 只是「手滑时的护栏」，不是「可以安全地把密钥写进文件」的许可证。

### 顺带一提：`.deploy/` 规则不在 `.gitignore` 里

它在 `.git/info/exclude` 第 14 行（仅本机生效，不共享）。
所以判断文件是否被忽略**必须用 `git check-ignore -v`，别只 grep `.gitignore`** ——
2026-09-22 我据此误报过一次「文档与现实不一致」。

---

## 6. 顺带抓到一个「部署后才炸」的坑（不部署看不出来）

**这个不属于任务书的四项审计范围，但它是今天做部署准备时抓到的，性质比前面几项都严重。**

### 现象

把错误文案抽成共享文件 `cloudfunctions/errors-human.js` 之后，
两个云函数里写的是：

```javascript
var human = require('../errors-human.js');   //✗ 部署后必然 500
```

在仓库里跑得好好的（`../` 就是 `cloudfunctions/`，文件确实在那儿），
测试也全绿。但**部署到 CloudBase 后，每一次调用都会返回 500**：

```
Cannot find module '../errors-human.js'
```

### 为什么测试永远发现不了

CloudBase 部署时会把整个函数包解压成**一个独立的根目录**，
父目录（也就是 `cloudfunctions/`）根本不存在。
而部署**不会报错** —— 控制台点下去显示「部署成功」，
只有真正调用时才炸。日志里那一句 module not found 也不容易让人联想到「是路径写错了」。

### 现在的修法

```javascript
var human = (function () {
  try {
    return require('./errors-human.js');   // 部署后走这条（包内同级）
  } catch (e1) {
    return require('../errors-human.js');  // 本地仓库里走这条（兄弟目录）
  }
})();
```

### 验证方法（**部署前就能跑**，不用真部署）

```bash
cd "D:/Vibe Coding"
# ① 把每个函数包复制到一个独立目录（模拟部署后的解压结果）
for d in items reminders health; do
  mkdir -p ~/.workbuddy/tmp/depcheck/$d
  cp cloudfunctions/$d/*.js cloudfunctions/$d/package.json ~/.workbuddy/tmp/depcheck/$d/ 2>/dev/null
  cp cloudfunctions/errors-human.js ~/.workbuddy/tmp/depcheck/$d/
done

# ② 在那个独立目录里require 一次 —— 这一步就能复现 500
cd ~/.workbuddy/tmp/depcheck
for d in items reminders health; do
  node -e "try{require('./$d/index.js');console.log('  $d OK')}
          catch(e){console.log('  $d FAIL:',e.message)}"
done
```

**期望**：三行全OK。
**实测记录**：修之前 items / reminders 两行 FAIL（`Cannot find module '../errors-human.js'`），
health 因为不require 共享文件所以一直 OK —— **这也是为什么只测一个函数会漏掉这个问题**。

### 教训

> **「本地能跑」不等于「部署后能跑」。**
> 跨目录 `require` 是云函数里最隐蔽的一类错：本地测试全绿、部署显示成功、一调用才500。
> 判据不是「有没有报错」，而是**「部署后的目录结构跟仓库里一样吗」** ——
> 不一样，就必须把包复制到独立目录里再 require 一次。
>
> 顺带一条：`health` 函数一直OK，因为它不 require 共享文件。
> → **三个函数都要各自测，别测通一个就以为三个都对。**

---

## 每次改动后跑这四条（40 秒）

```bash
cd "D:/Vibe Coding"
node --check cloudfunctions/items/index.js && node --check cloudfunctions/reminders/index.js
node cloudfunctions/test_logic.js | tail -3        # 期望：ALL PASS
node cloudfunctions/audit_day23_input.js | tail -4  # 期望：有问题 0
```

再补一条密钥扫描（就是第 1 项那条grep），确认没手滑写死密钥。

还有第6 项那个「包内自检」—— 只要动了云函数之间的引用就得跑，
它是唯一能在部署前抓到「部署后必500」的检查。

---

## 还没做的（诚实记录）

| 项 | 状态 | 为什么 |
|----|------|-------|
| 前端 XSS 防护 | 未做 | 本项目 `title` 等字段全由用户自己输入，无跨用户场景。**将来若做分享/多人用，必须补** |
| 速率限制 | 未做 | 自用单用户，接口无公网写权限保护 |
| HTTPS 强制跳转 | 网关层 | 不在函数内，CloudBase 网关默认已 HTTPS |
| 前端仍走 localStorage | Day 24+ | 读通了写还没通，前端接入在后一天 |