-- ===========================================================================
-- habit-checkin · 数据模型与建表（Day 16）
-- ---------------------------------------------------------------------------
-- 目标库：CloudBase PostgreSQL 数据库（Henry 截图显示默认是 PostgreSQL，
-- 支持原生 SQL）。
-- 本文件同时兼容 SQLite / MySQL —— 这样在云端开通之前，我本地就能实跑验证
-- （见 db/verify_local.py）。类型一律挑两边都认的：
--   VARCHAR(n) / CHAR(n) / SMALLINT / INT / TEXT
--
-- 【可重复执行】用 DROP TABLE IF EXISTS + CREATE TABLE，跑几次都行。
--   顺序必须「先删子表 reminders、再删父表 items」—— 反了会被外键拦住。
--   ⚠️ 代价：DROP 会连同表里的真实数据一起删掉。
--      「先删后建」是刻意换来的重复执行能力，只在建表 / 重置环境时跑，
--      别当成日常脚本 —— 真要清数据请显式确认，不要靠副作用。
-- ---------------------------------------------------------------------------
--
-- 【两张表分别存什么】
--   items      —— 每日清单条目。今天要勾的那几件事。
--   reminders  —— 提醒。到点要响的那几件事。
--
-- 【靠哪个字段关联】
--   reminders.item_id  →  items.id
--   有值   = 这条提醒挂在某条清单上，清单删了它跟着删（ON DELETE CASCADE）
--   NULL   = 独立提醒，跟任何清单无关（比如「高铁去上海」）
--   ⇒ item_id 必须可空。这是这个模型里唯一需要咬一下牙定的地方：
--     定成 NOT NULL 的话，独立提醒这种真实存在的数据就存不进来了
--     （前端 mock 里的「高铁去上海」「作业截止」本来就是独立提醒）。
--
-- 【为什么是这两张，不是三张】
--   前端还有 courses（课表）和 anniv（倒数纪念日）。
--   courses 是蓝图占位数据、没有 id、不落 localStorage，不算真数据；
--   anniv 按任务清单的「卡住降级」可延到 Day 18 补。
-- ===========================================================================


-- 先删子表，再删父表（外键方向决定删除顺序）
DROP TABLE IF EXISTS reminders;
DROP TABLE IF EXISTS items;


CREATE TABLE items (
  -- 主键。前端 uid() = Date.now().toString(36) + 5 位随机，约 13 字符。
  -- 给到 36 是因为标准 UUID 正好 36 位：将来想换 UUID 不用改表结构。
  -- 不用自增整数：前端离线时也要能自己生成 id，自增必须回服务端问号。
  id           VARCHAR(36)  NOT NULL,

  -- 条目标题。200 是拍的上限：手机上一行都显示不完的标题本来就该改短。
  -- 不用 TEXT 是为了逼自己定个上限，而不是「反正能存就随便存」。
  title        VARCHAR(200) NOT NULL,

  -- 计划所属日期 'YYYY-MM-DD'（前端字段名是 date，这里改名 plan_date，
  -- 因为 date 在不少 SQL 方言里是关键字，写查询时容易踩）。
  -- 用定长 CHAR 不用 DATETIME：这是「日历上的一天」，不是「时间轴上的一个点」，
  -- 它没有时区，转成时间戳反而会引入「算出来差一天」的问题。
  plan_date    CHAR(10)     NOT NULL,

  -- 是否完成。用 SMALLINT 不用 BOOLEAN / TINYINT(1)：
  --   PostgreSQL 有 BOOLEAN 但没有 TINYINT，MySQL 没有真正的 BOOLEAN（TINYINT(1) 是它的别名），
  --   SQLite 有 BOOLEAN 但底层就是整数。
  --   只有 SMALLINT 是三家都认、且都能老实存 0/1 的类型 —— 这就是跨方言的代价。
  done         SMALLINT     NOT NULL DEFAULT 0,

  -- 下面两个是「时间轴上的点」，统一 ISO 8601 UTC（带 Z），跟 api-contract.md 一致。
  -- 存字符串而不是 DATETIME：前端本来就产 new Date().toISOString()，
  -- 直接存字节一致，不会因为数据库 / 驱动的时区设置被悄悄转一次。
  created_at   VARCHAR(32)  NOT NULL,

  -- 可空：没完成就是 NULL。用 '' 或 0 表示「没完成」都是编出来的哨兵值，
  -- 哨兵值的问题是将来一定有人忘记判断它。NULL 才是真话。
  done_at      VARCHAR(32)  NULL,

  PRIMARY KEY (id),

  -- 约束：日期必须长成 'YYYY-MM-DD' 的样子（_ 是单字符通配符）。
  -- 没有这条，'2026/10/02' 或 '明天' 这类值也能混进来，等按日期排序时才暴露。
  CONSTRAINT chk_items_plan_date CHECK (plan_date LIKE '____-__-__'),

  -- 约束：布尔只能是 0 或 1。挡住有人写 2 进去。
  CONSTRAINT chk_items_done CHECK (done IN (0, 1))
);


