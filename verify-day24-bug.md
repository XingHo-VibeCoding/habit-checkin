# Day 24｜真实 Bug 修复实证：快速连点删除，第一笔撤销被顶掉

日期：2026-10-09
任务：**修复一个真实 Bug 并留全证据**（板块顺序：① 复现 ② 定位 ③ 修复 ④ 验证留证）

---

## 一句话结论

撤销条「一次只挂一笔」，快速连点删除两条时第一笔被顶掉；接了数据库之后，
两条的`DELETE` 都已真的生效，**被顶掉的那条在本地和云端同时消失，且无法恢复**。

修复：把 `pendingUndo` 从单值改成队列，撤销时整批倒序插回，云端逐条重新 POST。

---

## ① 复现

复现脚本：`test_day24_bug_repro.js`（**证据存档，不读index.html**）

为什么它不读代码：它记录的是**修复之前**的行为。如果让它去读现在的 index.html，
断言会全部 FAIL，读起来像「bug 还没修」，反而误导人。修复后的验证在下一节那个脚本里。

实际输出（修复前）：

```
删掉 a 之后：
  state.items = [ 'b' ]
  pendingUndo 挂的是= a

删掉 b 之后（快速连点第二次）：
  state.items = []
  pendingUndo 挂的是= b

用户点一次撤销之后：
  state.items = [ 'b' ]

实际发出的数据库请求：
   DELETE  a
   DELETE  b
   POST     b
```

复现输入就是任务书里指定的**刁钻输入：快速连点**。

### 为什么这个 bug 值得当主角

| 维度 | 说明 |
|---|---|
| 触发成本极低 | 删除有二次确认弹层（Day 22 加的），但**连点两次 ✕ 的速度可以很快**；Day 10 把整行改成可点后 ✕ 就在手边 |
| 后果不可逆 | 接数据库后，DELETE 已真实生效，撤销只插回本地一条 |
| 老问题被放大 | Day 11 纯 localStorage 时代顶掉顶多丢一条，重打一遍字就回来了 |
| 静默失败 | 用户不会看到任何报错，只是"咦刚才那条怎么没了" |

---

## ② 定位

根因就一行：

```javascript
var pendingUndo = null;   // 一次只挂一笔
```

`doRemoveItem` 里做的是**赋值**而不是入队：

```javascript
pendingUndo = { kind: 'item', item: state.items[index], index: index };
//               ↑ 第二次删除直接覆盖第一次
```

###排除掉的其他原因（这是今天真正要练的东西）

| 怀疑 | 怎么排除的 | 结论 |
|---|---|---|
| `save()` 没写对localStorage | 删单条时localStorage 是对的；连删两次后 `state.items` 也确实是空 | 排除 |
| `render()` 重绘把数组搞乱 | 打印 `state.items` 一直是正确结果，重绘只影响 DOM 不影响数据 | 排除 |
| 云函数 DELETE 幂等度不够 | 两条 DELETE 都返回成功，服务器上确实只剩一条——服务器**执行对了**，是前端少发了一个恢复 | 排除（错在前端不在后端） |
| DELETE 的 `?force=1` 参数导致误删 | 修复前实际没加 `force`，两次都是真删 | 排除 |
| 撤销按钮事件绑定断了 | 点一次撤销确实救回了 b——事件正常，只是救的对象不对 | 排除 |
| **第二笔删除把第一笔记录覆盖了** | 直接打印 `pendingUndo` 的值：删完 a 后是 a，删完 b 后变成 b，a 消失 | **← 就是它** |

**定位方法**：不是通读代码猜的，是**在关键状态上打日志/打印，看它随操作怎么变**。
`pendingUndo` 这个变量从「a」变成「b」的那一刻，根因就定死了。

---

## ③ 修复

### 改动1：`pendingUndo` 单值 → 队列

```javascript
// 改前
var pendingUndo = null;      // [{ kind, item, index }] 从旧到新，末尾是最近一次
// 改后
var pendingUndo = [];        // Day 24：入队，不再覆盖
```

### 改动2：两处删除改成入队

