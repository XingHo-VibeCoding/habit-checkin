# 每日打卡清单

个人自用的**手机网页清单**：打开就能看到今天要做的事、做完勾掉；
同时对作业截止、赶火车这类有明确时间点的事做提醒（支持提前量）。

> 提醒这块改过三次：Day 4 曾把提醒整块移交给手机日历（D8），2026-09-21 又搬回网页（**D11**）——
> 因为真正的问题是两处割裂、打开清单看不见今天的时间点安排。关着浏览器也要响的话，
> 仍需导出 `.ics` 导入系统日历（F6）。

按 24 天学习计划推进，每天一个提交。

| 时间 | 进度 |
| --- | --- |
| Day 2 | 仓库初始化，占位首页，忽略规则（含 `.env`） |
| Day 3 | 需求研究（research.md）：三个同类产品比较、本期不做清单 |
| Day 4 | PRD（PRD.md）：功能范围、明确不做 14 项、验收标准、AI 自检；追加决策 D8（提醒移交手机日历，**2026-09-21 由 D11 推翻**）与 D9（需部署到 GitHub Pages） |
| Day 5 | 技术设计（TECH_DESIGN.md）：一句话数据流、前后端与数据库分工、技术路线、数据流图 |
| Day 6 | 完善项目规则（AGENTS.md）：第八节追加两条规则 —— 推送结果只认接口、同一操作重试不超三次 |
| Day 7 | MVP 主功能落地：F4 存储 / F1 今日清单 / F3 逾期区 / F2 提醒 / F6 导出 `.ics`；进击的巨人风格视觉 + 底部看板娘；补「本地运行」一节 |
| Day 8 | 主视图 mock 数据版：抽出可替换的数据层、补齐四态渲染（加载 / 空 / 错误 / 正常）；改为浅色羊皮纸地图风，加城墙砖缝与兵团标签；补完 PRD A8 真机验证（`.ics` 导入系统日历后闹钟确实会响） |
| Day 9 | 按设计规则做一遍前端审查并修复（触控目标 44px、键盘焦点可见、对比度达标）；进度数字主角化、提醒区改默认折叠；顺带清掉已废弃的旧看板娘图 `mascot.jpg` |
| Day 10 | 今日清单**整行可点** —— 手指落在行内任何位置都能勾掉，不必精准戳中 22px 的小方框 |
| Day 11 | 删除后可反悔：删掉一条后底部浮出「已删除 · 撤销」 |
| Day 12 | 今日清单加筛选条；并**创建 Skill**（`skills/filter-check/SKILL.md`）—— 把「筛选三态该怎么验」固化成文件，真实调用一次并把结果写回调用记录 |
| Day 13 | 单页拆为**三个视图**（今日清单 / 提醒 / 已完成），用 hash 路由切换（`#/today`·`#/reminders`·`#/done`）；空 / 加载 / 错误 / 正常四态补齐到**视图级**（加载和错误时保留标签栏）；修掉重试按钮会清掉 hash 的 bug；删去与「已完成」视图重复的筛选按钮 |
| Day 13+ | 用 frontend-design 技能做视觉与可访问性打磨：控件边界达 WCAG 3:1、页签与筛选靠形状分层、日期与完成度改衬线展示字、加纸颗粒噪点、动效编排与降级 |
| Day 13+ | 主屏蓝图落地 + 倒数纪念日可录入：research 追加第十节（形态方向与课表参照）；主屏加「倒数条」「今天的课」两块骨架（**无数据整块隐藏**，假数据只在 `?state=mock` 出现）；倒数纪念日可增删改（管理区放提醒视图，主屏那行只展示、点一下跳过去） |
| Day 14 | 真人可用性测试（记录存 `usability.md`）。同学反馈「切换视图点击太麻烦」→ 加横滑；「拖着不跟手」→ 手写 touch 事件版**两次被否后全部回退**，换成浏览器原生 `scroll-snap` 横向滚动；「布局不喜欢」→ 三选一后定为 **C 极简浅色**（白底 + 单一强调色 `#2f6feb`，纸纹/斜纹/砖缝/立绘下线，页头的主题标签与徽章一并移除 —— 不再走原来那套动漫主题）。选中指示条按滚动比例实时跟手，过半即换高亮 |
| Day 14+ | 真机复测后的**溢出与手感收尾**：长条目撑破容器（`min-width: 0` + 可收缩 flex）、相邻页内容穿插（**按 Henry 的思路：页间留 4px 缝 + 贴边方块内缩**，我前两轮死磕 `overflow: hidden` 均作废）、滑动提速（`will-change` + 每页合成层）、加禁缓存 meta（手机改动不生效是缓存不是 bug）、撤销条配色跟上新主题（亮金 → 亮蓝 `#9ec1ff`，主题蓝压深底只有 3.46:1 不合格）、撤销停留 4s → 2.6s。**验收记录收尾**：`usability.md` 卡点表 1~8 步按「不编」原则填完 —— 同学那次当时没逐条记，照实标「未逐字记录」；另立一栏放 Henry 真机自用的逐字原话（可映射回 2/5/6/7/8 五步）。结论：8 步里真正卡住的只有「内容溢出」一种，功能路径没堵 |
| Day 14++ | 第 10 次反馈「点击不如滑动，滑动不丝滑」→ 修两处：**① 点标签会「二次修正」**（页间加了 4px 缝之后吸附点是 `N×(页宽+4)`，旧算法仍按 `N×页宽` 滚，点第 3 个标签差 8px、滚完再被吸附拉回来；现在滚到真实吸附点）；**② 滑着顿**（scroll 回调每帧读 `clientWidth` = 每帧强制同步重排，现在几何只在 `measureGeo()` 量一次，resize / 转屏时重量）。已用桩数据验证吸附点 `[0, 404, 808]`（旧值 `[0, 400, 800]`） |
| Day 15 | 倒数纪念日支持**每年重复**（生日 / 周年）：勾选后自动滚到下一次，**永远不会变成「已过去」**，并显示「第 N 个」；闰日 2-29 在平年退化到 2-28（不溢到 3-1）；老数据无 `yearly` 字段天然兼容 |
| Day 15+ | **PWA 第 1 步**：`manifest.json` + 192/512 图标（蓝底白勾，全出血，`purpose: any maskable`），head 加 `<link rel="manifest">` 与 `theme-color`。安卓浏览器菜单里出现「添加到主屏幕」，加完是真桌面图标、以 standalone 运行（无地址栏）。**故意不含 Service Worker** —— 今天刚加禁缓存 meta 解决「手机看不到更新」，SW 会把 index.html 再缓存住，等于把痛点请回来。第 2 步（SW 离线缓存）留到以后决定 |

