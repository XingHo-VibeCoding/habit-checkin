// Day 24 证据④：验证修复 —— 快速连点删除后一次撤销要全部还回来
//
// 这个脚本**读真实的 index.html**，所以它验的是现在这份代码，不是我的记忆。
// 修复前 / 修复后的对照见 test_day24_bug_repro.js（存档，不读代码）。
//
// 跑法：node test_day24_bug_fixed.js
'use strict';
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const js = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

// ── DOM 桩 ──
const els = {};
const mkEl = () => ({
  disabled: false, textContent: '', value: '', checked: false,
  classList: { add() {}, remove() {} },
  setAttribute() {}, getAttribute: () => null, addEventListener() {},
  querySelector: () => mkEl(), querySelectorAll: () => []
});
global.document = { getElementById: (id) => (els[id] = els[id] || mkEl()) };
global.window = global;
global.fetch = () => Promise.resolve({ ok: false, text: () => Promise.resolve('') });
global.setTimeout = () => 0;      // 撤销条别自动消失，专心测「连删两次」
global.clearTimeout = () => {};

// 切片必须**同时**含 doRemoveItem / UNDO_MS / pendingUndo / undoRemove，
// 所以起点取 askDelete（doRemoveItem 在它后面），终点取 addItem。
const start = js.indexOf('function askDelete');
const end = js.indexOf('function addItem');

// removeAnniv 定义在 askDelete **之前**，所以要单独切一段进来
// （场景三要验「清单项和纪念日混删，各自回到各自的数组」）。
const annivSrc = js.slice(js.indexOf('function removeAnniv'), js.indexOf('function hhmmToMin'));

// doRemoveItem / undoRemove 会调 save() / render()（写 localStorage + 重绘），
// 跟本 bug 无关但缺了会 ReferenceError —— 补最小桩。
// pushToDb 顺手把发出去的请求记下来，用来验「云端也一起恢复了」。
const STUBS = `
  function save() {}
  function render() {}
  var SENT = [];
  function pushToDb(job, ignoreCodes) {
    var r = job();
    r.ignore = ignoreCodes || null;
    SENT.push(r);
  }
  var syncJobs = {
    add: function (it) { return function () { return { id: it.id, title: it.title, op: 'POST' }; }; },
    toggle: function (id) { return function () { return { id: id, op: 'PATCH' }; }; },
    remove: function (id) { return function () { return { id: id, op: 'DELETE' }; }; },
    // Day 26：纪念日的三个动作。
    // ⚠️ 加这三个不是「补全一下让测试跑起来」—— 少一个的话 removeAnniv 会
    //   TypeError，整个测试在场景三就崩了，**后面所有断言都没跑**。
    //   那是最坏的一种失败：不是红着告诉你哪里坏了，是整个脚本中途死掉。
    // op 用 ANNIV_ 前缀区分，不跟 items 的混 —— 混了分不清「POST 的是清单还是纪念日」，
    //   而这正是场景三要验的事。
    annivAdd: function (a) { return function () { return { id: a.id, title: a.title, op: 'ANNIV_POST' }; }; },
    annivToggleYearly: function (id) { return function () { return { id: id, op: 'ANNIV_PATCH' }; }; },
    annivRemove: function (id) { return function () { return { id: id, op: 'ANNIV_DELETE' }; }; },
    // Day 27：syncJobs 长了提醒的云端写入方法，桩跟着长（桩不跟 = TypeError 假崩）
    remAdd: function (r) { return function () { return { id: r.id, op: 'REM_ADD' }; }; },
    remRemove: function (id) { return function () { return { id: id, op: 'REM_DELETE' }; }; }
  };
`;

const factory = new Function(STUBS + annivSrc + '\n' + js.slice(start, end) + `
  return {
    UNDO_MS: UNDO_MS,
    pendingUndo: function () { return pendingUndo; },
    defaultUndoMsg: defaultUndoMsg,
    showUndo: showUndo, hideUndo: hideUndo, undoRemove: undoRemove,
    doRemoveItem: doRemoveItem, removeAnniv: removeAnniv,
    setState: function (s) { state = s; }, getState: function () { return state; },
    getSent: function () { return SENT; }, clearSent: function () { SENT = []; }
  };
`);
const K = factory();

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
};
const ids = () => K.getState().items.map(x => x.id);

