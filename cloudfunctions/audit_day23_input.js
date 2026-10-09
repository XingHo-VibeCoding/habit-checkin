// cloudfunctions/audit_day23_input.js · Day 23 审计 3/4：非法输入
// ---------------------------------------------------------------------------
// 干什么用的：把「畸形输入」逐条真打进 items / reminders 的 main()，
// 记录每次的 HTTP 状态码和错误文案，然后按红线判：
//   ① 不能 5xx（崩了 / 未捕获异常 = 5xx）
//   ② 不能漏技术细节（stack / ENOENT / undefined / at Object.）
//   ③ 得是中文，且得说清「你怎么改」
//
// 跑法：node cloudfunctions/audit_day23_input.js
// 只验逻辑不验真库，跟 test_logic.js 同一套前提。
'use strict';

var EventEmitter = require('events').EventEmitter;
var https = require('https');
var path = require('path');

// ── 假网络层：不管发什么，一律回一个「上游一切正常」的空数组 ──
//    审计非法输入时我**故意**让上游成功返回，
//    这样「返回 4xx」就一定是被我们自己代码挡下来的，
//    而不是碰巧上游报了错 —— 这是这个脚本的关键设计。
var fakeMode = 'ok';   // 'ok' | 'row' | 'throw'
function fakeRequest(opts, cb) {
  var res = new EventEmitter();
  res.statusCode = 200;
  res.setEncoding = function () {};
  res.headers = { 'content-type': 'application/json' };
  process.nextTick(function () {
    if (fakeMode === 'throw') {
      cb(new Error('getaddrinfo ENOTFOUND api.tcloudbasegateway.com'));
      return;
    }
    cb(res);
    // ★ 必须发 Buffer，不能发字符串。
    //   真实 https 响应的 'data' 事件给的是 Buffer（仓库层用 Buffer.concat 拼），
    //   桩里偷懒发字符串的话，第一个用例就会在 Buffer.concat 上抛
    //   ERR_INVALID_ARG_TYPE —— 那是**桩的错，不是被测代码的错**，
    //   会让整个审计脚本崩掉，看起来像「代码有 bug」。
    if (fakeMode === 'row') {
      res.emit('data', Buffer.from(JSON.stringify([{ id: 'it-1', title: 'x', plan_date: '2026-10-09', done: 0 }])));
    } else {
      res.emit('data', Buffer.from('[]'));
    }
    res.emit('end');
  });
  return { on: function () {}, destroy: function () {}, write: function () {}, end: function () {} };
}
https.request = fakeRequest;

process.env.CLOUDBASE_APIKEY = 'test-key';
process.env.CLOUDBASE_API_KEY = 'test-key';
process.env.TCB_API_KEY = 'test-key';

var items = require('./items/index.js');
var reminders = require('./reminders/index.js');

