# 发布清单 · v1.0

> 目标：**发布这一步是可重复的，不是靠记忆。**
> 任何一次发布都按这张单子走；任何一项不过，不许点发布。

## 0. 版本标记

| 项 | v1.0 的值 |
|---|---|
| 版本号（人读） | `v1.0` |
| `sw.js` 的 `VERSION` | **`v1.0`** ← 见下方⚠️ |
| 代码提交 | 发布后把 sha 填进 `README.md` 的版本对照表 |
| 回退目标 | `069503f`（Day 24，无 sw.js、无纪念日） |
| 发布目录 | `D:\Vibe Coding\.deploy\`（**不是仓库根**） |

### ⚠️ `VERSION` 必须手动改，这是发布最容易漏的一步

**为什么**：Service Worker 缓存的是「`sw.js` 自己的字节」。
改了 `index.html` 但没改 `sw.js` → 浏览器认为 SW 没更新 → **用户永远拿旧版，且没有任何提示**。

```bash
# 每次发布前必查
grep -n "const VERSION" sw.js
```

**回退时同样要改**，但要改成「回退后那版自己的值」，不能沿用新版。

---

## 1. 发布前验证项

按顺序跑，**全绿才往下**：

```bash
# ① 契约检查（代码与数据是否还对得上）
python verify_project.py

# ② 全部测试
node test_day24_write.js && node test_day25_sw.js && node test_day24_sync.js
node cloudfunctions/test_logic.js && node cloudfunctions/test_anniversaries.js

