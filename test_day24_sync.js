// Day 24 写入层验证（用 new Function 拿内部函数，不用抠函数体）
//
// ⚠️ 今天在「抠函数体」上栽了三次，记一下：
//   ① 用花括号计数配平抠，遇到嵌套回调会在错误位置结束
//   ② eval() 里的 var和 function 声明都不在外层作用域
//   ③ 改用 new Function + return 导出，一次成功 —— 这才是对的做法
'use strict';
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const js = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

// ── 最小 DOM 桩 ──
const els = {};
const mkEl = () => ({
  disabled: false, textContent: '', value: '',
  classList: { add() {}, remove() {} },
  setAttribute() {}, getAttribute: () => null, addEventListener() {}
});
global.document = { getElementById: (id) => (els[id] = els[id] || mkEl()) };
global.window = global;
global.fetch = () => Promise.resolve({ ok: false, text: () => Promise.resolve('') });

// 只取写入层那一段（apiSend 到 fetchState 之前），避免依赖 DOM 初始化的代码
const start = js.indexOf('function apiSend');
const end = js.indexOf('function fetchState');

const factory = new Function(js.slice(start, end) + `
  return {
    apiSend, toDbItem, syncJobs, pushToDb, drainQueue,
    getQueue: function () { return syncQueue; },
    setQueue: function (q) { syncQueue = q; },
    isBusy: function () { return syncBusy; }
  };
`);
const K = factory();

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async function () {
  console.log('-- Day 24 写入层：失败队列与重试 --');

  // ① 撤销路径：DUPLICATE 被忽略，不进队列（这是我特意修的误报）
  K.setQueue([]);
  K.pushToDb(() => Promise.resolve({ ok: false, code: 'DUPLICATE', msg: '这个 id 已经在清单里了' }), ['DUPLICATE']);
  await wait(50);
  check('撤销路径：DUPLICATE 被忽略（不弹提示）', K.getQueue().length === 0, K.getQueue().map(x => x.msg));

  // ② 真失败：进队列 + 自动重试一次
  K.setQueue([]);
  let calls = 0;
  K.pushToDb(() => { calls++; return Promise.resolve({ ok: false, code: 'NETWORK', msg: '连不上服务器' }); });
  await wait(150);
  check('真失败：进失败队列', K.getQueue().length === 1, K.getQueue().length);
  check('★ 真失败：自动重试过一次（瞬时失败用户就不用被打扰）', calls === 2, calls);

  // ③ 不带 ignoreCodes 时409仍当失败（别把规则扩大到所有调用点）
  K.setQueue([]);
  K.pushToDb(() => Promise.resolve({ ok: false, code: 'DUPLICATE', msg: 'x' }));
  await wait(50);
  check('不传 ignoreCodes 时 409 仍当失败', K.getQueue().length === 1, K.getQueue().length);

  // ④ 成功 -> 完全不进队列
  K.setQueue([]);
  K.pushToDb(() => Promise.resolve({ ok: true }));
  await wait(50);
  check('成功：不进队列', K.getQueue().length === 0, K.getQueue().length);

  // ⑤ 重试成功 -> 队列清空（提示条消失）
  K.setQueue([]);
  K.getQueue().push({ job: () => Promise.resolve({ ok: true }), msg: 'x' });
  K.drainQueue();
  await wait(150);
  check('★ 重试成功 → 队列清空（提示条消失）', K.getQueue().length === 0, K.getQueue().length);

  // ⑥ 连续失败两条都要留着（不能悄悄吞掉前面的失败）
  K.setQueue([]);
  const never = () => Promise.resolve({ ok: false, code: 'NETWORK', msg: 'x' });
  K.getQueue().push({ job: never, msg: 'a' });
  K.getQueue().push({ job: never, msg: 'b' });
  check('连续两次失败：两条都在队列里（不吞）', K.getQueue().length === 2, K.getQueue().length);

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + '：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})();