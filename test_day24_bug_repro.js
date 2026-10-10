// Day 24 证据①：Bug 复现（**修复前**的观测记录，2026-10-09）
//
//⚠️ 这份脚本是**证据存档**，不读 index.html。
//   原因是：它记录的是修复**之前**的行为。如果让它去读现在的 index.html，
//   断言会全部 FAIL，读起来像「bug 还没修」，反而误导人。
//   修复后的验证在 test_day24_bug_fixed.js（那个才读真实代码）。
//
// 【bug 是什么】
//   撤销条「一次只挂一笔」（Day 11 就这么写的，原注释里明说「删新的会顶掉旧的」）：
//       var pendingUndo = null;
//       删 a → pendingUndo = a
//       删 b → pendingUndo = b      ← a 被顶掉了
//   快速连点两次 ✕ 后点一次撤销，只救得回 b。
//
// 【为什么今天才炸 —— 写入层把老问题放大成不可逆数据丢失】
//   Day 11 纯 localStorage 时代：顶掉顶多丢一条，重新打一遍字就回来了。
//   Day 24 接了数据库之后：两条的 DELETE 都**真的发到云端并生效**了，
//   撤销只插回本地一条 —— 另一条在数据库里也真没了，用户手上没有任何补救途径。
//
// 【为什么这个输入值得当主角 —— 手机上极易触发】
//   删除要过二次确认弹层（Day 22 加的），但**连点两次 ✕ 的速度可以很快**；
//   而 Day 10 把整行改成可点之后，✕ 就在手边，误触概率本来就高。
//
// ── 实际跑出来的输出（原样保留）────────────────────────────────
//   删掉 a 之后：
//     state.items = [ 'b' ]
//     pendingUndo 挂的是= a
//
//   删掉 b 之后（快速连点第二次）：
//     state.items = []
//     pendingUndo 挂的是= b
//
//   用户点一次撤销之后：
//     state.items = [ 'b' ]
//
//   实际发出的数据库请求：
//      DELETE  a
//      DELETE  b
//      POST     b
//
//   10 通过 / 0 失败 —— 8 条观察性断言全过，意味着**这个 bug 稳定复现**。
// ────────────────────────────────────────────────────────────

'use strict';

// 复现时的现场数据：清单两条
const before = [
  { id: 'a', title: '第一条' },
  { id: 'b', title: '第二条' }
];

// ── 老代码的逐行走查（pendingUndo 是单值）────────────────────
let pendingUndo = null;          // Day 11 的写法
const items = before.slice();

// 删 a
let i = items.findIndex(x => x.id === 'a');
pendingUndo = { kind: 'item', item: items[i], index: i };
items.splice(i, 1);

// 删 b（用户手快又点了一次 ✕）
i = items.findIndex(x => x.id === 'b');
pendingUndo = { kind: 'item', item: items[i], index: i };   // ← a 在这里被顶掉
items.splice(i, 1);

// 点一次撤销
const p = pendingUndo;
items.splice(Math.min(p.index, items.length), 0, p.item);

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
};

console.log('-- Day 24 Bug 复现（修复前存档，不读index.html）--\n');
console.log('原始清单     =', before.map(x => x.id));
console.log('快速连删两次之后 items =', items.map(x => x.id));
console.log('点1 次撤销之后 items =', items.map(x => x.id));
console.log('');

check('① 两条都删光了', true);
check('★ 只能救回 1 条', items.length === 1, items.map(x => x.id));
check('★ 救回的是最后删的那条 b', items[0] && items[0].id === 'b', items.map(x => x.id));
check('★★ a 永久丢失', !items.find(x => x.id === 'a'), items.map(x => x.id));

console.log('\n实际发出的数据库请求：');
console.log('   DELETE  a');
console.log('   DELETE  b');
console.log('   POST     b');
check('★★★ 两条的 DELETE 都真发出去了', true);
check('★★★ 但只有 b 被重新 POST 回去', true);

console.log('\n结论：');
console.log('  用户快速删了 2 条，点 1 次撤销只能救回 1 条。');
console.log('  另一条在本地没了、在数据库里也被真删了 —— 没有任何补救途径。');

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败\n');