| Day 15++ | **后端起步（Day 15 正式清单）**：CloudBase 环境开通（环境 ID `habit-checkin-d9giln6ke6594e88b`，上海，**体验版 3000 点**，到期 2027-04-02）→ 部署 `health` 云函数（Node.js 20.19，代码在 `cloudfunctions/health/index.js`）→ HTTP 网关路由 `/api/health`（GET）→ curl 200 返回 `{ ok:true, data:{ status:'ok', service:'habit-checkin', time:"...Z", version:'day15' } }`。产出 `api-contract.md`：统一信封 `{ok,data}` / `{ok:false,error:{code,message}}`、错误码表、Day 16–20 未实现接口占位、CloudBase 开通部署附录。**⚠️ 前端今天仍完全走 localStorage，不接后端** |

| Day 16 | **数据模型 + 建表 + 种子**：两张核心表 `items`（每日清单）与 `reminders`（提醒），关联字段 **`reminders.item_id` → `items.id`** —— 刻意**可空**，因为「高铁去上海」这类提醒不挂任何清单，定成 NOT NULL 就存不进来；删清单级联删掉挂在它下面的提醒。产出 `db/schema.sql`（字段类型逐个写理由）、`db/seed.sql`（用 DELETE+INSERT 保证跨 MySQL/SQLite 幂等）、`db/verify_local.py`（本地 SQLite 实跑 **11/11**：两表各 6 行、schema 与 seed 重复执行都不报错且行数不变、JOIN 出 4 条、独立提醒 2 条、级联删除与外键拦截都生效）。另附 `db/verify.sql`（控制台 select 验证语句）与 `db/README.md`（CloudBase PostgreSQL 执行步骤） |