CREATE TABLE reminders (
  id           VARCHAR(36)  NOT NULL,

  -- 外键 → items.id。可空 = 独立提醒（理由见文件头）。
  -- 类型必须和 items.id 完全一致（都是 VARCHAR(36)），各 SQL 库才认这个外键。
  item_id      VARCHAR(36)  NULL,

  title        VARCHAR(200) NOT NULL,

  -- 提醒触发时刻，ISO 8601 UTC。
  -- ⚠️ 前端现在存的是本地时间串 'YYYY-MM-DDTHH:mm'（没有时区），
  --    入库那天要做一次本地 → UTC 的转换，不能原样搬。已记在迁移清单里。
  remind_at    VARCHAR(32)  NOT NULL,

  -- 提前多少分钟。存整数分钟，不存「90分钟」这种字符串 ——
  -- 字符串没法比大小、没法做算术，将来「提前 2 小时的提醒」这种需求就没法写。
  lead_minutes INT          NOT NULL DEFAULT 0,

  done         SMALLINT     NOT NULL DEFAULT 0,

  PRIMARY KEY (id),

  -- 清单删掉时，挂在它下面的提醒一起删，不留孤儿数据。
  -- 没有这条的话，删了清单还会剩下一堆指向不存在 id 的提醒，
  -- 而且这种脏数据不会报错，只会悄悄越积越多。
  CONSTRAINT fk_reminders_item
    FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,

  CONSTRAINT chk_reminders_done  CHECK (done IN (0, 1)),
  CONSTRAINT chk_reminders_lead  CHECK (lead_minutes >= 0)
);


-- ---------------------------------------------------------------------------
-- 索引：这三处是查询会按它筛的字段
-- 因为上面已经 DROP 过表，索引也跟着被删了，所以这几行重复跑不会撞名。
-- ---------------------------------------------------------------------------
CREATE INDEX idx_items_plan_date ON items     (plan_date);    -- 「今天」页按日期捞
CREATE INDEX idx_reminders_at    ON reminders (remind_at);    -- 提醒按时间排序 / 查到期
CREATE INDEX idx_reminders_item  ON reminders (item_id);      -- 按清单查它挂了哪些提醒


-- ---------------------------------------------------------------------------
-- 附：跟前端 localStorage 字段的映射（Day 17 写读接口时照这张表转）
-- ---------------------------------------------------------------------------
--   items:      date → plan_date      createdAt → created_at      doneAt → done_at
--   reminders:  at   → remind_at（⚠️ 本地串 → UTC，见上）   lead → lead_minutes
--   courses:    未建表（蓝图占位数据，无 id、不落盘）
--   anniv:      未建表（按降级条款可延到 Day 18）