# ③ 本地发布检查
python preflight.py
```

| 检查项 | 通过标准 | 不通过怎么办 |
|---|---|---|
| `verify_project.py` | `24/24 通过`，退出码 0 | 逐项看 FAIL 后面的「为什么查这条」 |
| node 测试 | 全部 `0 失败` | ⚠️ **别只看退出码** —— 顶层 `return` 会让测试静默截断而退出码仍是 0 |
| `preflight.py` | `8/8 通过`，退出码 0 | 见下表 |

**`preflight.py` 各 FAIL 的含义**：

| FAIL | 含义 | 后果（不报错的！） |
|---|---|---|
| A1 JS 语法 | 内联 JS 语法错误 | 白屏 |
| A2 id 空引用 | 用了不存在的 id | 某个按钮全都点了没反应 |
| A3 资源引用 | 引用了不存在的文件 / 大小写不匹配 | 裂图（Windows 能显示，Linux 404） |
| B1b 发布目录不一致 | `.deploy/` 还是旧版 | **线上改动根本没生效** |
| B2 assets 同步 | 图片没拷过去 | 线上裂图 |
| B3 密钥泄露 | 服务端 Key 进了前端代码 | 公网可读 = 别人能读写你的库 |
| C1 precache | SW 离线清单里有 404 | **整个离线能力静默失效**，控制台只留一条 warn |
| C3 线上是新版 | 线上缺新特征串 | 发的不是这版 |

### 拷贝命令（**png 也要拷**）

```bash
cp index.html .deploy/
cp sw.js .deploy/
cp manifest.json .deploy/
cp assets/*.jpg assets/*.png .deploy/assets/
```

⚠️ 沿用老的「只拷 `*.jpg`」会裂图 —— png 是看板娘透明立绘，jpg 存不了 alpha。

---

## 2. 发布步骤

```bash
# ① 改版本号
#    sw.js 里：const VERSION = 'day24-v1';  →  const VERSION = 'v1.0';

# ② 拷进发布目录
cp index.html sw.js manifest.json .deploy/
cp assets/*.jpg assets/*.png .deploy/assets/

# ③ 再跑一次本地检查（拷完文件之后，哈希变了，必须重跑）
python preflight.py

# ④ 记下当前提交，回退时要用
git log --oneline -1

# ⑤ 发布（这一步由 AI 调发布工具，或用 WorkBuddy 的发布通道）

# ⑥ 发布后立刻验线上
python preflight.py --online
```

⚠️ **发布是覆盖式的** —— 线上链接可能已经分享给别人，覆写之后**没法撤回**。
这就是必须有回滚演练的原因。

---

## 3. 发布后验证

**四项全过才算发布成功**：

```bash
# ① 页面可访问
curl -s -o /dev/null -w "%{http_code}" https://daily-checkin-list.app.workbuddy.host/

# ② 关键文件都在（尤其 sw.js —— Day 24 时代它一直是 404）
curl -s -o /dev/null -w "%{http_code}\n" https://daily-checkin-list.app.workbuddy.host/sw.js
curl -s -o /dev/null -w "%{http_code}\n" https://daily-checkin-list.app.workbuddy.host/manifest.json

# ③ 线上确实是新版（用本地代码里的特征串）
curl -s https://daily-checkin-list.app.workbuddy.host/ | grep -c "apiGet('/anniversaries'"
#   Day 24 = 0，v1.0 应该 ≥ 1

# ④ 完整检查
python preflight.py --online

# ⑤ 手机上打开，真能用（curl 只证明文件在，证明不了页面能用）
```

### ⚠️ 判状态码只能用这一种写法

```bash
curl -s -o /dev/null -w "%{http_code}"    # ✅ 只吐一个数字
curl -sI                                 # ❌ 这个环境返回两段式：
                                          #    HTTP/1.1 200 Connection Established  ← 代理隧道协商
                                          #    HTTP/1.1 404 Not Found                   ← 这才是状态
```

我曾因为读了两段式的第一行，把 404 看成 200。

---

## 4. 代码与数据备份方式

### 代码 —— git 就够了 ✅

| 备份点 | 位置 | 说明 |
|---|---|---|
| 每次提交 | 远端 GitHub `main` | 主备份。三路核验：local HEAD = ls-remote = GitHub API |
| **⚠️ 发布目录不在 git 里** | `.git/info/exclude` | 所以 `.deploy/` 没有版本历史，回退必须从仓库根的历史取 |

**结论：代码侧的回退能力是够的** —— 只要提交过就能取回任何一版。

### 数据 —— ⚠️ **没有自动备份**

这是当前方案最弱的一环，必须说清楚：

| 项 | 现状 |
|---|---|
| `items` / `reminders` / `anniversaries` 表 | **无自动备份** |
| 恢复手段 | CloudBase 控制台**手动导出** |
| 回滚网页能不能恢复数据 | **不能** —— 回滚只换网页，不动数据库 |
| `db/seed.sql` | 只是种子数据，**不是备份**。它只负责「重新灌一份空的」 |

### 手工备份步骤（目前唯一可行的）

1. CloudBase 控制台 → 数据库 → 找到表 → 导出
2. 存到 `D:\Vibe Coding\db\backup\YYYY-MM-DD-*.csv`
3. ⚠️ **这个目录别提交进 git**（数据文件可能含私人内容）

📌 **建议（不在今天的任务范围里）**：发布 v1.0 之后，把「怎么定期备份」单独立一个任务。
现在数据是**单点**的 —— 云端出问题或误删，只能靠手动导出的版本回。

---

## 5. 速查卡

```bash
# 发布前
grep -n "const VERSION" sw.js      # 1. 改了没？
python verify_project.py            # 2. 契约
python preflight.py                 # 3. 发布检查
cp index.html sw.js manifest.json .deploy/
cp assets/*.jpg assets/*.png .deploy/assets/
python preflight.py                 # 4. 拷完再跑一次

# 发布后
python preflight.py --online        # 5. 验线上
curl -s -o /dev/null -w "%{http_code}" https://daily-checkin-list.app.workbuddy.host/sw.js
# 6. 手机上打开确认

# 出事了
# 按 ROLLBACK.md 第 2 节；先跑第 1 节的判断表确认「该回滚」
```
