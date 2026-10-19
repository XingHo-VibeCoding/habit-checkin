#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打包 cloudfunctions/reminders 成 zip（部署到 CloudBase 用）。
照 build_anniversaries_zip.py 抄 —— 打包 4 个文件，解包自检 require 链。
Day 27：reminders 补写入后重传用。
"""
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FILES = [
    (os.path.join(HERE, 'reminders', 'index.js'), 'index.js'),
    (os.path.join(HERE, 'reminders', 'remindersRepository.js'), 'remindersRepository.js'),
    (os.path.join(HERE, 'errors-human.js'), 'errors-human.js'),
    (os.path.join(HERE, 'reminders', 'package.json'), 'package.json'),
]
OUT = os.path.join(HERE, 'reminders.zip')


def build():
    print('== 1. 检查源文件都在 ==')
    for src, arc in FILES:
        if not os.path.isfile(src):
            print('  缺少:', src)
            return 1
        print('  OK  %s -> %s' % (os.path.relpath(src, ROOT), arc))

    print('\n== 2. 打包 ==')
    if os.path.isfile(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        for src, arc in FILES:
            z.write(src, arc)
    print('  写出 %s（%d 字节）' % (OUT, os.path.getsize(OUT)))

    print('\n== 3. 包内清单 ==')
    with zipfile.ZipFile(OUT) as z:
        for n in z.namelist():
            print('  ·', n)

    print('\n== 4. 解包自检（复刻部署后的目录结构）==')
    tmp = tempfile.mkdtemp(prefix='rem_zip_')
    try:
        with zipfile.ZipFile(OUT) as z:
            z.extractall(tmp)
        # 解压后根目录必须能 require(index.js) —— errors-human.js 必须同在根目录。
        # 这个自检就是 2026-10-14 那个「传文件夹缺 errors-human.js 崩了一下午」的防复发闸。
        probe = os.path.join(tmp, 'probe.js')
        with open(probe, 'w', encoding='utf-8') as f:
            f.write("require('./index.js'); console.log('REQUIRE OK');")
        node = None
        nv = os.path.join(os.path.expanduser('~'), '.workbuddy', 'binaries', 'node', 'versions')
        if os.path.isdir(nv):
            for name in sorted(os.listdir(nv)):
                exe = os.path.join(nv, name, 'node.exe')
                if os.path.isfile(exe):
                    node = exe
        if not node:
            from shutil import which
            node = which('node')
        if not node:
            print('  （找不到 node，跳过 require 自检 —— zip 本身已校验）')
            return 0
        p = subprocess.run([node, probe], capture_output=True, text=True, cwd=tmp, timeout=30)
        out = (p.stdout or '') + (p.stderr or '')
        if 'REQUIRE OK' in out:
            print('  require 链 OK（4 个文件齐全，index.js 能加载）')
            return 0
        print('  FAIL: require 自检失败:\n' + out[:400])
        return 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(build())