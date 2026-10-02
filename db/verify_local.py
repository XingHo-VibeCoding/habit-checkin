# -*- coding: utf-8 -*-
"""
Day 16 验证：不依赖云端，用本地 SQLite 实跑 db/schema.sql + db/seed.sql。

【为什么用 SQLite 验】
    CloudBase 的 MySQL 要 Henry 在控制台点开通（2~3 分钟），我这边连不上云端。
    但 schema.sql / seed.sql 是刻意写成「两种方言都能吃」的子集，
    所以先用 SQLite 在本地把这几件事证一遍：
        建表能成 / 种子能灌 / 重复执行不报错 / 每张表 >=5 行 /
        关联 JOIN 查得出 / 独立提醒存得进 / 删清单会级联删提醒
    云端开通后，同样的两个文件在 MySQL 里再跑一次即可。

【用法】
    python db/verify_local.py
    退出码 0 = 全通过，1 = 有失败。
"""
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(HERE, 'schema.sql')
SEED_PATH = os.path.join(HERE, 'seed.sql')

results = []


def check(name, cond, detail=''):
    results.append((name, bool(cond)))
    print(('PASS  ' if cond else 'FAIL  ') + name + (('   | ' + detail) if detail else ''))


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def main():
    schema_sql = read(SCHEMA_PATH)
    seed_sql = read(SEED_PATH)

    conn = sqlite3.connect(':memory:')
    # SQLite 默认不开外键约束，必须显式打开 —— 否则第 6 项级联测试是假通过
    conn.execute('PRAGMA foreign_keys = ON')

    # ---- 1. 建表 -----------------------------------------------------------
    conn.executescript(schema_sql)
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    check('建表：items / reminders 都存在',
          set(['items', 'reminders']).issubset(set(tables)), str(tables))

    # ---- 2. 灌种子 ---------------------------------------------------------
    conn.executescript(seed_sql)
    n_items = conn.execute('SELECT COUNT(*) FROM items').fetchone()[0]
    n_rems = conn.execute('SELECT COUNT(*) FROM reminders').fetchone()[0]
    check('items select >= 5 行', n_items >= 5, '实际 %d 行' % n_items)
    check('reminders select >= 5 行', n_rems >= 5, '实际 %d 行' % n_rems)

    # ---- 3. seed.sql 重复执行不报错 ---------------------------------------
    try:
        conn.executescript(seed_sql)
        ok = True
        err = ''
    except Exception as e:          # noqa: BLE001 - 这里就是要兜住任何异常
        ok = False
        err = '%s: %s' % (type(e).__name__, e)
    n_items2 = conn.execute('SELECT COUNT(*) FROM items').fetchone()[0]
    n_rems2 = conn.execute('SELECT COUNT(*) FROM reminders').fetchone()[0]
    check('seed.sql 重复执行不报错', ok, err)
    check('重复执行后行数不变（真幂等，不是「没报错但翻倍」）',
          n_items2 == n_items and n_rems2 == n_rems,
          'items %d->%d, reminders %d->%d' % (n_items, n_items2, n_rems, n_rems2))

    # ---- 4. 关联：JOIN 查得出挂着的提醒 -----------------------------------
    joined = conn.execute(
        'SELECT i.title, r.title FROM reminders r '
        'JOIN items i ON r.item_id = i.id ORDER BY r.id').fetchall()
    check('关联查询 reminders.item_id -> items.id 出结果',
          len(joined) == 4, '挂了 %d 条' % len(joined))
    for row in joined:
        print('        · %s  <-  %s' % (row[0], row[1]))

    # ---- 5. 独立提醒：item_id 为 NULL 也存得进 ----------------------------
    free = conn.execute(
        'SELECT COUNT(*) FROM reminders WHERE item_id IS NULL').fetchone()[0]
    check('独立提醒（item_id 为 NULL）存在', free == 2, '%d 条' % free)

    # ---- 6. 外键级联：删掉一条清单，挂它的提醒跟着删 ---------------------
    before = conn.execute('SELECT COUNT(*) FROM reminders').fetchone()[0]
    conn.execute("DELETE FROM items WHERE id = 'seed-item-02'")
    after = conn.execute('SELECT COUNT(*) FROM reminders').fetchone()[0]
    check('删清单 -> 挂它的提醒一起删（ON DELETE CASCADE）',
          after == before - 1, 'reminders %d -> %d' % (before, after))

    # ---- 7. 反向验证：外键真的在拦（不是摆设） ---------------------------
    blocked = False
    try:
        conn.execute(
            "INSERT INTO reminders (id, item_id, title, remind_at, lead_minutes, done) "
            "VALUES ('bad-ref', 'not-exist-item', '指向不存在的清单', "
            "'2026-10-05T00:00:00.000Z', 0, 0)")
    except sqlite3.IntegrityError:
        blocked = True
    check('指向不存在 id 的提醒会被外键拦下', blocked)

    conn.close()

    total = len(results)
    bad = [r for r in results if not r[1]]
    print()
    print('%d/%d 通过' % (total - len(bad), total))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
