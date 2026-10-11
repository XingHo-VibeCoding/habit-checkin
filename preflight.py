# -*- coding: utf-8 -*-
"""发布前检查（preflight）· habit-checkin

在**发布之前**跑这一份，把「发布完才发现坏了」变成「发布前就拦住」。

为什么要有这个脚本
    发布是覆盖式的 —— 线上链接会被换掉，而那链接可能已经分享给别人。
    这个项目的发布尤其危险，因为它是「手动拷文件」：
    2026-09-24 就漏拷过 assets 里的 png（看板娘是透明立绘，jpg 存不了 alpha），
    线上直接裂图，而且**没有任何报错**，只是图不见了。

三类检查，分工明确
    A 类「本地就能查」：语法、id 空引用、资源引用完整性、大小写
    B 类「发布目录一致性」：该拷的都拷了吗、拷对了吗
    C 类「线上查」：要 --online 才跑，发布后验

用法
    python preflight.py              # A + B（发布前跑这个）
    python preflight.py --online URL # A + B + C（发布后跑这个，URL 传线上地址）
    python preflight.py --no-node    # 跳过需要 node 的语法检查

退出码
    0 = 全通过；1 = 有失败项（**发布前必须先修完**）
"""
from __future__ import print_function

import io
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(ROOT, 'index.html')
DEPLOY = os.path.join(ROOT, '.deploy')
SW = os.path.join(ROOT, 'sw.js')

NODE_REL = r'.workbuddy\binaries\node\versions\22.22.2-5\node.exe'

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS  ' if ok else 'FAIL  ') + name + (('   | ' + detail) if detail else ''))


def read(path):
    f = io.open(path, encoding='utf-8')
    try:
        return f.read()
    finally:
        f.close()


def node_path():
    """找 managed node。找不到就返回 None（那一项改成「跳过」而不是「失败」。"""
    p = os.path.join(os.environ.get('USERPROFILE', ''), NODE_REL)
    return p if os.path.isfile(p) else None


