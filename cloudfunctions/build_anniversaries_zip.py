# -*- coding: utf-8 -*-
"""Day 26：打纪念日云函数的部署包，并在解包后做 require 自检。

【为什么必须做解包自检，而不是「zip 打出来了就发」】
    部署时 CloudBase 会把整个 zip **解压成一个独立根目录**，父目录不存在。
    而 index.js 里 errors-human.js 是这么require 的：
        try  { require('./errors-human.js') }   ← 部署后能走这条
        catch { require('../errors-human.js') } ← 只在本地仓库里能走
    如果 zip 里**没有** errors-human.js：
      ·控制台点部署**不会报错**（它只校验 index.js 在不在）
      · 一调用就是 `Cannot find module` → 500
    也就是说「部署成功」和「能用」是两件事，而前者不会告诉你后者坏了。
→ 所以打完包立刻解开到独立目录，在那儿 require 一次：
  这跟部署后的目录结构完全一样，能通过就说明云端也能过。

【为什么错误的 require 静默通过】
    第一个 try 失败会被 catch 接住，看起来「有兜底所以没事」——
    但兜底那条 '../' 在云端恰好是不存在的那条。
    **兜底代码自己坏掉时，是静默的。** 所以只能靠解包自检来证。

用法：python cloudfunctions/build_anniversaries_zip.py
"""
import io
import os
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'anniversaries.zip')

# (磁盘上的路径, zip 内的相对路径)
# ⚠️ 为什么要显式写这个映射，而不是把整个目录 zip -r：
#   errors-human.js 在 cloudfunctions/ 下，是 anniversaries/ 的**兄弟**。
#   直接 zip 整个目录，它会以 anniversaries/errors-human.js 落进包里，
#   于是 index.js 里 require('./errors-human.js') 恰好能过——
#   **看起来没问题**。但那时它是被复制进去的，跟真正该在的位置不同。
#   显式映射保证包内结构跟部署后的预期一致。
FILES = [
    (os.path.join(HERE, 'anniversaries', 'index.js'), 'index.js'),
    (os.path.join(HERE, 'anniversaries', 'anniversariesRepository.js'),
     'anniversariesRepository.js'),
    (os.path.join(HERE, 'errors-human.js'), 'errors-human.js'),
    (os.path.join(HERE, 'anniversaries', 'package.json'), 'package.json'),
]


def build():
    print('== 1. 检查源文件都在 ==')
    missing = []
    for disk, arc in FILES:
        if not os.path.isfile(disk):
            missing.append(disk)
            print('  MISSING  ' + disk)
    if missing:
        print('\n源文件缺失，包没打。')
        return 1
    for disk, arc in FILES:
        print('  OK  %-32s -> %s' % (os.path.basename(disk), arc))

    print('\n== 2. 打包 ==')
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        for disk, arc in FILES:
            z.write(disk, arc)
    print('  写出 %s（%d 字节）' % (OUT, os.path.getsize(OUT)))

    print('\n== 3. 包内清单 ==')
    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
        for n in names:
            print('  · ' + n)
        if 'errors-human.js' not in names:
            print('\n  ★ 包里没有 errors-human.js —— 部署后一调用就 500（而部署不会报错）。')
            return 1

    print('\n== 4. 解包自检（复刻部署后的目录结构）==')
    tmp = os.path.join(os.environ['USERPROFILE'], '.workbuddy', 'tmp', 'anniv-unpack')
    if os.path.isdir(tmp):
        shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    with zipfile.ZipFile(OUT) as z:
        z.extractall(tmp)

    # 解包目录里**没有父目录**—— 这正是部署后的形态。
    # 如果在这里 require 能过，云端就能过。
    node = os.path.join(os.environ['USERPROFILE'], '.workbuddy', 'binaries',
                        'node', 'versions', '22.22.2-5', 'node.exe')
    probe = os.path.join(tmp, '_probe.js')
    io.open(probe, 'w', encoding='utf-8').write(
        "process.env.CLOUDBASE_APIKEY = 'probe';\n"
        "var fn = require('./index.js');\n"
        "if (typeof fn.main !== 'function') {\n"
        "  console.error('FAIL: exports.main 不是函数');\n"
        "  process.exit(1);\n"
        "}\n"
        "var repo = require('./anniversariesRepository.js');\n"
        "['list','insert','update','remove','exists'].forEach(function (k) {\n"
        "  if (typeof repo[k] !== 'function') {\n"
        "    console.error('FAIL: repository 缺 ' + k); process.exit(1);\n"
        "  }\n"
        "});\n"
        "var human = require('./errors-human.js');\n"
        "if (typeof human.humanUpstream !== 'function') {\n"
        "  console.error('FAIL: errors-human.js 缺 humanUpstream'); process.exit(1);\n"
        "}\n"
        "console.log('  解包后 require 全通过（index / repository / errors-human）');\n"
    )
    r = subprocess.run([node, probe], capture_output=True, text=True, cwd=tmp)
    sys.stdout.write(r.stdout)
    if r.returncode != 0:
        sys.stdout.write(r.stderr)
        print('\n  ★ 解包后 require 失败 —— 这个包发上去就是「部署成功但一调用就 500」。')
        return 1

    print('\n== 5. 确认包内有 timetable 残留（Day 25 已删干净）==')
    with zipfile.ZipFile(OUT) as z:
        for n in z.namelist():
            if 'timetable' in n.lower():
                print('  ★ 包里有课表残留：' + n)
                return 1
    print('  无残留')

    print('\n打包完成。')
    return 0


if __name__ == '__main__':
    sys.exit(build())