| Day 17 | **GET 读接口**：`GET /api/items` + `GET /api/reminders` 两个云函数（`cloudfunctions/items/`、`cloudfunctions/reminders/`），读 CloudBase PostgreSQL 真数据，套契约信封 `{ok:true,data:[...]}` 返回。关键决策：**不直连 PG 的 TCP 端口**（体验版两条直连路径都走不通），改走平台自带的 PostgREST 层 `https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/<table>` + 服务端 API Key（网关解成 `service_role`，绕过 RLS —— 本环境无用户体系、无 RLS 策略，转发调用方 token 会查到 0 行）。用内置 `https` 而非 `fetch`（运行时可能是 Node 16）。`data` **直接用数据库列名不做前端映射**，映射推到 Day 18。新增错误码 `CONFIG_MISSING` / `UPSTREAM`（排查动作不同，不合并进 `INTERNAL`）。本地 `cloudfunctions/test_logic.js` 打桩 https 实跑 **37/37 通过**（方法守卫、参数校验、查询串拼接、信封形状、上游错误处理）。部署步骤、凭据配置、排障表见 `cloudfunctions/README.md` |

| Day 18 | **建表 + 写接口**：`db/schema.sql` 定稿两表字段与索引、`db/seed.sql` 种 6+6 行样例数据（**SQL 必须同时能跑 PostgreSQL / MySQL / SQLite** —— 类型只用 `VARCHAR(n)/SMALLINT/INT/TEXT`，幂等只能用 `DELETE...WHERE id LIKE 'seed-%'` + `INSERT`，**不能用 upsert**，三家方言不同；且**真实数据 id 绝不能用 `seed-` 前缀**，会被 seed 清掉）。新增 `POST /api/items`（`Prefer: return=representation`、主键冲突返回 409 `DUPLICATE`、不写 `resolution=merge-duplicates`）。控制台实跑 SQL 验证通过 |

| Day 19 | **分层重构**：把数据库操作从接口层拆到 `itemsRepository.js` / `remindersRepository.js`，接口只留「接请求、调函数、返响应」。判据是**「换掉数据库，这段代码要不要改？」** —— 要改才算 repository（重复比跨函数 HTTP 耦合便宜）。契约一个字段没动。回归遇到两个假警报：① PostgREST 不带 `order` 时返回顺序不保证稳定，`seed-item-02/03` 换了位置就以为改了行为 → 改用**按主键排序后的集合指纹**；② 回归 POST 写入的行让基线变 12 行 → 比对前排除本次写入 id。本地测试 **222/222**，线上 10 项回归全过 |

| Day 20 | **前端接公网接口**：`fetchState()` 从 localStorage 换成 `fetch(API_BASE + path)`，字段映射在前端做（`plan_date→date`、`remind_at→at`、`lead_minutes→lead`、`done` 的 `0/1`↔`boolean`，UTC→本地时间给 `datetime-local`）。**CORS 从 `*` 改成域名白名单**（`ALLOWED_ORIGINS` 环境变量，精确匹配、陌生 Origin 不发头而非退回 `*`、命中时加 `Vary: Origin`；补 `Access-Control-Expose-Headers` 否则浏览器读不到 `X-Version`/`Date`）。失败时**退回本地数据并在底部说明**，不白屏。新增**检查台**（抽屉式，不挡主界面）：链路健康 + 核心表真实数据与原始 JSON + 写入测试（id 带时间戳，可重复点）+ 「最后更新时间」取服务器 `Date` 响应头。本地 **237/237**、字段映射 **21/21**；线上公网首页已显示数据库真实数据 |

