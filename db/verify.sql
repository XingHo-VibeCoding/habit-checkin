-- ===========================================================================
-- Day 16 · select 验证语句
-- ---------------------------------------------------------------------------
-- 用法：跑完 schema.sql 和 seed.sql 之后，把下面每条单独粘进 CloudBase 控制台
--       MySQL 数据库的 SQL 执行窗口跑一遍。
--       （本地想先跑一遍也可以：db/verify_local.py 已经用 SQLite 把这五条验过了。）
-- ===========================================================================


-- ① 行数：两张核心表都要 >= 5 行
--    期望结果：items = 6，reminders = 6
SELECT 'items' AS tbl, COUNT(*) AS rows_cnt FROM items
UNION ALL
SELECT 'reminders' AS tbl, COUNT(*) AS rows_cnt FROM reminders;


-- ② 看清单表内容：确认 plan_date / done / done_at 都存对了
--    期望：6 行；已完成 3 条的 done_at 有值，未完成 3 条是 NULL
SELECT id, title, plan_date, done, created_at, done_at
FROM items
ORDER BY plan_date, id;


-- ③ 看提醒表内容：确认 4 条挂了清单、2 条是独立提醒
--    期望：6 行；其中 item_id 为 NULL 的有 2 行
SELECT id, item_id, title, remind_at, lead_minutes, done
FROM reminders
ORDER BY remind_at;


-- ④ 关联验证：证明 reminders.item_id 真的指到了 items.id
--    期望：4 行（seed-rem-01 ~ 04），左边是清单标题、右边是挂在它下面的提醒
SELECT i.title AS item_title, r.title AS reminder_title, r.lead_minutes
FROM reminders r
JOIN items i ON r.item_id = i.id
ORDER BY r.id;


-- ⑤ 独立提醒：item_id 为 NULL 的那些
--    期望：2 行（高铁去上海、牙医预约）
SELECT id, title, remind_at
FROM reminders
WHERE item_id IS NULL
ORDER BY remind_at;