```javascript
// doRemoveItem
var record = { kind: 'item', item: state.items[index], index: index };
state.items.splice(index, 1);
pendingUndo.push(record);
showUndo();                    // 文案交给 defaultUndoMsg 自动生成

// removeAnniv
pendingUndo.push({ kind: 'anniv', item: state.anniv[index], index: index });
showUndo();
```

### 改动3：撤销整批恢复（**倒序**）

```javascript
function undoRemove() {
  if (!pendingUndo.length) return;
  var batch = pendingUndo.slice();   // 先复制：hideUndo() 会把原数组清空
  hideUndo();

  for (var i = batch.length - 1; i >= 0; i--) {
    var p = batch[i];
    var arr = p.kind === 'anniv' ? state.anniv : state.items;
    arr.splice(Math.min(p.index, arr.length), 0, p.item);
    if (p.kind === 'item') pushToDb(syncJobs.add(p.item), ['DUPLICATE']);
  }

  save();
  render();
}
```

### ⚠️ 为什么必须**倒序**插回

每条记录的 `index` 是「它被删掉那一刻的下标」。

原列表 `[a, b, c]`，删 `a`（index 0），此时 `[b, c]`；再删 `b`（index 0）。

| 遍历顺序 | 步骤 | 结果 |
|---|---|---|
| 正序 | 先插 a 到 0 → `[a,b,c]`；再插 b 到 0 → `[b,a,c]` | ❌ b 跑到 a 前面，顺序乱了 |
| **倒序** | 先插 b 到 0 → `[b,c]`；再插 a 到 0 → `[a,b,c]` | ✅ 正确 |

### ⚠️ 为什么文案取**最老**那条

撤销的语义是「把刚才删的都还回来」，那批里最早删的那条最具代表性。
取最近的会显示成「已删除 b」，读起来像「刚才只删了它一条」，反而误导。

单条时文案与修复前**完全一致**（`已删除「喝水」` / `已删除纪念日「结婚纪念日」`），
不引入任何用户可感知的意外变化。

---

## ④ 验证留证

验证脚本：`test_day24_bug_fixed.js`（**读真实的 index.html**，验的是现在这份代码）

```
-- Day 24 修复验证：快速连点删除后一次撤销 --

【场景一】两条，快速删掉，点一次撤销
  PASS  ① 两条都删光了
  PASS  ★ 撤销队列里挂了两笔（原来只挂一笔）
  PASS  ★ 队列顺序是「从旧到新」a→b

  state.items = []
  state.items = [ 'a', 'b' ]
  PASS  ★★ 一次撤销，两条都回来了
  PASS  ★★ 顺序恢复成原样 [a,b]
  PASS  ★ a 没丢（这是修复前永久丢失的那条）
  PASS  ★ b 也在

  实际发出的数据库请求：
     DELETE  a
     DELETE  b
     POST  b
     POST  a
  PASS  ★★★ 云端也一起恢复了：a、b 各自重新 POST
  PASS  ★ 撤销路径忽略 409（那条可能还在，不算失败）

【场景二】三条全删，一次撤销 —— 验证倒序插回不会打乱顺序
  连删 3 次后 items = []
  撤销 1 次后items = [ 'a', 'b', 'c' ]
  PASS  ★★ 三条都回来了
  PASS  ★★★ 顺序严格是 [a,b,c]（倒序插回生效）

【场景三】清单项和纪念日混删 —— 撤销要各回各的数组
  items  = [ 'x', 'y' ]
  anniv  = [ 'm1' ]
  PASS  清单项回到 state.items
  PASS  ★ 纪念日回到 state.anniv（没跑到 items 里去）
  PASS  ★ 纪念日不该发 POST（后端还没那张表，发了会永远重试）

【场景四】撤销条过期后，不能再撤销旧的 —— 机会只有 UNDO_MS
  PASS  ① 队列里有2 笔
  PASS  ② 过期后队列清空
  PASS  ② 过期后点撤销不会凭空变出东西

【场景五】只删一条时，文案要跟修复前完全一致（别引入新变化）
  PASS  单条文案 = 已删除「喝水」
  PASS  两条文案 = 已删除「甲」等 2 条
  PASS  纪念日单条文案保持原样 = 已删除纪念日「结婚纪念日」

结论：修复生效 —— 连删多条后一次撤销全部还回来，顺序、云端同步、文案都对。
20 通过 / 0 失败
```