// ── 红线判据 ──
var LEAKS = [
  { re: /at\s+Object\./,          name: 'JS 堆栈行号' },
  { re: /\bError:\s/,            name: 'Error: 前缀' },
  { re: /ENOENT|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EACCES/, name: 'errno 原文' },
  { re: /undefined|null|NaN/,   name: 'JS 值泄漏' },
  { re: /select |insert |update |delete from/i, name: 'SQL 原文' },
  { re: /https?:\/\//,          name: '内部地址' }
];

function isChinese(s) {
  var cn = String(s).match(/[\u4e00-\u9fa5]/g);
  return cn && cn.length >= 4;
}

var rows = [];
function judge(name, r, opt) {
  opt = opt || {};
  var sc = r && r.statusCode;
  var env;
  try { env = JSON.parse(r.body); } catch (e) { env = null; }
  var msg = env && env.error && env.error.message ? env.error.message : '(没有 error.message)';
  var leaks = [];
  LEAKS.forEach(function (L) { if (L.re.test(msg)) leaks.push(L.name); });

  var probs = [];
  // expect200：这条**本来就应该** 200。用于「合法但不长得像错误」的输入
  // （比如 ?date= 空串 = 不筛选）。判据跟错误路径相反 ——
  // 错的是「本该 400 却给了 200」，所以只查「没有 error 字段」这一条。
  if (opt.expect200) {
    if (env && env.error) probs.push('本该成功却报了错');
    if (sc !== 200) probs.push('本该 200，实得 ' + sc);
    rows.push({ name: name, status: sc, code: null, ok: probs.length === 0, probs: probs, msg: '(合法返回，非错误路径)' });
    return rows[rows.length - 1];
  }
  if (sc >= 500) probs.push('5xx');
  if (!env || !env.error) probs.push('响应里没有 error 字段');
  if (!isChinese(msg)) probs.push('不是中文');
  if (leaks.length) probs.push('泄漏:' + leaks.join(','));
  if (opt.wantCode && (!env.error || env.error.code !== opt.wantCode)) {
    probs.push('code 期望 ' + opt.wantCode + ' 实得 ' + (env.error && env.error.code));
  }
  if (opt.wantStatus && sc !== opt.wantStatus) probs.push('状态码期望 ' + opt.wantStatus);

  rows.push({ name: name, status: sc, code: env && env.error && env.error.code, ok: probs.length === 0, probs: probs, msg: msg });
  return rows[rows.length - 1];
}

// ═══════════════ items ═══════════════
var itemCases = [
  // ── 日期畸形：这一组是最容易被忽略的 ──
  { n: 'GET date 用斜杠 2026/10/02', f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { date: '2026/10/02' } }); } },
  { n: 'GET date=13 月',             f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { date: '2026-13-01' } }); } },
  { n: 'GET date=2 月 31 日',f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { date: '2026-02-31' } }); } },
  { n: 'GET date 空串（= 不筛选，合法）', f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { date: '' } }); }, expect200: true },
  { n: 'GET date 超长（500 字）',     f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { date: '2'.repeat(500) } }); } },
  { n: 'GET date 带引号注入',        f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { date: "2026-10-09' OR '1'='1" } }); } },

  // ── limit 畸形 ──
  { n: 'GET limit=0',                f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { limit: '0' } }); } },
  { n: 'GET limit=-1',f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { limit: '-1' } }); } },
  { n: 'GET limit=99999999',f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { limit: '99999999' } }); } },
  { n: 'GET limit=abc',              f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { limit: 'abc' } }); } },
  { n: 'GET limit=1e9（科学计数法）',  f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { limit: '1e9' } }); } },
  { n: 'GET limit=0x10（十六进制）',  f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { limit: '0x10' } }); } },
  { n: 'GET limit=3.5（小数）',      f: function () { return items.main({ httpMethod: 'GET', queryStringParameters: { limit: '3.5' } }); } },

  // ── body 畸形 ──
  { n: 'POST body 完全不传',         f: function () { return items.main({ httpMethod: 'POST' }); } },
  { n: 'POST body 空串',             f: function () { return items.main({ httpMethod: 'POST', body: '' }); } },
  { n: 'POST body 是乱码',           f: function () { return items.main({ httpMethod: 'POST', body: '\x00\x01\x02' }); } },
  { n: 'POST body 截断的 JSON',      f: function () { return items.main({ httpMethod: 'POST', body: '{"title":"x"' }); } },
  { n: 'POST body 中文引号',         f: function () { return items.main({ httpMethod: 'POST', body: '{"title":"x"}' }); } },
  { n: 'POST body 是数组不是对象',   f: function () { return items.main({ httpMethod: 'POST', body: '[1,2,3]' }); } },
  { n: 'POST body 是字符串',         f: function () { return items.main({ httpMethod: 'POST', body: '"hello"' }); } },
  { n: 'POST body 是 null',          f: function () { return items.main({ httpMethod: 'POST', body: 'null' }); } },
  { n: 'POST title 是对象',          f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ title: { a: 1 } }) }); } },
  { n: 'POST title 是 null',         f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ title: null }) }); } },
  { n: 'POST title 空串',            f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ title: '' }) }); } },
  { n: 'POST title 纯空白',          f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ title: '   ' }) }); } },
  { n: 'POST title 超长 5000 字',    f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ title: 'x'.repeat(5000) }) }); } },
  { n: 'POST title 带 HTML 标签',    f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ title: '<script>alert(1)</script>' }) }); } },
  { n: 'POST id 超长 500 字',        f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ id: 'x'.repeat(500), title: 'ok' }) }); } },
  { n: 'POST id 带空格',             f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ id: 'a b', title: 'ok' }) }); } },
  { n: 'POST id 带 SQL 注入',        f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ id: "' OR 1=1;--", title: 'ok' }) }); } },
  { n: 'POST done=2（非法值）',      f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ title: 'ok', done: 2 }) }); } },
  { n: 'POST done=true（bool）',      f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ title: 'ok', done: true }) }); } },
  { n: 'POST done 缺 title',         f: function () { return items.main({ httpMethod: 'POST', body: JSON.stringify({ done: 1 }) }); } },

  // ── PATCH 畸形 ──
  { n: 'PATCH 空 body',              f: function () { return items.main({ httpMethod: 'PATCH', body: '', path: '/it-1' }); } },
  { n: 'PATCH 乱 body',              f: function () { return items.main({ httpMethod: 'PATCH', body: 'not json', path: '/it-1' }); } },
  { n: 'PATCH 改 id（不可改字段）',   f: function () { return items.main({ httpMethod: 'PATCH', body: JSON.stringify({ id: 'new-id' }), path: '/it-1' }); } },
  { n: 'PATCH 改 created_at',    f: function () { return items.main({ httpMethod: 'PATCH', body: JSON.stringify({ created_at: '2020-01-01T00:00:00.000Z' }), path: '/it-1' }); } },
  { n: 'PATCH title 超长',           f: function () { return items.main({ httpMethod: 'PATCH', body: JSON.stringify({ title: 'x'.repeat(5000) }), path: '/it-1' }); } },
  { n: 'PATCH done=5',f: function () { return items.main({ httpMethod: 'PATCH', body: JSON.stringify({ done: 5 }), path: '/it-1' }); } },
  { n: 'PATCH 不带 id',              f: function () { return items.main({ httpMethod: 'PATCH', body: JSON.stringify({ title: 'x' }) }); } },
  { n: 'PATCH id 带注入字符',        f: function () { return items.main({ httpMethod: 'PATCH', body: JSON.stringify({ title: 'x' }), path: "/'; DROP TABLE items--" }); } },
  { n: 'PATCH 超长 id',              f: function () { return items.main({ httpMethod: 'PATCH', body: JSON.stringify({ title: 'x' }), path: '/' + 'x'.repeat(500) }); } },

  // ── DELETE 畸形 ──
  { n: 'DELETE 不带 id',             f: function () { return items.main({ httpMethod: 'DELETE' }); } },
  { n: 'DELETE id 带空格',           f: function () { return items.main({ httpMethod: 'DELETE', path: '/a b' }); } },
  { n: 'DELETE id 带注入字符',       f: function () { return items.main({ httpMethod: 'DELETE', path: "/' OR '1'='1" }); } },
  { n: 'DELETE 超长 id',             f: function () { return items.main({ httpMethod: 'DELETE', path: '/' + 'x'.repeat(500) }); } },

  // ── 方法 / 其它 ──
  { n: 'TRACE（不在白名单）',         f: function () { return items.main({ httpMethod: 'TRACE' }); } },
  { n: 'PROPFIND（WebDAV）',         f: function () { return items.main({ httpMethod: 'PROPFIND' }); } },
  { n: 'httpMethod 全空（= 按 GET 处理，合法）', f: function () { return items.main({}); }, expect200: true },
  { n: 'httpMethod 是乱串',          f: function () { return items.main({ httpMethod: 'FOOBAR' }); } },
  { n: 'event 整个是 null',          f: function () { return items.main(null); } },
  { n: 'event 是 undefined',         f: function () { return items.main(undefined); } }
];

