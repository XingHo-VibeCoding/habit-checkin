# -*- coding: utf-8 -*-
"""
Day 16 验证：不依赖云端，用本地 SQLite 实跑 db/ 下的三个 SQL 文件。

【为什么用 SQLite 验】
    CloudBase 的 PostgreSQL 是 Henry 环境里已经有的数据库，我这边连不上云端。
    但 schema.sql / seed.sql 是刻意写成「两种方言都能吃」的子集，
    所以先用 SQLite 在本地把这几件事证一遍：
        schema.sql 重复执行不报错 / 建表能成 / 种子能灌 /
        每张表 >=5 行 / seed.sql 重复执行不报错且行数不变 /
        关联 JOIN 查得出 / 独立提醒存得进 / 删清单会级联删提醒 /
        外键真的在拦 / verify.sql 里的语句全都跑得通
    云端确认可用后，同样的文件在 PostgreSQL 里再跑一次即可。

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
VERIFY_PATH = os.path.join(HERE, 'verify.sql')

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
    verify_sql = read(VERIFY_PATH)

    conn = sqlite3.connect(':memory:')
    # SQLite 默认不开外键约束，必须显式打开 —— 否则级联和拦截两项都是假通过
    conn.execute('PRAGMA foreign_keys = ON')

    # ---- 1. 建表 -----------------------------------------------------------
    conn.executescript(schema_sql)
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    # Day 26：三张表（多了 anniversaries）
    check('建表：items / reminders / anniversaries 都存在',
          set(['items', 'reminders', 'anniversaries']).issubset(set(tables)), str(tables))

    # ---- 1b. 纪念日的列类型（Day 26）---------------------------------------
    # 为什么要单独查 information_schema：SQLite 建表成功**不代表类型对**。
    # 跨方言的真正风险是「SQLite 收下了但 PostgreSQL 拒收」——
    # 比如 BOOLEAN 在 SQLite 里合法，在 MySQL 里没有真 BOOLEAN。
    # 这里把关键列的类型打出来，肉眼核对是不是三家都认的类型。
    anniv_cols = conn.execute(
        "PRAGMA table_info(anniversaries)").fetchall()
    col_type = {r[1]: (r[2] or '').upper() for r in anniv_cols}
    check('anniversaries 列齐全（id/title/happen_on/yearly/created_at）',
          set(['id', 'title', 'happen_on', 'yearly', 'created_at']).issubset(set(col_type)),
          str(col_type))
    check('anniversaries.happen_on 是 CHAR(10)（定长，不是 DATETIME）',
          'CHAR' in col_type.get('happen_on', ''), col_type.get('happen_on', ''))
    check('anniversaries.yearly 是 SMALLINT（跨三家方言的代价）',
          'SMALLINT' in col_type.get('yearly', ''), col_type.get('yearly', ''))

    # ---- 2. schema.sql 重复执行不报错（DROP + CREATE 换来的能力） ----------
    # 注意：跑完这一步表是空的（DROP 掉了），所以下面必须重新灌种子
    try:
        conn.executescript(schema_sql)
        ok = True
        err = ''
    except Exception as e:          # noqa: BLE001 - 这里就是要兜住任何异常
        ok = False
        err = '%s: %s' % (type(e).__name__, e)
    check('schema.sql 重复执行不报错', ok, err)

    # ---- 3. 灌种子 ---------------------------------------------------------
    conn.executescript(seed_sql)
    n_items = conn.execute('SELECT COUNT(*) FROM items').fetchone()[0]
    n_rems = conn.execute('SELECT COUNT(*) FROM reminders').fetchone()[0]
    n_ann = conn.execute('SELECT COUNT(*) FROM anniversaries').fetchone()[0]
    check('items select >= 5 行', n_items >= 5, '实际 %d 行' % n_items)
    check('reminders select >= 5 行', n_rems >= 5, '实际 %d 行' % n_rems)
    check('anniversaries select >= 3 行', n_ann >= 3, '实际 %d 行' % n_ann)

    # ---- 3b. 两种 yearly 都有（Day 26）-------------------------------------
    n_yearly = conn.execute(
        'SELECT COUNT(*) FROM anniversaries WHERE yearly = 1').fetchone()[0]
    n_once = conn.execute(
        'SELECT COUNT(*) FROM anniversaries WHERE yearly = 0').fetchone()[0]
    check('每年重复与一次性两种都有', n_yearly >= 2 and n_once >= 1,
          'yearly=1 有 %d 条，yearly=0 有 %d 条' % (n_yearly, n_once))

    # ---- 3c. yearly 只能是 0/1（约束真的在拦，不是摆设）-------------------
    bad_yearly_blocked = False
    try:
        conn.execute(
            "INSERT INTO anniversaries (id, title, happen_on, yearly, created_at) "
            "VALUES ('bad-yearly', '不该存得下', '2026-01-01', 7, "
            "'2026-10-10T00:00:00.000Z')")
    except sqlite3.IntegrityError:
        bad_yearly_blocked = True
    check('yearly=7 会被 CHECK 约束拦下', bad_yearly_blocked)

    # ---- 3d. happen_on 格式（Day 26）---------------------------------------
    bad_date_blocked = False
    try:
        conn.execute(
            "INSERT INTO anniversaries (id, title, happen_on, yearly, created_at) "
            "VALUES ('bad-date', '格式不对', '2026/01/01', 0, "
            "'2026-10-10T00:00:00.000Z')")
    except sqlite3.IntegrityError:
        bad_date_blocked = True
    check("happen_on='2026/01/01' 会被 CHECK 拦下", bad_date_blocked)

    # ---- 3e. 每年重复的必须存得住年份（Day 26 关键设计）-------------------
    # 存完整 YYYY-MM-DD 而不是只存 MM-DD，就是为了前端能算出「第 N 个」。
    # 如果将来有人图省事改成只存 MM-DD，这条会跟着挂掉 —— 它是那个设计的守卫。
    row = conn.execute(
        "SELECT happen_on FROM anniversaries WHERE id = 'seed-anniv-02'").fetchone()
    check('每年重复的记录存的是完整日期（年份在，第 N 个才算得出来）',
          row is not None and len(row[0]) == 10 and row[0][4] == '-',
          'happen_on = %s' % (row[0] if row else '(读不到)'))

    # ---- 4. seed.sql 重复执行不报错 ---------------------------------------
    try:
        conn.executescript(seed_sql)
        ok = True
        err = ''
    except Exception as e:          # noqa: BLE001
        ok = False
        err = '%s: %s' % (type(e).__name__, e)
    n_items2 = conn.execute('SELECT COUNT(*) FROM items').fetchone()[0]
    n_rems2 = conn.execute('SELECT COUNT(*) FROM reminders').fetchone()[0]
    n_ann2 = conn.execute('SELECT COUNT(*) FROM anniversaries').fetchone()[0]
    check('seed.sql 重复执行不报错', ok, err)
    check('重复执行后行数不变（真幂等，不是「没报错但翻倍」）',
          n_items2 == n_items and n_rems2 == n_rems and n_ann2 == n_ann,
          'items %d->%d, reminders %d->%d, anniversaries %d->%d'
          % (n_items, n_items2, n_rems, n_rems2, n_ann, n_ann2))

    # ---- 5. 关联：JOIN 查得出挂着的提醒 -----------------------------------
    joined = conn.execute(
        'SELECT i.title, r.title FROM reminders r '
        'JOIN items i ON r.item_id = i.id ORDER BY r.id').fetchall()
    check('关联查询 reminders.item_id -> items.id 出结果',
          len(joined) == 4, '挂了 %d 条' % len(joined))
    for row in joined:
        print('        · %s  <-  %s' % (row[0], row[1]))

    # ---- 6. 独立提醒：item_id 为 NULL 也存得进 ----------------------------
    free = conn.execute(
        'SELECT COUNT(*) FROM reminders WHERE item_id IS NULL').fetchone()[0]
    check('独立提醒（item_id 为 NULL）存在', free == 2, '%d 条' % free)

    # ---- 7. 外键级联：删掉一条清单，挂它的提醒跟着删 ---------------------
    before = conn.execute('SELECT COUNT(*) FROM reminders').fetchone()[0]
    conn.execute("DELETE FROM items WHERE id = 'seed-item-02'")
    after = conn.execute('SELECT COUNT(*) FROM reminders').fetchone()[0]
    check('删清单 -> 挂它的提醒一起删（ON DELETE CASCADE）',
          after == before - 1, 'reminders %d -> %d' % (before, after))

    # ---- 8. 反向验证：外键真的在拦（不是摆设） ---------------------------
    blocked = False
    try:
        conn.execute(
            "INSERT INTO reminders (id, item_id, title, remind_at, lead_minutes, done) "
            "VALUES ('bad-ref', 'not-exist-item', '指向不存在的清单', "
            "'2026-10-05T00:00:00.000Z', 0, 0)")
    except sqlite3.IntegrityError:
        blocked = True
    check('指向不存在 id 的提醒会被外键拦下', blocked)

    # ---- 9. verify.sql 里的语句在控制台也得跑得通 -------------------------
    # 语法错在这儿就暴露，不用等 Henry 粘到控制台才发现
    try:
        conn.executescript(verify_sql)
        ok = True
        err = ''
    except Exception as e:          # noqa: BLE001
        ok = False
        err = '%s: %s' % (type(e).__name__, e)
    check('db/verify.sql 全部语句可执行（控制台粘过去不会报语法错）', ok, err)

    conn.close()

    total = len(results)
    bad = [r for r in results if not r[1]]
    print()
    print('%d/%d 通过' % (total - len(bad), total))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
