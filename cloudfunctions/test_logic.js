// cloudfunctions/test_logic.js · Day 17 本地逻辑测试
// ---------------------------------------------------------------------------
// 为什么要有这个：云函数部署一次要 Henry 手动在控制台点五六步，
// 「改一行 → 部署 → 发现拼错了一个查询参数」的循环太贵。
// 所以把不依赖真实网络的逻辑（方法守卫、参数校验、查询串拼接、信封形状、错误处理）
// 全部拉到本地跑：把 https.request 换成假的，捕获它想发的请求，再喂假响应。
//
// 跑法（在本机，不需要 CloudBase）：
//   node cloudfunctions/test_logic.js
//
// 注意：这个测试**不验证真实数据库**，只验证「函数逻辑对不对」。
// 真实链路靠部署后 curl 公网地址来验。
'use strict';

var EventEmitter = require('events').EventEmitter;
var https = require('https');
var path = require('path');

// ① 假的网络层。捕获请求参数，然后按 fakeStatus / fakeBody 回一个响应。
var captured = null;
var fakeStatus = 200;
var fakeBody = '[]';

https.request = function (opts, cb) {
  captured = opts;
  var req = new EventEmitter();
  req.end = function () {
    // 异步回：index.js 是先注册 res.on('data'/'end')、再 end()，顺序不能反。
    process.nextTick(function () {
      var res = new EventEmitter();
      res.statusCode = fakeStatus;
      cb(res);
      process.nextTick(function () {
        res.emit('data', Buffer.from(fakeBody, 'utf8'));
        res.emit('end');
      });
    });
  };
  req.destroy = function () {};
  return req;
};

var passed = 0;
var failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (detail ? '  →  ' + detail : ''));
  }
}

function body(ev) {
  try {
    return JSON.parse(ev.body);
  } catch (e) {
    return null;
  }
}

var ENV_HOST = 'habit-checkin-d9giln6ke6594e88b.api.tcloudbasegateway.com';
var items = require(path.join(__dirname, 'items', 'index.js'));
var reminders = require(path.join(__dirname, 'reminders', 'index.js'));