const item = (id, title) => ({ id: id, title: title, date: '2026-10-09', done: false, createdAt: '2026-10-09T00:00:00.000Z', doneAt: null });

console.log('-- Day 24 修复验证：快速连点删除后一次撤销 --\n');

// ─────────────────────────────────────────────────────────────
console.log('【场景一】两条，快速删掉，点一次撤销');

K.setState({ items: [item('a', '第一条'), item('b', '第二条')], anniv: [] });
K.clearSent();

K.doRemoveItem('a');
K.doRemoveItem('b');          // 用户手快又点了一次 ✕

check('① 两条都删光了', ids().length === 0, ids());
check('★ 撤销队列里挂了两笔（原来只挂一笔）',
  K.pendingUndo().length === 2, K.pendingUndo().length);
check('★ 队列顺序是「从旧到新」a→b',
  K.pendingUndo().map(p => p.item.id).join(',') === 'a,b',
  K.pendingUndo().map(p => p.item.id));

console.log('\n用户点一次撤销之后：');
console.log('  state.items =', ids());
K.undoRemove();
console.log('  state.items =', ids());

check('★★ 一次撤销，两条都回来了', ids().length === 2, ids());
check('★★ 顺序恢复成原样 [a,b]', ids().join(',') === 'a,b', ids());
check('★ a 没丢（这是修复前永久丢失的那条）', ids().indexOf('a') >= 0, ids());
check('★ b 也在', ids().indexOf('b') >= 0, ids());

const sent = K.getSent();
console.log('\n实际发出的数据库请求：');
sent.forEach(x => console.log('   ' + x.op + '  ' + x.id));

check('★★★ 云端也一起恢复了：a、b 各自重新 POST',
  sent.filter(x => x.op === 'POST').map(x => x.id).sort().join(',') === 'a,b',
  sent.filter(x => x.op === 'POST').map(x => x.id));
check('★ 撤销路径忽略 409（那条可能还在，不算失败）',
  sent.filter(x => x.op === 'POST').every(x => x.ignore && x.ignore.indexOf('DUPLICATE') >= 0),
  sent.filter(x => x.op === 'POST').map(x => x.ignore));

// ─────────────────────────────────────────────────────────────
console.log('\n【场景二】三条全删，一次撤销 —— 验证倒序插回不会打乱顺序');
K.setState({ items: [item('a', '甲'), item('b', '乙'), item('c', '丙')], anniv: [] });
K.clearSent();
K.doRemoveItem('a');
K.doRemoveItem('b');
K.doRemoveItem('c');
console.log('  连删 3 次后 items =', ids());
K.undoRemove();
console.log('  撤销 1 次后items =', ids());
check('★★ 三条都回来了', ids().length === 3, ids());
check('★★★ 顺序严格是 [a,b,c]（倒序插回生效）', ids().join(',') === 'a,b,c', ids());

// ─────────────────────────────────────────────────────────────
console.log('\n【场景三】清单项和纪念日混删 —— 撤销要各回各的数组');
K.setState({
  items: [item('x', '清单项'), item('y', '清单项2')],
  anniv: [{ id: 'm1', title: '纪念日1', date: '2026-01-01', yearly: true }]
});
K.clearSent();
K.doRemoveItem('x');
K.removeAnniv('m1');
K.undoRemove();
console.log('  items  =', K.getState().items.map(x => x.id));
console.log('  anniv  =', K.getState().anniv.map(x => x.id));
check('清单项回到 state.items', K.getState().items.map(x => x.id).join(',') === 'x,y', K.getState().items.map(x => x.id));
check('★ 纪念日回到 state.anniv（没跑到 items 里去）',
  K.getState().anniv.map(x => x.id).join(',') === 'm1', K.getState().anniv.map(x => x.id));