// ═══════════════ reminders ═══════════════
var remCases = [
  { n: 'rem GET date 畸形',          f: function () { return reminders.main({ httpMethod: 'GET', queryStringParameters: { date: 'x/y' } }); } },
  { n: 'rem GET limit=99999',        f: function () { return reminders.main({ httpMethod: 'GET', queryStringParameters: { limit: '99999' } }); } },
  { n: 'rem POST 空 body',           f: function () { return reminders.main({ httpMethod: 'POST' }); } },
  { n: 'rem POST 乱 body',           f: function () { return reminders.main({ httpMethod: 'POST', body: '{{{' }); } },
  { n: 'rem POST title 超长',        f: function () { return reminders.main({ httpMethod: 'POST', body: JSON.stringify({ title: 'x'.repeat(5000), remind_at: '2026-10-09T10:00:00.000Z' }) }); } },
  { n: 'rem POST remind_at 畸形',    f: function () { return reminders.main({ httpMethod: 'POST', body: JSON.stringify({ title: 'ok', remind_at: '明天' }) }); } },
  { n: 'rem POST 改 item_id 注入',   f: function () { return reminders.main({ httpMethod: 'POST', body: JSON.stringify({ title: 'ok', remind_at: '2026-10-09T10:00:00.000Z', item_id: "' OR 1=1" }) }); } },
  { n: 'rem POST 改 id 注入',        f: function () { return reminders.main({ httpMethod: 'POST', body: JSON.stringify({ id: "'; DELETE FROM items;--", title: 'ok', remind_at: '2026-10-09T10:00:00.000Z' }) }); } },
  { n: 'rem 405（POST 不支持）',     f: function () { return reminders.main({ httpMethod: 'PATCH' }); } },
  { n: 'rem event null',             f: function () { return reminders.main(null); } }
];

(async function () {
  var all = [{ fn: 'items', cases: itemCases }, { fn: 'reminders', cases: remCases }];
  for (var g = 0; g < all.length; g++) {
    var grp = all[g];
    console.log('\n===== ' + grp.fn + ' =====');
    for (var i = 0; i < grp.cases.length; i++) {
      fakeMode = 'ok';
      var r;
      try {
        r = await grp.cases[i].f();
      } catch (e) {
        console.log('  ✗ ' + grp.cases[i].n + ' → 函数自己抛异常了：' + (e && e.message));
        rows.push({ name: grp.fn + ' · ' + grp.cases[i].n, status: 'THROW', ok: false, probs: ['未捕获异常'], msg: String(e && e.message) });
        continue;
      }
      var row = judge(grp.fn + ' · ' + grp.cases[i].n, r, { expect200: grp.cases[i].expect200 });
      var mark = row.ok ? '✓' : '✗';
      console.log('  ' + mark + ' [' + String(row.status).padEnd(4) + '] ' + grp.cases[i].n);
      if (!row.ok) console.log('      问题: ' + row.probs.join(' | ') + '\n      文案: ' + row.msg);
    }
  }

  var bad = rows.filter(function (x) { return !x.ok; });
  console.log('\n========================================');
  console.log('共 ' + rows.length + ' 条非法输入，合格 ' + (rows.length - bad.length) + '，有问题 ' + bad.length);
  if (bad.length) {
    console.log('\n有问题的：');
    bad.forEach(function (b) { console.log('  - [' + b.status + '] ' + b.name + ' → ' + b.probs.join(' | ')); });
  }
})();