### 全量回归（确认没连带破坏）

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `test_day24_bug_repro.js` | 修复前现场存档 | 6 通过 / 0 失败 |
| `test_day24_bug_fixed.js` | 本次修复 | **20 通过 / 0 失败** |
| `test_day24_write.js` | 写入请求形状（POST/PATCH/DELETE、字段映射） | 18 通过 / 0 失败 |
| `test_day24_sync.js` | 失败队列 + 自动重试 + 409 语义 | 7 通过 / 0 失败 |
| `cloudfunctions/test_logic.js` | 后端全逻辑 | 386 通过 / 0 失败 |
| `cloudfunctions/audit_day23_input.js` | 非法输入 | 62合格 / 0 问题 |

### 发布前冒烟（Day 7 定下的四步）

| 步骤 | 结果 |
|---|---|
| 1. JS 语法（抽出 script → `node --check`） | `SYNTAX_OK` |
| 2. id 空引用检查（`getElementById` 集合 vs `id=` 集合） | 差集只有 `diagJson_` —— 误报，那是动态拼接的 id（`'diagJson_' + key`） |
| 3. 纯逻辑实跑 | 本文件即 |
| 4. 发布后curl 验线上特征串 | 见下|

---

## 顺手发现但**没修**的问题（按任务书要求记录不扩展）

| # | 问题 | 判断 |
|---|---|---|
| 1 | `state.anniv` 没有对应的云端表，纪念日删除/新增全部只存本地 | 已知欠账，等建`anniversaries` 表那天一起做。**现在不能修** —— 表还不存在 |
| 2 | `.ics` 导出没包含今天新增的提醒（`reminders` 那部分） | 优先级低，可能本来就是设计如此（导出只导清单） |
| 3 | 撤销条 2.6 秒偏短，连删多条时用户可能来不及点| 低优先级。真要改要先问用户 |

> 记录而不修，是因为「顺手修别的 Bug」会把今天的证据链搞混 ——
> 出问题时说不清是哪个改动引入的。

---

## 最终回归（提交时点的完整状态）

| 项 | 结果 |
|---|---|
| 提交 | `069503f`「Day 24｜修好快速连点删除只保留最后一次撤销，并留全四步证据」 |
| 推送 | `ab14eee..069503f  main -> main`，**三道核验一致**（本地 HEAD = `ls-remote` = GitHub API） |
| 线上发布 | https://daily-checkin-list.app.workbuddy.host/ ；curl 核验 `pendingUndo.push` 2 处、`pushToDb` 6 处、`mascot.png` 200 |
| 工作区 | 干净（无未提交改动） |

全部测试脚本复跑（提交后）：

```
cloudfunctions/test_logic.js         386 通过 / 0 失败
cloudfunctions/audit_day23_input.js  62 条非法输入，合格 62，有问题 0
test_day24_write.js18 通过 / 0 失败
test_day24_sync.js                    7 通过 / 0 失败
test_day24_bug_fixed.js20 通过 / 0 失败
```

---

## 截图要求对照

| 要求 | 状态 |
|---|---|
| 截图一：复现证据 —— 撤销条显示「已删除「甲」等 **2** 条」 | 待用户手机真机截 |
| 截图二：修复后 —— 点一次撤销两条都回来，带地址栏 | 待用户手机真机截 |
| （补充）F12 Network 里两条 `POST /api/items` | 待用户手机真机截 |

> ⚠️ **本Bug 是静默失败**：用户界面上不会出现任何红色报错，
> 所以「F12 控制台报错原文」这一项在本Bug 上**没有对应物**。
> 等价物是 F12 → Network 里的请求序列 ——
> **修复前是`DELETE ×2 + POST ×1`（删两条只回来一条），
> 修复后是 `DELETE ×2 + POST ×2`**。这才是这个 bug 的原始证据。
>
> 另外这个 bug 之所以能在 Day 11 到Day 24 里藏这么久，
> 正是因为它不报错 —— 没有任何错误信号，只有「数据悄悄少了一条」。