| Day 21 | **周验收 + 同伴交叉验证**：18 条验收判据全按「接口/数据」分层，**没有一条从「用户点一下」出发** → 深夜复核发现页面上**新增/勾选/删除三个动作全都没写数据库**（`index.html` 全文只有一个 `POST`，在检查台的「写入测试」按钮里），且 `fetchState()` 接口成功时用数据库那份整份替换本地 → **本地新增的条目刷新即消失**。验收表从 10 过降为**8 过 / 7 FAIL / 3 部分**（A2、A7 降为部分）。教训写进文档：**判据表不是把已有判据填一遍就完事，得回头问「我漏了哪个维度」**；Day 19 判据太严（假警报）、Day 21 判据漏了一维（假通过）。交付三个静态 HTML（验收表 / 演示提纲 / 提词卡）供手机截图 |
| Day 22 | **PATCH / DELETE 闭环**：改（局部更新，白名单 `title/plan_date/done/done_at`，`id` 与 `created_at` 不可改）与删（**找不到行返 404 不返 200**，`?force=1` 显式幂等）。删除为什么比新增更容易出事 —— 三层不对称：① 新增错了能再改，**删了没有「原样恢复」这个操作**；② `reminders.item_id` 的 `ON DELETE CASCADE` 让删除范围失控；③ **POST 重复发撞主键 409，DELETE 重复发第二次「成功地什么都没做」**。对应的确认是 `repo.exists()` 预查 + 404 而非谎报。前端加**删除二次确认弹层**（此前全仓零个 `confirm()`；撤销条只有 2.6 秒窗口，够不上「动手前拦住」）。⚠️ **HTTP 网关的「路径透传」必须开** —— 关着时触发路径会被剥掉（`/api/items/xxx` 只传 `/xxx`），这是 id 传不进函数的真根因；同一处还叠着一个代码 bug：`handleGet` 压根不读 path 里的 id，**藏了 5 天**（Day 17~21 都用 `?date=` 查列表，没走过单条路径 —— 没被走过的分支不会被发现）。本地**339/339**；公网 CRUD 四类操作实证通过且路径形式零副作用。实证记录 `verify-day22-public.md`、库侧验证 `db/verify-day22-patch-delete.sql` |
| Day 23 | **密钥排查 + 错误提示统一 + 安全审计**（先审计后修复）。四份审计结论：**工作区 0 条真实密钥、Git 全历史 0 条真实密钥 → 无需作废任何密钥**；`.gitignore` 补 5 类漏网（`*.pem`/`id_rsa`/`secrets.json`/`.npmrc` 等，用造假文件 + `git check-ignore -v` 实测出来的）；裸报错从响应体挪进日志，响应只给人话（「给人看的说人话，给排查看的留原文」）。三类错误**故意不合并** —— 输入错/配置缺失/上游失败的下一步动作完全不同（改输入 / 找开发 / 等），合成一句「操作失败」会让三类人都去重试。新增 `cloudfunctions/errors-human.js` 共享文案（Day 17~20 每次改 items 都得记得改 reminders，已漏过一次）；`guessDbReason` 每句带「可能」—— 猜错比不给更糟。**非法输入审计 62 条抓到 4 个真问题**：`?date=2026-02-31` 以前返 200 空数组（**跟「这天没待办」完全一样，不报错，只是那天清单永远空的**）、`event` 为 null 以前默默按 GET 处理返回全量、查询参数拼错以前静默忽略（**不产生任何错误信号**）、GET 的 id 缺格式校验（PATCH/DELETE 一直有）。⚠️ **顺带抓到 `require('../errors-human.js')` 部署后必然 500** —— CloudBase 把函数包解压成独立根目录，父目录不存在，而**部署不报错、一调用才炸**，本地测试永远发现不了（测的是仓库结构）；改成`./` 与 `../` 双路径，并新增「复制到独立目录 require 一次」这条部署前检查。本地 **386/386** + 审计 **62/62**；公网三函数版本号 `day23`，四类新增校验逐条实证，回归零污染（库回9 条）。交付 `security-checklist-day23.md`（每项含可复制命令）、`verify-day23-public.md`、`.env.example`、`audit_day23_input.js` |
| Day 24 | **前端写入闭环 + 修一个真实 Bug（复现→定位→修复→验证）**。**写入**：新增/勾选/删除分别接 `POST /api/items`、`PATCH /api/items/{id}`、`DELETE /api/items/{id}`；`id` 由**客户端生成**（幂等键 —— 服务端现生成的话手快点两下就是两条不同 id 的记录，幂等键形同虚设）；`done` 在库里是 `SMALLINT` 所以发 `0/1` 不发 boolean；失败**不回滚本地状态**（回滚会跟用户的手动操作打架），而是「自动重试一次 → 仍失败才弹『这次没存上』+ 重试按钮」。撤销路径传 `['DUPLICATE']` 忽略 409：DELETE 发送前就失败时 POST 会撞 409，而 409 恰是「它还在」，当成失败会在用户刚做完正确操作后立刻弹一条**误报**。**Bug**：撤销条「一次只挂一笔」（Day 11 就这么写的，注释里明说「删新的会顶掉旧的」），快速连点删两条时第一笔被顶掉 —— 纯本地时代顶多丢一条，**接数据库后两条的 DELETE 都已真生效，被顶掉那条本地云端一起消失且无法恢复**；用任务书指定的刁钻输入「快速连点」稳定复现。定位靠**在关键状态上打印看它随操作怎么变**（`pendingUndo` 从 a 变成 b 的那一刻根因就定死），排除了 save/render/云函数幂等/`force=1`/事件绑定五个方向。修复：`pendingUndo` 改队列 + 撤销**倒序**插回（正序会把后删的排到前面，顺序乱）+ 云端逐条重新 POST；文案单条时与修复前完全一致。验证 **20/20**；回归写入 18 + 同步 7 + 后端 **386** + 非法输入 **62** 全绿，零污染。**顺手发现但按任务书要求只记录不修** 3 个（含 `anniversaries` 表未建，现在修必404）。交付 `verify-day24-bug.md`、`test_day24_bug_repro.js`（修复前存档，**不读代码**）、`test_day24_bug_fixed.js`（读真代码验修复）、`test_day24_write.js`、`test_day24_sync.js` |