(async function () {
  console.log('\n=== /api/items ===');

  // ---- 1. 方法守卫 ----
  var r = await items.main({ httpMethod: 'POST' });
  check('POST 被挡（405）', r.statusCode === 405, '实际 ' + r.statusCode);
  check('405 的错误码是 BAD_REQUEST', body(r).error.code === 'BAD_REQUEST', JSON.stringify(body(r)));

  // ---- 2. 缺 API Key 时给出可操作的报错 ----
  delete process.env.CLOUDBASE_APIKEY;
  delete process.env.CLOUDBASE_API_KEY;
  delete process.env.TCB_API_KEY;
  delete process.env.API_KEY;
  r = await items.main({ httpMethod: 'GET' });
  check('没配 API Key → 500 CONFIG_MISSING', r.statusCode === 500 && body(r).error.code === 'CONFIG_MISSING', JSON.stringify(body(r)));
  check('报错里说了该配哪个变量名', /CLOUDBASE_APIKEY/.test(body(r).error.message), body(r).error.message);
  check('报错里不带任何密钥值', !/test-key/.test(body(r).error.message));

  process.env.CLOUDBASE_APIKEY = 'test-key';

  // ---- 3. 参数校验 ----
  r = await items.main({ httpMethod: 'GET', queryStringParameters: { date: '2026/10/02' } });
  check('date 格式不对 → 400', r.statusCode === 400 && body(r).error.code === 'BAD_REQUEST', JSON.stringify(body(r)));

  r = await items.main({ httpMethod: 'GET', queryStringParameters: { limit: 'abc' } });
  check('limit 非数字 → 400', r.statusCode === 400, JSON.stringify(body(r)));

  r = await items.main({ httpMethod: 'GET', queryStringParameters: { limit: '0' } });
  check('limit=0 → 400', r.statusCode === 400, JSON.stringify(body(r)));

  r = await items.main({ httpMethod: 'GET', queryStringParameters: { limit: '201' } });
  check('limit=201 超上限 → 400', r.statusCode === 400, JSON.stringify(body(r)));

  // ---- 4. 正常请求：请求长什么样 ----
  captured = null;
  fakeStatus = 200;
  fakeBody = JSON.stringify([
    { id: 'seed-item-01', title: '读一章书', plan_date: '2026-10-02', done: 0, created_at: '2026-10-02T00:00:00Z', done_at: null }
  ]);
  r = await items.main({ httpMethod: 'GET', queryStringParameters: { date: '2026-10-02', limit: '5' } });

  check('成功 → 200', r.statusCode === 200, '实际 ' + r.statusCode);
  var b = body(r);
  check('信封是 { ok:true, data:[...] }', b.ok === true && Array.isArray(b.data) && b.data.length === 1, JSON.stringify(b));
  check('data 里是数据库列名（plan_date 而不是 date）', b.data[0].plan_date === '2026-10-02', JSON.stringify(b.data[0]));
  check('打的是本环境的网关域名', captured.hostname === ENV_HOST, captured && captured.hostname);
  check('路径指向 items 表', captured.path.indexOf('/v1/rdb/rest/items?') === 0, captured.path);
  check('查询串含 select=*', captured.path.indexOf('select=*') >= 0, captured.path);
  check('date 过滤拼成 plan_date=eq.2026-10-02', captured.path.indexOf('plan_date=eq.2026-10-02') >= 0, captured.path);
  check('排序拼进去了', captured.path.indexOf('order=plan_date.asc%2Ccreated_at.asc') >= 0, captured.path);
  check('limit 拼进去了', captured.path.indexOf('limit=5') >= 0, captured.path);
  check('带上了 Bearer 鉴权头', captured.headers.Authorization === 'Bearer test-key', JSON.stringify(captured.headers));
  check('响应头带 X-Version 探针', r.headers['X-Version'] === 'day17', JSON.stringify(r.headers));
  check('响应头允许跨域', r.headers['Access-Control-Allow-Origin'] === '*');

  // ---- 5. 不传 limit 时用默认 100 ----
  captured = null;
  await items.main({ httpMethod: 'GET', queryStringParameters: {} });
  check('不传 limit → 默认 100', captured.path.indexOf('limit=100') >= 0, captured.path);

  // ---- 6. queryString 原始串也能解析（兼容另一种 event 形状）----
  captured = null;
  await items.main({ httpMethod: 'GET', queryString: 'date=2026-10-03&limit=7' });
  check('queryString 原始串也能解析', captured.path.indexOf('plan_date=eq.2026-10-03') >= 0 && captured.path.indexOf('limit=7') >= 0, captured.path);

  // ---- 7. 上游报错 → UPSTREAM，不把裸 502 抛给前端 ----
  fakeStatus = 401;
  fakeBody = '{"code":"MISSING_CREDENTIALS"}';
  r = await items.main({ httpMethod: 'GET' });
  check('上游 401 → 500 UPSTREAM', r.statusCode === 500 && body(r).error.code === 'UPSTREAM', JSON.stringify(body(r)));
  check('UPSTREAM 消息里带上状态码', /401/.test(body(r).error.message), body(r).error.message);

  fakeStatus = 200;
  fakeBody = '<html>不是 JSON</html>';
  r = await items.main({ httpMethod: 'GET' });
  check('上游返回非 JSON → UPSTREAM', body(r).error.code === 'UPSTREAM' && /不是 JSON/.test(body(r).error.message), JSON.stringify(body(r)));

  console.log('\n=== /api/reminders ===');

  fakeBody = JSON.stringify([{ id: 'seed-rem-05', item_id: null, title: '高铁去上海', remind_at: '2026-10-05T01:00:00Z', lead_minutes: 60, done: 0 }]);
  fakeStatus = 200;

  r = await reminders.main({ httpMethod: 'POST' });
  check('POST 被挡（405）', r.statusCode === 405);

  captured = null;
  r = await reminders.main({ httpMethod: 'GET', queryStringParameters: { item_id: 'seed-item-02', limit: '3' } });
  check('成功 → 200', r.statusCode === 200, '实际 ' + r.statusCode);
  check('信封 { ok:true, data:[...] }', body(r).ok === true && body(r).data.length === 1);
  check('路径指向 reminders 表', captured.path.indexOf('/v1/rdb/rest/reminders?') === 0, captured.path);
  check('item_id 过滤拼成 item_id=eq.seed-item-02', captured.path.indexOf('item_id=eq.seed-item-02') >= 0, captured.path);
  check('按 remind_at 升序', captured.path.indexOf('order=remind_at.asc') >= 0, captured.path);
  check('limit 生效', captured.path.indexOf('limit=3') >= 0, captured.path);
  check('独立提醒（item_id 为 null）不会被过滤掉', body(r).data[0].item_id === null, JSON.stringify(body(r).data[0]));

  captured = null;
  await reminders.main({ httpMethod: 'GET', queryStringParameters: {} });
  check('不传 item_id 时不过滤', captured.path.indexOf('item_id=') < 0, captured.path);

  r = await reminders.main({ httpMethod: 'GET', queryStringParameters: { item_id: new Array(80).join('x') } });
  check('item_id 超长 → 400', r.statusCode === 400, JSON.stringify(body(r)));

  delete process.env.CLOUDBASE_APIKEY;
  r = await reminders.main({ httpMethod: 'GET' });
  check('reminders 也检查 API Key', body(r).error.code === 'CONFIG_MISSING', JSON.stringify(body(r)));

  console.log('\n---------------------------------------------');
  console.log((failed === 0 ? 'ALL PASS' : 'FAILED') + '：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
})();
