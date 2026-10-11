# -*- coding: utf-8 -*-
"""id 空引用检查：脚本里 getElementById('x') 用到的 id，HTML 里有没有 id="x"。

写这个脚本是因为「发布前四步冒烟」里的第2 步 —— 它便宜，却能抓真 bug：
Day 21 就因为加 DOM 时漏了一个 id，整块功能静默不响应。
"""
import io
import re

HTML = r'D:/Vibe Coding/index.html'

h = io.open(HTML, encoding='utf-8').read()
blocks = re.findall(r'<script[^>]*>(.*?)</script>', h, re.S)
js = '\n'.join(blocks)

used = set(re.findall(r"""getElementById\(['"]([A-Za-z0-9_-]+)['"]\)""", js))
defined = set(re.findall(r"""id=["']([A-Za-z0-9_-]+)["']""", h))

missing = sorted(used - defined)
unused = sorted(defined - used)

print('脚本里用到的 id：%d 个' % len(used))
print('HTML 里定义的 id：%d 个' % len(defined))
print('')
print('空引用（用了但 HTML 里没有）: %s' % (missing if missing else 'NONE'))
print('')
# 未使用的 id 多半是「定义了但 JS 没拿到」的反面情况，不一定是错，只提示
print('HTML 有但脚本没用（仅供参考，可能由 CSS/锚点用）:')
print('  ' + (', '.join(unused) if unused else 'NONE'))

raise SystemExit(1 if missing else 0)