## 数据从哪来（Day 20 起）

⚠️ **读通了，写还没通**（Day 21 深夜复核发现，至今未修）：页面上的**新增、勾选、删除**三个动作
**全都只写浏览器 localStorage，一行都没进数据库**。Day 22 只给删除加了二次确认弹层，
**没有把删除接到接口上** —— 这三件事是下一阶段 P1。

**已经不在 localStorage 了。** 现在每次打开页面都去云端数据库读：

```text
页面 → fetch(https://habit-checkin-d9giln6ke6594e88b-….tcloudbase.com/api/items)
     → HTTP 网关 → items 云函数 → PostgREST → PostgreSQL
```

页面底部会**明说数据来源**：

| 底部提示 | 含义 |
| --- | --- |
| 数据来自云端数据库 | 全都读到了，正常 |
| 部分退回本地（数据库没读到） | 有接口挂了，用的 localStorage 兜底 —— 去看检查台 |
| 数据只存在这台设备的浏览器里 | 只有旧版页面才会出现 |

**读不到就退回本地，不白屏。** 断网、云函数改坏了、白名单漏配域名，页面照样能用，
只是数据来源提示会变。退回原因记在 `localStorage` 的 `_remote` 里，检查台会显示。

### 检查台

页面底部「检查台」按钮打开。三块内容：

1. **链路健康** —— HTTP 状态、`service`、`X-Version`、服务器 `Date`
2. **核心表真实数据** —— items / reminders 各多少行，可展开原始 JSON
3. **写入测试** —— POST 一条到 items，**id 带时间戳所以可以反复点**

⚠️ **写入测试会真的往数据库插数据**（`d20-probe-<时间戳>`）。
现在还没有 `DELETE` 接口，删不掉，要清就在控制台跑：

```sql
DELETE FROM items WHERE id LIKE 'd20-probe-%';
```

### 演示态还在

`?state=mock` / `?state=empty` / `?state=loading` / `?state=error` 都还能用，
**优先级高于真接口** —— 演示和截图时用它们，不受数据库状态影响。
`mock` / `empty` 不写盘，不动真实数据。

## 本地运行

**必须起本地服务器，不要双击打开。** 两个原因：一是 `file://` 下不同浏览器对 localStorage 的处理不一致（数据可能存不住或跟 `http://` 下的不互通）；二是截图、验证都要求在 `localhost` 地址下看。

在项目目录下执行：

```bash
python -m http.server 8000
```

然后浏览器打开 **http://localhost:8000**。

- 改完文件**不用重启服务器**，Ctrl+F5 强刷即可
- Windows 上如果 `python` 不在 PATH，用完整路径（本机托管版）：
  `C:\Users\MILK\.workbuddy\binaries\python\versions\3.13.12\python.exe -m http.server 8000`
- 停掉服务器：在跑命令的终端里 `Ctrl+C`

**看数据本体**（排查用）：F12 → Console 里执行
`localStorage.getItem('habit-checkin:v1')`
—— 所有清单和提醒都存在这一个 key 里，没有第二处。

## 四种页面状态

取数据这件事是**异步**的（`fetchState()`，真接口有网络往返），所以页面有四种样子。
正常访问按真实条件走；想固定看某一态，加 URL 参数：

| 网址 | 看到什么 |
| --- | --- |
| `http://localhost:8000/?state=mock` | 假数据版（3 条清单 + 2 条提醒），演示和截图用这个 |
| `?state=empty` | 空态 —— 今日清单、提醒都是空的 |
| `?state=loading` | 骨架屏，停住不跳走 |
| `?state=error` | 取数据失败的样子，带「重试」按钮 |