// ⚠️ 这一条 Day 26 被**反转**了，而且反转的理由值得写下来：
//
//   Day 24 原文断言：「纪念日不该发 POST（后端还没那张表，发了会永远重试）」，
//   期望 POST 数 === 1（只有清单项那笔）。
//
//   Day 26 之后这个断言是**错的**：anniversaries 表上线了，纪念日有后端了。
//   撤销删掉的纪念日如果只在本地恢复、云端那条还在，下次打开页面它又回来
//   —— **撤销等于没撤销**。
//
//   【为什么这类反转危险，而不是「改一下测试让它过」】
//     测试断言里写着「因为还没有 X 所以不做 Y」。当 X 出现的那天，
//     这条断言不会失败，它会**继续把新代码判成错的** ——
//     人看到 FAIL 会以为代码退化了，于是把 X 删掉来「修复」。
//     这就是「前提变了但断言没跟着变」的代价。
//   → 所以连注释一起改：让下一个人看到这条时知道它为什么反转，
//     而不是以为当初就该这么写。
check('★ 纪念日撤销也发 POST（Day 26：后端有表了，不发就是「撤销等于没撤销」）',
  K.getSent().filter(x => x.op === 'ANNIV_POST').map(x => x.id).join(',') === 'm1',
  K.getSent().map(x => x.op + ' ' + x.id));
check('★ 删掉纪念日时也发了 ANNIV_DELETE（不然云端那条会留着）',
  K.getSent().filter(x => x.op === 'ANNIV_DELETE').map(x => x.id).join(',') === 'm1',
  K.getSent().map(x => x.op + ' ' + x.id));
check('★ 清单项和纪念日各发各的，没串（POST 只有一笔 ANNIV_POST + 一笔 POST）',
  K.getSent().filter(x => x.op === 'POST').length === 1 &&
  K.getSent().filter(x => x.op === 'ANNIV_POST').length === 1,
  K.getSent().map(x => x.op + ' ' + x.id));
check('★ 纪念日的 POST 同样忽略 409（理由跟 items 一致：那一条可能还在）',
  K.getSent().filter(x => x.op === 'ANNIV_POST').every(x => x.ignore && x.ignore.indexOf('DUPLICATE') >= 0),
  K.getSent().filter(x => x.op === 'ANNIV_POST').map(x => x.ignore));

// ─────────────────────────────────────────────────────────────
console.log('\n【场景四】撤销条过期后，不能再撤销旧的 —— 机会只有UNDO_MS');
K.setState({ items: [item('a', '第一条'), item('b', '第二条')], anniv: [] });
K.clearSent();
K.doRemoveItem('a');
K.doRemoveItem('b');
check('① 队列里有2 笔', K.pendingUndo().length === 2, K.pendingUndo().length);
K.hideUndo();                       // 模拟 2.6 秒后自动收起
check('② 过期后队列清空', K.pendingUndo().length === 0, K.pendingUndo().length);
K.undoRemove();                     // 再点，已经晚了
check('② 过期后点撤销不会凭空变出东西', ids().length === 0, ids());

// ─────────────────────────────────────────────────────────────
console.log('\n【场景五】只删一条时，文案要跟修复前完全一致（别引入新变化）');
K.setState({ items: [item('a', '喝水')], anniv: [] });
K.doRemoveItem('a');
check('单条文案 = 已删除「喝水」', K.defaultUndoMsg() === '已删除「喝水」', K.defaultUndoMsg());
K.hideUndo();
K.setState({ items: [item('a', '甲'), item('b', '乙')], anniv: [] });
K.doRemoveItem('a');
K.doRemoveItem('b');
check('两条文案 = 已删除「甲」等 2 条', K.defaultUndoMsg() === '已删除「甲」等 2 条', K.defaultUndoMsg());
K.hideUndo();
K.setState({ items: [], anniv: [{ id: 'm1', title: '结婚纪念日' }] });
K.removeAnniv('m1');
check('纪念日单条文案保持原样 = 已删除纪念日「结婚纪念日」',
  K.defaultUndoMsg() === '已删除纪念日「结婚纪念日」', K.defaultUndoMsg());

console.log('\n' + (fail === 0
  ? '结论：修复生效 —— 连删多条后一次撤销全部还回来，顺序、云端同步、文案都对。'
  : '结论：还有 FAIL，修复没完成。'));
console.log(pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);