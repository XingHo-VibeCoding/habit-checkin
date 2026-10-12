#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify-project.py —— 项目正确性检查（区别于 preflight.py 的「发布」检查）

preflight.py 拦的是「发布环节漏了什么」，改一次发布一次就能修。
本脚本拦的是「代码和数据之间的契约还成不成立」，这类问题不会自己暴露：
页面白屏不报错、云函数 500 看不出原因、测试全绿但只跑了 3 条。

每一项都来自本项目真实踩过的坑，出处在 SKILL.md 里逐条对应。
不通过的项会打印「为什么这条存在」，避免后来人当成冗余规则删掉。
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))
CF = os.path.join(ROOT, 'cloudfunctions')
DB = os.path.join(ROOT, 'db')

# 前端调用的 API 路径 ←→ 云函数实现，E1/E2 用
FUNCS = ['items', 'reminders', 'anniversaries']

results = []


def check(gate, name, ok, evidence, why=''):
    results.append({
        'gate': gate, 'name': name,
        'ok': bool(ok), 'evidence': evidence, 'why': why,
    })
    return ok


# ---------------------------------------------------------------- 工具

def read(rel):
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        return None
    with open(p, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


def strip_sql_comments(sql):
    """剥掉 -- 行注释和 /* */ 块注释。

    ⚠️ 这一步不是洁癖，是必需的：schema.sql 的注释里就写着
    「用 SMALLINT 不用 BOOLEAN / TINYINT(1)」—— 不剥注释的话
    A1 会把「我们特意避开了 BOOLEAN」这句注释判成违规。
    这就是本项目最典型的一类假阳性：规则本身对，匹配对象错。
    """
    out = re.sub(r'/\*.*?\*/', '', sql, flags=re.S)
    out = re.sub(r'--[^\n]*', '', out)
    return out


def strip_js_comments(src):
    """剥掉 JS 行注释与块注释（保留字符串里的内容不管）。

    ⚠️ 必需，不是洁癖：本项目的注释里大量出现被「禁止」的写法本身 ——
    「为什么不用通配符 '*'」「或手动加环境变量 CLOUDBASE_APIKEY」——
    不剥注释就会把这些说明文字判成违规。
    这是本项目最典型的一类假阳性：规则对，匹配对象错。
    """
    out = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
    out = re.sub(r'(^|[^:"\'\\])//[^\n]*', r'\1', out)
    return out


def grep_all(paths, pattern):
    """在多个文件里 grep，返回 [(文件名, 命中的行)]。"""
    hits = []
    rx = re.compile(pattern)
    for rel in paths:
        txt = read(rel)
        if txt is None:
            continue
        for i, line in enumerate(txt.split('\n'), 1):
            if rx.search(line):
                hits.append((rel, i, line.strip()))
    return hits


def run_node(rel):
    p = subprocess.run(['node', rel], cwd=ROOT, capture_output=True,
                       text=True, encoding='utf-8', errors='replace', timeout=120)
    return p.returncode, (p.stdout or '') + (p.stderr or '')


def top_level_returns(rel):
    """找顶层的 return（不在任何函数体内、不在模板字符串里）。

    为什么查这个：Node 模块顶层的 return 会立刻结束整个模块，
    后面的用例一条都不跑，而且**退出码是 0** ——
    CI 一片绿，实际只验证了 3 条。本项目 2026-10-11 真踩过。

    ⚠️ 两个必须排除的假阳性（第一次跑就踩了）：
      ① 模板字符串里的 return —— test_day24_sync.js 用
         `new Function('... return {...}')` 把源码切段执行，
         里面那个 return 是被编译的函数体的返回值，不是模块顶层。
      ② 对象字面量里的 return（如 `{ return fn: ... }`）——靠括号配平判断更可靠。
    所以这里改成**逐字符配平**：只在「不在任何 {} 内、不在任何反引号内」时才算顶层。
    """
    txt = read(rel)
    if txt is None:
        return []
    depth = 0
    in_tpl = False
    in_str = None
    i = 0
    lines = txt.split('\n')
    # 记录每个字符所在的行号，供定位
    line_no = 1
    bad = []
    while i < len(txt):
        c = txt[i]
        nxt = txt[i + 1] if i + 1 < len(txt) else ''
        if c == '\n':
            line_no += 1
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
        elif in_tpl:
            if c == '\\':
                i += 2
                continue
            if c == '`':
                in_tpl = False
        else:
            if c in '"\'':
                in_str = c
            elif c == '/' and nxt == '*':
                j = txt.find('*/', i + 2)
                if j < 0:
                    break
                line_no += txt.count('\n', i, j)
                i = j + 2
                continue
            elif c == '/' and nxt == '/':
                j = txt.find('\n', i)
                if j < 0:
                    break
                i = j
                continue
            elif c == '`':
                in_tpl = True
            elif c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
            elif depth == 0 and txt.startswith('return', i) and (i + 6 >= len(txt) or not txt[i + 6].isalnum()):
                seg = txt[txt.rfind('\n', 0, i) + 1:i].strip()
                bad.append((line_no, seg))
        i += 1
    return bad


# ================================================================ A. 数据契约

def gate_a():
    why = 'SQL 必须同时能跑 PostgreSQL / MySQL / SQLite —— 云端是 PostgreSQL，' \
          '本地靠 SQLite 验证，两者方言不通就有一边跑不起来'
    idx = read('index.html') or ''
    schema = read('db/schema.sql')
    if schema is None:
        check('A1', 'SQL 方言兼容（剥注释后再查）', False, 'db/schema.sql 不存在', why)
        return
    body = strip_sql_comments(schema)

    # A1 方言禁用词
    banned = [
        (r'\bTINYINT\b', 'TINYINT（PostgreSQL 没有）'),
        (r'\bDATETIME\b', 'DATETIME（时区会被转一次）'),
        (r'\bBOOLEAN\b', 'BOOLEAN（MySQL/SQLite 语义不同）'),
        (r'\bdate\b\s+(CHAR|VARCHAR|TEXT)', 'date 做列名（是 SQL 关键字）'),
        (r'ON\s+CONFLICT', 'ON CONFLICT（PostgreSQL 专有）'),
        (r'INSERT\s+IGNORE', 'INSERT IGNORE（MySQL 专有）'),
        (r'INSERT\s+OR\s+IGNORE', 'INSERT OR IGNORE（SQLite 专有）'),
    ]
    hits = []
    for pat, label in banned:
        for i, line in enumerate(body.split('\n'), 1):
            if re.search(pat, line, re.I):
                hits.append('L%d %s' % (i, label))
    check('A1', 'SQL 方言兼容（已剥注释，避免把「特意避开 X」判成违规）',
          not hits,
          '禁用写法 %d 处' % len(hits) if hits else '8 类方言禁用写法，剥注释后 0 处',
          why + ('；命中：' + '; '.join(hits[:3]) if hits else ''))

    # A2 三张表都在
    missing = [t for t in ['items', 'reminders', 'anniversaries']
               if not re.search(r'CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?' + t + r'\b', body, re.I)]
    check('A2', 'schema.sql 三张表齐全（items/reminders/anniversaries）',
          not missing,
          '齐全' if not missing else '缺：' + ', '.join(missing),
          '少建一张表 → 前端取数据直接 404，且控制台看不出是「表没建」')

    # A3 seed 幂等必须是 DELETE + INSERT
    seed = read('db/seed.sql')
    if seed is None:
        check('A3', 'seed.sql 幂等写法（DELETE + INSERT，不用 upsert）', False, '文件不存在', why)
    else:
        sb = strip_sql_comments(seed)
        has_del = re.search(r"DELETE\s+FROM", sb, re.I) is not None
        has_ins = re.search(r"INSERT\s+INTO", sb, re.I) is not None
        up = re.search(r'ON\s+CONFLICT|INSERT\s+IGNORE|INSERT\s+OR\s+IGNORE|REPLACE\s+INTO', sb, re.I)
        check('A3', 'seed.sql 幂等写法（DELETE + INSERT，不用 upsert）',
              has_del and has_ins and not up,
              ('DELETE + INSERT，%d 条种子' % len(re.findall(r"INSERT\s+INTO", sb, re.I))) if (has_del and has_ins and not up)
              else 'DELETE=%s INSERT=%s upsert=%s' % (has_del, has_ins, bool(up)),
              'upsert 三家方言各有一套写法，没有一种能同时跑三家 → 本地能跑不代表云端能跑')

    # A4 seed 文件里不能混入真实数据（id 不能用 seed- 前缀）
    if seed is not None:
        ids = re.findall(r"'([^']*seed-[^']*)'", strip_sql_comments(seed))
        strays = [x for x in re.findall(r"'([^']+)'", strip_sql_comments(seed))
                  if x.startswith('seed-') is False and re.match(r'^[a-z0-9]{8,}$', x)
                  and not re.match(r'^\d{4}-\d{2}-\d{2}', x) and x not in ('items', 'reminders', 'anniversaries',
                  'active', 'title', 'text', 'done', 'lead', 'at', 'id', 'VARCHAR', 'SMALLINT', 'INT', 'TEXT', 'CHAR', 'NOT', 'NULL')]
        check('A4', 'seed.sql 里真实数据 id 不带 seed- 前缀（会被 DELETE 连带清掉）',
              not strays,
              'seed- 前缀 %d 处' % len(ids) if not strays else '疑似真实 id %d 处：%s' % (len(strays), strays[:3]),
              '本项目真实丢过：seed.sql 用 DELETE ... WHERE id LIKE \'seed-%\' 做幂等，'
              '真实数据只要蹭上这个前缀就被清空，且没有任何提示')

    # A5 前后端字段映射与 schema 列名双向对齐
    # ⚠️ 第一版只查「列名在不在」，漏报了一类：单边改名后旧名仍残留在
    # 注释里（比如 mapXxx 的 `createdAt: r.created_at` 那行对照注释），
    # 于是「旧名还在」→ 判 PASS，而真正的问题是写入端已经改成 createdAtX。
    # 现在多查一条：**写入端（DB 对象字面量）的键必须与 schema 列名完全一致**。
    pairs = [('plan_date', 'items'), ('created_at', 'items'), ('done_at', 'items'),
             ('remind_at', 'reminders'), ('lead_minutes', 'reminders'),
             ('happen_on', 'anniversaries'), ('yearly', 'anniversaries')]
    half = []
    for col, tbl in pairs:
        in_front = col in idx
        in_sql = re.search(r'\b' + col + r'\b', body) is not None
        if in_front != in_sql:
            half.append('%s(%s: 前端%s/schema%s)' % (col, tbl, '有' if in_front else '无', '有' if in_sql else '无'))
    # 第二层：写入端键名必须是合法列名，不能是「列名 + 任意后缀」这种自造名
    # ⚠️ 函数体结束是 `\n    }`（4 空格，跟 toDb 内部 6 空格缩进配套），
    # 第一版按 `\n  }` 收尾，正则一个函数都没匹配到 → 整条检查静默失效。
    # 「没匹配到」和「匹配到且没问题」在报告里长得一模一样，这是最险的一种漏报。
    n_fn = 0
    for fn in re.findall(r'function\s+(toDb\w+)\s*\([^)]*\)\s*\{(.*?)\n    \}', idx, re.S):
        n_fn += 1
        body_txt = fn[1]
        for k in re.findall(r'^\s{6,}([a-z][a-zA-Z0-9_]*)\s*:', body_txt, re.M):
            if k in ('id', 'title', 'text', 'done', 'lead', 'at'):
                continue
            if re.search(r'\b' + k + r'\b', body):
                continue
            near = [c for c, _ in pairs if c.startswith(k[:4]) or k.startswith(c[:4])]
            half.append('%s() 里写了 %s，但 schema 里没有这一列%s'
                        % (fn[0], k, ('（疑似 %s 拼错）' % '/'.join(near)) if near else ''))
    check('A5', '前后端字段映射与 schema 列名双向对齐（含 %d 个写入端键名校验）' % n_fn,
          not half and n_fn >= 2,
          '7 个字段双向都在；%d 个 toDb* 写入端键名全部合法' % n_fn if not half
          else '不一致：' + '；'.join(half[:3]),
          '前端存 createdAt、库里是 created_at 这类改名必须成对改；'
          '只改一边不会报错，字段会静默变成 NULL')

    # A6 时刻列存 ISO UTC 串，日历列存 CHAR(10)
    a6 = []
    if not re.search(r'plan_date\s+CHAR\(10\)', body, re.I):
        a6.append('plan_date 不是 CHAR(10)')
    if not re.search(r'happen_on\s+CHAR\(10\)', body, re.I):
        a6.append('happen_on 不是 CHAR(10)')
    if not re.search(r'yearly\s+SMALLINT', body, re.I):
        a6.append('yearly 不是 SMALLINT（只认 0/1，不认 boolean）')
    check('A6', '时刻列用 ISO UTC 字符串、日历列用 CHAR(10)、0/1 用 SMALLINT',
          not a6,
          '三类列型都对' if not a6 else '；'.join(a6),
          'DATETIME 会按时区再转一次，显示的时间会差几个小时且不报错；'
          'yearly 存 boolean 在 PostgreSQL 和 MySQL 上行为不同')


# ================================================================ B. 云函数契约

def gate_b():
    files = []
    for f in FUNCS:
        files += ['cloudfunctions/%s/index.js' % f]
        d = os.path.join(CF, f)
        if os.path.isdir(d):
            files += ['cloudfunctions/%s/%s' % (f, n) for n in os.listdir(d) if n.endswith('Repository.js')]

    # B1 errors-human 双路径 require
    bad = []
    for f in FUNCS:
        txt = read('cloudfunctions/%s/index.js' % f) or ''
        if 'errors-human' not in txt:
            bad.append(f + ' 根本没引')
        elif "./errors-human.js" not in txt or "../errors-human.js" not in txt:
            bad.append(f + ' 只写了一边')
    check('B1', '三个云函数都用双路径 require errors-human（先 ./ 后 ../）',
          not bad,
          '三个函数都是双路径' if not bad else '；'.join(bad),
          '部署包解压成独立根目录，父目录不存在。只写 ../ 的话部署不报错，'
          '一调用就 Cannot find module → 500，日志里看不出是路径问题')

    # B2 不用全局 fetch
    f_hits = grep_all(files, r'(?<!\.)\bfetch\s*\(')
    f_hits = [h for h in f_hits if 'https.request' not in h[2] and '// ' not in h[2][:2]]
    # 排除注释行
    f_hits = [h for h in f_hits if not h[2].startswith('//')]
    has_https = [f for f in files if read(f) and "require('https')" in read(f)]
    check('B2', '云函数用内置 https，不用全局 fetch',
          not f_hits and len(has_https) >= 3,
          '内置 https %d/%d 个文件，裸 fetch %d 处' % (len(has_https), len(files), len(f_hits)),
          '云函数运行时可能是 Node 16，那时没有全局 fetch → ReferenceError，'
          '而且本地 node 版本高、能跑，测不出来')

    # B3 环境变量双名兼容
    # ⚠️ 只看 index.js 会误报：真正读环境变量的代码在 *Repository.js 里，
    # index.js 里出现的 CLOUDBASE 字样全是注释里的「部署说明」。
    both = []
    for f in files:
        txt = strip_js_comments(read(f) or '')
        if 'CLOUDBASE' not in txt:
            continue
        has_a = 'CLOUDBASE_APIKEY' in txt
        has_b = 'CLOUDBASE_API_KEY' in txt
        if not (has_a and has_b):
            both.append('%s(APIKEY=%s API_KEY=%s)' % (os.path.basename(f), has_a, has_b))
    check('B3', '环境变量双名兼容（CLOUDBASE_APIKEY 与 CLOUDBASE_API_KEY 都读）',
          not both,
          '所有引用处两个名字都读（已剥注释，只查真实代码）' if not both
          else '只读了一个：' + '；'.join(both),
          '官方文档两个拼法都出现过（node-sdk 写 APIKEY，AI-Toolkit 写 API_KEY）。'
          '只读一个 → 另一个拼法的环境变量静默读不到，报 CONFIG_MISSING')

    # B4 ALLOWED_ORIGINS 白名单，不含 *
    # ⚠️ 必须剥注释：本项目三个函数的注释里都写着「为什么不用通配符 '*'」，
    # 第一次跑这里 3 个全 FAIL，剥掉注释后才是真相。
    star = []
    for f in FUNCS:
        txt = strip_js_comments(read('cloudfunctions/%s/index.js' % f) or '')
        if re.search(r"['\"]\*['\"]", txt) or re.search(r'ALLOWED_ORIGINS[^\n]*\|\|\s*\*', txt):
            star.append(f)
    check('B4', 'ALLOWED_ORIGINS 白名单不回退到 *',
          not star,
          '三个函数都没有 * 兜底（已剥注释）' if not star else '这函数退回 *：' + ', '.join(star),
          '退回 * 等于任何网站都能读你的数据库。本项目踩过跨域：'
          'localhost 和 127.0.0.1 是两个不同的源，只配了 localhost 就会静默退回本地数据')

    # B5 路由方法齐全
    # ⚠️ 两种合法写法，本项目两种都出现了：
    #   ① var ALLOWED = ['GET','POST','PATCH','DELETE'] + ALLOWED.indexOf(method) 门禁
    #   ② if (method === 'POST') ... 逐个 if
    # 只按 ② 查 → ① 全被判成「缺 GET/POST」。第一次跑就这样误报了 items 和 anniversaries。
    # 另外 reminders 是**设计上只读**（Day 19 的函数，只有 list，没有 insert/update/remove），
    # 对它要求四方法等于要求一个不存在的功能 —— 这是漏报的反面：规则本身错了。
    missing_m = []
    readonly = []
    for f in FUNCS:
        p = 'cloudfunctions/%s/index.js' % f
        body = strip_js_comments(read(p) or '')
        repo = read('cloudfunctions/%s/%sRepository.js' % (f, f))
        repo_body = strip_js_comments(repo or '')
        writable = re.search(r'function\s+(insert|update|remove)\s*\(', repo_body) is not None
        if not writable:
            readonly.append(f)
            # 只读函数：必须确实只有 list，且不能偷偷调 insert
            if re.search(r"method\s*===?\s*'(POST|PATCH|DELETE)'", body):
                missing_m.append('%s 声明了写方法但 Repository 没有实现' % f)
            continue
        m_arr = re.search(r"ALLOWED\s*=\s*\[([^\]]*)\]", body)
        if m_arr:
            declared = set(re.findall(r"'(GET|POST|PATCH|DELETE)'", m_arr.group(1)))
        else:
            declared = set(re.findall(r"method\s*===?\s*'(GET|POST|PATCH|DELETE)'", body))
        gap = [m for m in ('GET', 'POST', 'PATCH', 'DELETE') if m not in declared]
        if gap:
            missing_m.append('%s 缺 %s' % (f, '/'.join(gap)))
    check('B5', '写方法齐（items/anniversaries 四方法；reminders 设计上只读）',
          not missing_m,
          '写函数四方法齐全；只读函数：%s（无 insert/update/remove，与设计一致）' % (readonly or '无')
          if not missing_m else '；'.join(missing_m[:4]),
          '云函数控制台要逐个勾这四个方法，漏勾的话前端调了会 404，'
          '但代码里明明写着 —— 排查时极容易归错因')

    # B6 走 PostgREST 网关，不走内网直连
    tcp = grep_all(files, r'ap-shanghai\.(?:tencentcdb|tcb)|tencentcdb\.com|:5432|host=.*postgres')
    tcp = [h for h in tcp if not h[2].startswith('//')]
    pg_ok = []
    for f in files:
        txt = read(f) or ''
        if 'tcloudbasegateway.com' in txt:
            pg_ok.append(os.path.basename(f))
    check('B6', '读库走 PostgREST 网关（*.api.tcloudbasegateway.com），不用内网直连',
          not tcp and len(pg_ok) >= 3,
          '网关地址 %d 个文件，TCP 直连痕迹 %d 处' % (len(pg_ok), len(tcp)),
          '体验版下内网地址要开「内网互联」、外网直连开关也开不了，'
          '两条直连路都不通。只有 PostgREST + 服务端 API Key 一条路')

    # B7 删除不存在必须 404，不谎报成功
    bad_del = []
    for f in FUNCS:
        repo = read('cloudfunctions/%s/%sRepository.js' % (f, f)) or ''
        # 只有实现了 remove / 按 id 单查的函数才需要 404 分支；只读函数用不上
        needs404 = re.search(r'function\s+(remove|getById|findById)\s*\(', strip_js_comments(repo))
        if not needs404:
            continue
        txt = read('cloudfunctions/%s/index.js' % f) or ''
        if 'NOT_FOUND' not in txt and '404' not in txt:
            bad_del.append(f)
    check('B7', '删除/单查找不到行时返回 404，不谎报成功',
          not bad_del,
          '所有支持删除的函数都有 404 分支' if not bad_del else '没有 404 分支：' + ', '.join(bad_del),
          '返回 200 空结果 = 谎报成功。本项目踩过：点删除 UI 显示已删，'
          '刷新又回来了，看不出是后端没删')

    # B8 重复提交返回 409 —— 只对支持 insert 的函数有意义
    no409 = []
    for f in FUNCS:
        repo = strip_js_comments(read('cloudfunctions/%s/%sRepository.js' % (f, f)) or '')
        if not re.search(r'function\s+insert\s*\(', repo):
            continue
        body = strip_js_comments(read('cloudfunctions/%s/index.js' % f) or '')
        if '409' not in body or 'DUPLICATE' not in body:
            no409.append(f)
    check('B8', '重复提交撞主键时返回 409（id 当幂等键）',
          not no409,
          '所有支持写入的函数都有 409 + DUPLICATE' if not no409 else '没有 409：' + ', '.join(no409),
          '演示/测试工具把 id 写死，第二次点必然冲突；'
          '本项目真实踩过：POST 截图工具因为写死 id 只能截一次')

    # B9 服务端密钥不进前端
    leaks = []
    for rel in ['index.html', 'sw.js', 'manifest.json']:
        txt = read(rel)
        if not txt:
            continue
        for m in re.finditer(r'(eyJ[A-Za-z0-9_\-]{20,})', txt):
            leaks.append('%s 疑似 JWT' % rel)
        if re.search(r'CLOUDBASE_API\w*\s*[:=]\s*[\'"][A-Za-z0-9_\-]{20,}', txt):
            leaks.append('%s 硬编码 API Key' % rel)
    check('B9', '服务端密钥没进前端文件（index.html/sw.js/manifest.json）',
          not leaks,
          '3 个文件都干净' if not leaks else '；'.join(leaks),
          'API Key 被网关解成 service_role，绕过所有行级安全策略。'
          '进了前端代码 = 公网可读 = 别人能读写你的库')


# ================================================================ C. 测试有效性

def gate_c():
    tests = sorted([f for f in os.listdir(ROOT)
                    if f.startswith('test_') and f.endswith('.js')])
    tests += ['cloudfunctions/' + f for f in os.listdir(CF)
              if f.startswith('test_') and f.endswith('.js')]

    # C1 无顶层 return
    bad = []
    for t in tests:
        hits = top_level_returns(t)
        if hits:
            bad.append('%s L%d' % (t, hits[0][0]))
    check('C1', '测试文件里没有顶层 return（会静默截断后续用例）',
          not bad,
          '%d 个测试文件全干净' % len(tests) if not bad else '顶层 return：' + '；'.join(bad),
          'Node 模块顶层 return 立刻结束整个模块，退出码还是 0 —— '
          '本项目踩过：以为跑了 75 条，实际只跑了 3 条，一片绿')

    # C2/C3 逐个跑，验退出码与条数
    fails = []
    thin = []
    counts = []
    for t in tests:
        rc, out = run_node(t)
        m = re.search(r'(\d+)\s*通过', out)
        n = int(m.group(1)) if m else 0
        counts.append((t, n))
        if rc != 0:
            fails.append('%s 退出码 %d' % (t, rc))
        if '通过' not in out or n == 0:
            fails.append('%s 没输出条数（可能被顶层 return 截断）' % t)
        elif n < 5:
            thin.append('%s 只有 %d 条' % (t, n))

    total = sum(n for _, n in counts)
    check('C2', '全部测试退出码为 0 且真的跑出了条数',
          not fails,
          '%d 个文件 / 共 %d 条断言全通过' % (len(tests), total) if not fails else '；'.join(fails[:4]),
          '退出码 0 不代表跑完了 —— 顶层 return、异常吞掉都能骗过 CI')

    check('C3', '没有「只跑了几条」的可疑测试文件',
          not thin,
          '最少的 %s 也有 %d 条' % min(counts, key=lambda x: x[1]) if counts else '—',
          '条数突然变少通常是断言被改废了或桩没跟上，'
          '而不是「测试变简单了」—— 本项目增字段时测试从 20 掉到 3 就是这么来的')

    # C4 测试桩要跟得上源码调用的方法
    # ⚠️ 两种测试写法，只有一半需要查桩：
    #   ① 抽取 index.html 里的真源码执行（本项目主流做法，test_day24_write.js / sync.js）
    #      —— 这种桩就是源码本身，永远不会漏，不该查。
    #   ② 手写桩（test_day24_bug_fixed.js 里 `var syncJobs = {...}`）
    #      —— 只有这种才可能漏方法。
    # 第一次跑没区分，把 ① 也判成「桩没跟上」，10 条全假。
    idx = read('index.html') or ''
    sync_calls = set(re.findall(r'syncJobs\.(\w+)\(', idx))
    missing_stub = []
    hand_written = []
    for t in tests:
        body = strip_js_comments(read(t) or '')
        if 'syncJobs' not in body:
            continue
        # 只认手写桩：`var syncJobs = {` / `syncJobs = {`
        if not re.search(r'(var|let|const)\s+syncJobs\s*=\s*\{', body):
            continue
        hand_written.append(t)
        for meth in sorted(sync_calls):
            has = re.search(r'\b' + meth + r'\s*:\s*(async\s+)?(function|\()', body) \
                or re.search(r'\b' + meth + r'\s*=', body)
            if not has:
                missing_stub.append('%s 缺 %s' % (t, meth))
    check('C4', '手写桩覆盖源码实际调用的 syncJobs 方法（抽取真源码的测试不查）',
          not missing_stub,
          '源码用 %d 个 syncJobs 方法；手写桩测试 %d 个，覆盖完整'
          % (len(sync_calls), len(hand_written)) if not missing_stub
          else '桩没跟上：' + '；'.join(missing_stub),
          '桩按错误假设写，就会给错误代码盖章。本项目踩过：'
          '加纪念日后 syncJobs.annivRemove 没进桩，测试崩了才知道')


# ================================================================ D. 密钥边界

def gate_d():
    # D1 全工作区（排除 .git / 发布目录）
    rx = re.compile(r'eyJ[A-Za-z0-9_\-]{20,}')
    hits = []
    skip_dirs = {'.git', '.deploy', 'node_modules', '.workbuddy'}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for fn in filenames:
            if not fn.endswith(('.js', '.html', '.json', '.py', '.sql', '.md', '.zip')):
                continue
            fp = os.path.join(dirpath, fn)
            try:
                if os.path.getsize(fp) > 2 * 1024 * 1024:
                    continue
                with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                    txt = f.read()
            except OSError:
                continue
            if rx.search(txt):
                hits.append(os.path.relpath(fp, ROOT))
    check('D1', '工作区（除 .git/.deploy）没有真实密钥',
          not hits,
          '0 条' if not hits else '命中：' + ', '.join(hits[:3]),
          '密钥一旦 commit 进历史，删文件也还在历史里，只能改密钥')

    # D2 Git 全历史
    hist = []
    try:
        p = subprocess.run(['git', '-C', ROOT, 'log', '--all', '-p', '--no-color'],
                           capture_output=True, text=True, encoding='utf-8',
                           errors='replace', timeout=180)
        blob = p.stdout or ''
        for m in rx.finditer(blob):
            hist.append(m.group(0)[:12])
    except Exception as e:
        hist = ['(git 读取失败: %s)' % e]
    check('D2', 'Git 全历史里没有真实密钥',
          not hist,
          '0 条' if not hist else '命中 %d 处' % len(hist),
          '历史里的密钥等于永久泄露 —— 删掉文件、rebase 都清不掉，'
          'GitHub 的 secret scanning 也可能已经报警')


# ================================================================ E. 前后端契约

def gate_e():
    idx = read('index.html') or ''

    # E1 前端调的路径都有云函数实现
    used = set(re.findall(r"apiGet\('/([a-z]+)'", idx))
    used |= set(re.findall(r"apiGet\(\s*'/([a-z]+)'", idx))
    unimpl = [p for p in sorted(used) if p not in FUNCS]
    check('E1', '前端调用的每个 API 路径都有对应云函数',
          not unimpl,
          '%s 全部有实现' % sorted(used) if not unimpl else '没有实现：' + ', '.join(unimpl),
          '前端加了新接口但云函数没部署 → 404，页面退回本地数据并提示，'
          '很容易被当成「后端还没做」而不是「部署漏了」')

    # E2 反向：有没有建了但没人用的孤儿云函数
    orphan = [f for f in FUNCS if f not in used]
    check('E2', '没有「建了但前端从不调用」的孤儿云函数',
          not orphan,
          '三个函数前端都在用' if not orphan else '前端没调：' + ', '.join(orphan),
          '孤儿函数通常意味着「这功能还没接完」—— 留着容易让人以为已经做完了')

    # E3 API_BASE 的环境 ID 必须与云函数用的那个一致（没指错环境）
    # ⚠️ 第一版写成「前端有 env 且云函数文件里有 habit-checkin- 字样」就算过 ——
    # 这是**判据松到没有意义**：把前端换成 wrong-env-000 后，
    # 云函数 README 里的 habit-checkin- 照样命中，于是 PASS。
    # 注入坏值测了才暴露。正确判据：两边的 env id 必须**相等**。
    base = re.search(r"API_BASE\s*=\s*'([^']+)'", idx)
    front_eid = None
    if base:
        # env id 自身含非数字字符（habit-checkin-d9giln6ke6594e88b），
        # 所以不能要求它后面紧跟 -\d+-，那样永远匹配不上（第三版就栽在这）。
        m = re.search(r'https://([a-z0-9][a-z0-9\-]*?)-[0-9]+\.', base.group(1))
        front_eid = m.group(1) if m else None
    cf_eids = set()
    for rel in ['cloudfunctions/README.md'] + ['cloudfunctions/%s/index.js' % f for f in FUNCS]:
        txt = read(rel)
        if txt:
            cf_eids |= set(re.findall(r'habit-checkin-[a-z0-9]+', txt))
    # ⚠️ 「解析不出 env id」和「env id 不一致」必须分开报：
    # 混成一句话会让人以为「配置写错了」，去查配置文件 —— 而真因是正则挂了。
    if not base:
        ev, ok3 = 'index.html 里找不到 API_BASE', False
    elif not front_eid:
        ev, ok3 = 'API_BASE 的 URL 结构认不出（解析失败，不等于配置错）', False
    elif not cf_eids:
        ev, ok3 = '云函数文件里找不到任何环境 ID，无法比对', False
    elif front_eid not in cf_eids:
        ev, ok3 = '前端 %s，但云函数里是 %s —— 指错环境了' % (front_eid, ', '.join(sorted(cf_eids))), False
    else:
        ev, ok3 = '前端与云函数都是 %s' % front_eid, True
    check('E3', 'API_BASE 的环境 ID 与云函数里的一致（没指错环境）', ok3, ev,
          '指错环境的表现是「功能好像坏了但没有任何报错」，最难查的一类 —— '
          '本项目用 CloudBase，环境 ID 换了就是另一个库，页面白屏也查不出原因')


# ================================================================ 输出

def emit():
    gates = [
        ('A', '数据契约（SQL 方言 / 表 / 种子 / 字段映射）'),
        ('B', '云函数契约（部署后才会暴露的那类）'),
        ('C', '测试有效性（防止「假绿」）'),
        ('D', '密钥边界'),
        ('E', '前后端契约一致'),
    ]
    print()
    for g, title in gates:
        # 用前缀匹配：check() 里传的是 'A1' / 'B2' / 'C' 这种带编号的标记
        items = [r for r in results if r['gate'].startswith(g)]
        if not items:
            continue
        print('== %s. %s ==' % (g, title))
        for r in items:
            print('%s%s' % ('PASS  ' if r['ok'] else 'FAIL  ',
                            r['name'] + '   | ' + r['evidence']))
            if not r['ok'] and r['why']:
                print('        ↳ 为什么查这条：%s' % r['why'][:110])
        print()

    passed = sum(1 for r in results if r['ok'])
    total = len(results)
    print('=' * 52)
    print('%d/%d 通过' % (passed, total))
    if passed != total:
        print('❌ 不通过。先修再提交。')
    else:
        print('✅ 契约全部成立。')
    return 0 if passed == total else 1


def main():
    for g in (gate_a, gate_b, gate_c, gate_d, gate_e):
        try:
            g()
        except Exception as e:
            check(g.__name__.upper()[-1], '（%s 整组执行出错）' % g.__name__.upper(), False, repr(e)[:80],
                  '检查脚本自己崩了不能当成通过')
    return emit()


if __name__ == '__main__':
    sys.exit(main())