# ══════════════════════════════════════════════════════════
#  A1. JS 语法
# ══════════════════════════════════════════════════════════
def a1_js_syntax(use_node):
    """抽出 <script> 内容交给 node --check。

    为什么非要专门做这一步：index.html 是单文件 3000+ 行的内联 JS。
    一个多余的花括号不会让浏览器报任何语法错误的位置，
    页面只是某块功能静默不响应 —— 「点了没反应」是本地最难查的一类。
    """
    if not use_node:
        check('A1 JS 语法（node 不可用，已跳过）', True, '装个 node 或去掉 --no-node')
        return

    node = node_path()
    if not node:
        check('A1 JS 语法 —— 找不到 node', True, '跳过（预期路径 %s）' % NODE_REL)
        return

    html = read(INDEX)
    blocks = re.findall(r'<script[^>]*>(.*?)</script>', html, re.S)
    if not blocks:
        check('A1 JS 语法', False, 'index.html 里没抽到 <script> 内容')
        return

    tmp = os.path.join(os.environ.get('USERPROFILE', '.'), '.workbuddy', 'tmp', '_preflight.js')
    d = os.path.dirname(tmp)
    if not os.path.isdir(d):
        os.makedirs(d)
    f = io.open(tmp, 'w', encoding='utf-8')
    f.write('\n'.join(blocks))
    f.close()

    p = subprocess.Popen([node, '--check', tmp], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = p.communicate()[0].decode('utf-8', 'replace').strip()
    check('A1 JS 语法（%d 个 script 块）' % len(blocks), p.returncode == 0,
          out[:300] if out else '')

    # 顺带把 sw.js 也查一遍 —— 它是独立文件，漏查过一次（2026-10-10 线上 404）
    if os.path.isfile(SW):
        p2 = subprocess.Popen([node, '--check', SW], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        out2 = p2.communicate()[0].decode('utf-8', 'replace').strip()
        check('A1b sw.js 语法', p2.returncode == 0, out2[:300] if out2 else '')


# ══════════════════════════════════════════════════════════
#  A2. id 空引用
# ══════════════════════════════════════════════════════════
def a2_id_refs():
    """脚本里 getElementById('x') 用到的 id，HTML 里有没有。

    为什么这是最高频的静默失败：getElementById 返回 null 之后，
    紧跟着的 .addEventListener 直接抛 TypeError，
    **而如果那个事件绑定在页面初始化里，后面的初始化代码就全不执行了** ——
    表现为「页面上某个按钮全都点了没反应」。

    2026-09-27 加DOM 时就漏过一个 id，整块功能静默失效。
    """
    html = read(INDEX)
    js = '\n'.join(re.findall(r'<script[^>]*>(.*?)</script>', html, re.S))
    used = set(re.findall(r"""getElementById\(['"]([A-Za-z0-9_-]+)['"]\)""", js))
    defined = set(re.findall(r"""id=["']([A-Za-z0-9_-]+)["']""", html))
    missing = sorted(used - defined)
    check('A2 id 空引用（用了但HTML 里没有）', not missing,
          ('缺: ' + ', '.join(missing)) if missing else '用了 %d 个，全都有' % len(used))


# ══════════════════════════════════════════════════════════
#  A3. 资源引用完整性 + 大小写
# ══════════════════════════════════════════════════════════
def collect_local_refs():
    """从 index.html 和 manifest.json 里抽出所有本地资源引用。

    ⚠️ 为什么必须查大小写：
       Windows / macOS 的文件系统**不区分大小写**，Linux 区分。
       线上是 Linux。所以 `Logo.png` 写进HTML，本地能显示，
       传上去就 404 —— **本地永远测不出来**，只有线上炸。
    """
    refs = set()
    html = read(INDEX)

    # src= / href= 里的东西
    for m in re.findall(r"""(?:src|href)=["']([^"']+)["']""", html):
        refs.add(m)

    # CSS 里 url(...) 引的
    for m in re.findall(r"""url\((['"]?)([^)'"]+)\1\)""", html):
        refs.add(m[1])

    # manifest.json 整份扫
    mp = os.path.join(ROOT, 'manifest.json')
    if os.path.isfile(mp):
        mj = read(mp)
        for m in re.findall(r'"([^"]+\.(?:png|jpg|jpeg|svg|ico|css|js|json|webmanifest))"', mj):
            refs.add(m)

    # 去掉外链和数据 URI，只留本地相对路径
    out = []
    for r in refs:
        if not r or r.startswith(('http://', 'https://', '//', 'data:', '#', 'mailto:', 'tel:')):
            continue
        if r.startswith('/'):
            # 根相对路径：线上从发布根算，本地要从 .deploy 算 —— 分开查
            out.append(r)
        else:
            out.append(r.lstrip('./'))
    return sorted(set(out))


def a3_refs_exist(base_dir, label):
    """给定一个目录，检查所有本地资源引用在**那个目录**里存在。

    base_dir 用.deploy/ 时就是「发布目录完整性」，
    用仓库根时就是「源码本身有没有引用不存在的东西」。
    """
    refs = collect_local_refs()
    missing, caserisk = [], []

    for r in refs:
        if r.startswith('/'):
            target = os.path.join(base_dir, r.lstrip('/'))
        else:
            target = os.path.join(base_dir, r)

        if os.path.isfile(target):
            continue

        # 精确路径没有 → 看看是不是只有大小写不同（这是最阴的一种）
        d = os.path.dirname(target)
        b = os.path.basename(target)
        hit = None
        if os.path.isdir(d):
            for f in os.listdir(d):
                if f.lower() == b.lower():
                    hit = f
                    break

        if hit:
            caserisk.append('%s  → 实际文件叫 %s（Linux 上会 404）' % (r, hit))
        else:
            missing.append(r)

    check('%s 资源引用完整（%d 个本地引用）' % (label, len(refs)),
          not missing and not caserisk,
          ('缺: ' + ', '.join(missing)) if missing else
          ('大小写不符: ' + '; '.join(caserisk)) if caserisk else '')


# ══════════════════════════════════════════════════════════
#  B1. 发布目录一致性
# ══════════════════════════════════════════════════════════
def b1_deploy_matches():
    """.deploy/ 里该有的文件，跟仓库根目录比，是不是同一份、同样新。

    这是本项目最高危的一类：**手动拷文件**。
    2026-09-24 漏拷 assets/*.png → 线上看板娘裂图；
    2026-10-10 漏拷 sw.js → 线上离线能力整个不存在，而且**控制台没有报错**。
    """
    if not os.path.isdir(DEPLOY):
        check('B1 发布目录 .deploy/ 存在', False, '目录不存在')
        return

    should = ['index.html', 'sw.js', 'manifest.json']
    missing = [f for f in should if os.path.isfile(os.path.join(ROOT, f))
               and not os.path.isfile(os.path.join(DEPLOY, f))]
    check('B1 该拷的文件都在 .deploy/ 里', not missing,
          ('漏拷: ' + ', '.join(missing)) if missing else
          ', '.join(should))

    # 内容是不是同一份（比大小 + 内容哈希）
    import hashlib

    def h(p):
        return hashlib.sha256(io.open(p, 'rb').read()).hexdigest()[:12]

    stale = []
    for f in should:
        a, b = os.path.join(ROOT, f), os.path.join(DEPLOY, f)
        if os.path.isfile(a) and os.path.isfile(b):
            if h(a) != h(b):
                stale.append('%s（根目录已改，.deploy 还是旧的）' % f)
    check('B1b .deploy/ 里的内容跟仓库根一致（不是旧版）', not stale,
          '; '.join(stale) if stale else 'index.html / sw.js / manifest.json 三份都对得上')


def b2_assets_synced():
    """assets/ 里的东西有没有都拷过去。**必须同时拷 jpg 和 png**。

    为什么单独列一条：png 是透明立绘，jpg 存不了 alpha，
    所以这个项目的 assets 里 jpg/png 并存。
    沿用「只拷 *.jpg」的老命令，线上看板娘就是裂的。
    """
    src = os.path.join(ROOT, 'assets')
    dst = os.path.join(DEPLOY, 'assets')
    if not os.path.isdir(src):
        check('B2 assets/ 同步', True, '没有 assets 目录，跳过')
        return
    if not os.path.isdir(dst):
        check('B2 assets/ 同步', False, '.deploy/assets 不存在 —— 全部图片都会裂')
        return

    srcs = [f for f in os.listdir(src)
            if f.lower().endswith(('.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico'))]
    dstset = set(os.listdir(dst))
    missing = [f for f in srcs if f not in dstset]
    check('B2 assets/ 全部同步（%d 个文件，含 png）' % len(srcs), not missing,
          ('漏拷: ' + ', '.join(missing)) if missing else '')


def b3_no_secret_leak():
    """发布目录里不该有密钥。

    这个仓库的 .deploy/ 是公网可读的（链接就发在手机上）。
    服务端 API Key 绝不能进前端代码 —— 前端一改就藏不住。
    """
    bad = []
    for f in ('index.html', 'sw.js', 'manifest.json'):
        p = os.path.join(DEPLOY, f)
        if not os.path.isfile(p):
            continue
        txt = read(p)
        # CloudBase API Key 是 JWT 形态（eyJ...），或直接出现变量赋值
        for m in re.findall(r'eyJ[A-Za-z0-9_-]{20,}', txt):
            bad.append('%s 里有疑似 API Key（eyJ...）' % f)
        if re.search(r'CLOUDBASE_API\w*\s*[:=]\s*["\'][^"\']{8,}', txt):
            bad.append('%s 里有 API Key 赋值' % f)
    check('B3 发布目录里没有服务端密钥', not bad, '; '.join(bad) if bad else '')


# ══════════════════════════════════════════════════════════
#  C. 线上验证（--online）
# ══════════════════════════════════════════════════════════
def c_online(base):
    import json

    base = base.rstrip('/')

    def head(path):
        return subprocess.Popen(
            ['curl', '-sI', base + '/' + path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        ).communicate()[0].decode('utf-8', 'replace')

    def status(path):
        """**不要用 `curl -o /dev/null -w %{http_code}`**。

        ⚠️ 2026-10-11 实测踩坑：这个环境里 `curl -s -o /dev/null -w "%{http_code}"`
           对一个**不存在的文件**返回了 200 —— 因为代理先回了
           `HTTP/1.1 200 Connection Established`（那是 CONNECT 隧道协商，
           不是资源状态），脚本只读到第一行就当成了 200。

           正确做法：`curl -sf` —— `-f` 让 4xx/5xx 直接以非 0 退出码失败。
        """
        r = subprocess.Popen(
            ['curl', '-sf', '-o', os.devnull, '-w', '%{http_code}', base + '/' + path],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
        )
        out = r.communicate()[0].decode('utf-8', 'replace').strip()
        return r.returncode, out

    # C1 precache 清单逐项可达 —— **SW 最隐蔽的坑**：
    #    precache 里只要有一条 404，cache.addAll() 就整体 reject，
    #    SW 安装直接失败，**整个离线能力静默失效**，只留一条 warn。
    precache = []
    if os.path.isfile(SW):
        m = re.search(r'SHELL\s*=\s*\[(.*?)\]', read(SW), re.S)
        if m:
            precache = [x.strip().strip('\'"')
                        for x in m.group(1).split(',')
                        if x.strip()]
    precache = [p for p in precache if p not in ('./', '')]
    precache.insert(0, '')          # './' 就是根

    if precache:
        bad = []
        for p in precache:
            rc, _ = status(p)
            if rc != 0:
                bad.append('./' + p if p else './')
        check('C1 precache 清单每项都真的取得到（%d 项，一条 404 就让 SW 整体装不上）'
              % len(precache), not bad,
              ('取不到: ' + ', '.join(bad)) if bad else '')
    else:
        check('C1 precache 清单（没在 sw.js 里找到 SHELL 数组，跳过）', True)

    # C2 关键文件在线存在
    for f in ('index.html', 'sw.js', 'manifest.json'):
        rc, code = status(f)
        check('C2 线上 /%s 可达' % f, rc == 0, 'HTTP %s' % (code or '无响应'))

    # C3 线上是不是新版 —— grep 本地新代码的特征串
    try:
        html = read(INDEX)
        r = subprocess.Popen(['curl', '-sf', base + '/index.html'],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        online = r.communicate()[0].decode('utf-8', 'replace')
        # 找一个本地有、线上也该有的串（取最长的几个 API 路径当特征）
        markers = [m for m in set(re.findall(r"apiGet\('(/[a-z-]+)'\)", html))]
        if markers:
            absent = [m for m in markers if m not in online]
            check('C3 线上是新版（含全部 %d 个 apiGet 路径）' % len(markers), not absent,
                  ('线上缺: ' + ', '.join(absent) + ' —— 线上还是旧版，发完没生效') if absent
                  else '、'.join(markers))
        else:
            check('C3 线上版本比对（没找到特征串，跳过）', True)
    except Exception as e:  # noqa: BLE001
        check('C3 线上版本比对', False, str(e))

    # C4 图片资源在线可达（裂图不会报错，只能靠这里拦）
    if os.path.isdir(os.path.join(ROOT, 'assets')):
        imgs = [f for f in os.listdir(os.path.join(ROOT, 'assets'))
                if f.lower().endswith(('.png', '.jpg', '.jpeg', '.svg', '.webp'))]
        bad = []
        for f in imgs:
            rc, code = status('assets/' + f)
            if rc != 0:
                bad.append('%s (HTTP %s)' % (f, code))
        check('C4 线上图片全部可达（%d 张，裂图不报错只能这么拦）' % len(imgs), not bad,
              ('裂图: ' + ', '.join(bad)) if bad else '')


# ══════════════════════════════════════════════════════════
def main():
    args = sys.argv[1:]
    online = None
    if '--online' in args:
        i = args.index('--online')
        if i + 1 < len(args):
            online = args[i + 1]
        else:
            online = 'https://daily-checkin-list.app.workbuddy.host'
    use_node = '--no-node' not in args

    print('== A. 本地检查 ==')
    a1_js_syntax(use_node)
    a2_id_refs()
    a3_refs_exist(ROOT, 'A3 源码引用完整性')

    print('')
    print('== B. 发布目录一致性 ==')
    b1_deploy_matches()
    b2_assets_synced()
    b3_no_secret_leak()

    if online:
        print('')
        print('== C. 线上验证（%s）==' % online)
        c_online(online)

    total = len(results)
    bad = [r for r in results if not r[1]]
    print('')
    print('=' * 52)
    print('%d/%d 通过' % (total - len(bad), total))
    if bad:
        print('')
        print('有失败项 —— 修复后重跑。**没全绿之前不要发布**（发布是覆盖式的，'
              '线上链接可能已经分享给别人了）。')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