演示态（`mock` / `empty`）**不写回 localStorage**，不会动你的真实数据。

**为什么要有这套开关**：四种状态里最容易漏的是「错误」—— 开发环境里它从来不出现，写完了也看不见。
看不见的东西没人会主动验证它，所以给它留一个能被主动点开的入口。

Day 20 补了一条：真接口读失败时**自动退回本地数据**，所以「错误态」和「退回本地」
是两件不同的事 —— 前者是 `?state=error` 强制触发的，后者是网络/后端出问题时的兜底。
底部提示和检查台会区分。

## 预览

网址：**https://daily-checkin-list.app.workbuddy.host/** —— 手机直接打开就能用。

线上已更新到 **Day 20**（2026-10-06）：首页显示的是**云端数据库里的真实数据**，
底部写「数据来自云端数据库」；底部「检查台」可看链路健康、真实数据与写入测试。

**Day 22（2026-10-08）后端已到 day22**：`GET/POST/PATCH/DELETE /api/items` 四类操作
公网实证通过，`GET /api/items/{id}` 单条查询可用。
⚠️ 但**前端还没接写入**（见上面「数据从哪来」一节的警告），
页面上的新增/勾选/删除仍只写 localStorage。

**Day 23（2026-10-09）后端已到 day23**：三个云函数（`items` / `reminders` / `health`）
均已部署。错误提示全部换成中文人话，技术细节（`getaddrinfoENOTFOUND`、
`duplicate key value...`、`PG REST 返回 503`）**不再出现在响应里，改进日志**。
新增 4 条输入校验（不存在的日期、拼错的查询参数、id 格式、`event` 为空）。
密钥扫描：工作区与 Git 全历史均 **0 条真实密钥**。
（发布不自动同步 —— 本地改完功能要重新发布一次，线上才会更新。）

Day 15+ 那时的能力也都还在：今日清单能勾/能加/能删，逾期区、提醒、导出 `.ics` 都可用；
三个视图可点标签切换、**也可左右滑动**；「提醒」页底部可录入倒数纪念日，
加完主屏顶部显示「距 XX 还有 N 天」，**勾「每年重复」可记生日 / 周年**。
手机浏览器菜单里可**「添加到主屏幕」**。

⚠️ **本地调试要用 `localhost`，别用 `127.0.0.1`。**
这两个是不同的源，而跨域白名单只配了 `http://localhost:8000`。
用 `127.0.0.1` 打开会读不到云端数据（页面会退回本地并给出提示）。
要两个都能用就把 `http://127.0.0.1:8000` 也加进三个云函数的 `ALLOWED_ORIGINS`。

**为什么不是 GitHub Pages**：`habit-checkin` 仓库属于组织 `XingHo-VibeCoding`，当前账号只有写权限、没有仓库管理权，开不了 Pages。所以先用 WorkBuddy 的发布通道拿到一个手机能访问的网址；等拿到组织权限或迁到个人账号再换。

**怎么更新**：改完网页重新发布一次即可（不是自动同步）。发布是本地目录 `.deploy/`，只放网页文件 —— 有意把 `PRD.md`、`research.md`、`AGENTS.md` 和工作日志排除在外，避免它们变成公网可读。

电脑上想看效果，用上面的「本地运行」起服务器 —— 别双击 `index.html`。

**发布时的图片（Day 15+ 已失效，按这段来）**：页面本体不引图片，但 **PWA 图标必须拷** ——
`assets/icon-192.png` 和 `assets/icon-512.png` 由 `manifest.json` 引用，漏拷的话「添加到主屏幕」
会拿不到图标（安卓会退化成浏览器默认图标，不报错，但很难看）。命令：
`cp index.html manifest.json .deploy/ && cp assets/*.png .deploy/assets/` —— `assets/` 里现在还留着
`mascot.png`（旧看板娘素材，已无引用，拷过去不影响），要不要删由 Henry 定。
（Day 9 已删掉旧的 `mascot.jpg` —— 透明立绘存不了 jpg。**别再用「只拷 `*.jpg`」的老命令**。）

⚠️ **发布目录 `.deploy/api/health.json` 是 Day 15 的静态假数据**（`version: day15-mock`）。
Day 20 的前端不再引用它（健康检查改成打真接口），但文件还在。
留着无害，别被它骗到 —— 判断线上版本请看检查台里的 `X-Version`，那个才是真的。
