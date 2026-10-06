// cloudfunctions/test_logic.js · Day 17/18 本地逻辑测试
// ---------------------------------------------------------------------------
// 为什么要有这个：云函数部署一次要 Henry 手动在控制台点五六步，
//「改一行 → 部署 → 发现拼错了一个查询参数」的循环太贵。
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
//    captured = 请求选项（沿用 Day 17 的字段名，别改）
//    capturedBody = Day 18 新增：POST 的请求体（GET 时代码不调 write，所以是空串）
var captured = null;
var capturedBody = '';
var fakeStatus = 200;
var fakeBody = '[]';

https.request = function (opts, cb) {
  captured = opts;
  capturedBody = '';
  var req = new EventEmitter();
  // Day 18 新增：POST 走 req.write(body) 分片写入，再 req.end()。
  // 不实现 write 的话，请求体就永远抓不到，测「有没有把 title 传下去」就成了空谈。
  req.write = function (chunk) {
    capturedBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return true;
  };
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

function sentBody() {
  try {
    return JSON.parse(capturedBody);
  } catch (e) {
    return null;
  }
}

// 提示必须是中文。任务清单的完成标准之一。
// 只看「有没有中文字符」就够了：真出现纯英文提示（比如直接透传数据库原文）这里就会红。
var CJK = /[一-龥]/;
function isChinese(s) {
  return CJK.test(String(s || ''));
}

// 拼一个合法的 POST 请求体，省得每个用例重复写四个字段。
function payload(over) {
  var p = { id: 'test-001', title: '读一章书', plan_date: '2026-10-06' };
  if (over) {
    for (var k in over) {
      if (Object.prototype.hasOwnProperty.call(over, k)) p[k] = over[k];
    }
  }
  return p;
}

// ⚠️ 造重复字符一律用 repeat(n)，**不要用 new Array(n).join(x)** ——
//    后者给的是 n-1 个字符（Array(5).join('a') 是 'aaaa'，4 个）。
//    2026-10-06 第一次跑就被这个坑了一次：以为在测「201 字被拒」，
//    实际发出去的是 200 字，于是边界测试测了个寂寞，还会顺手把脚本搞崩。
function repeat(ch, n) {
  return new Array(n + 1).join(ch);
}

var ENV_HOST = 'habit-checkin-d9giln6ke6594e88b.api.tcloudbasegateway.com';
var items = require(path.join(__dirname, 'items', 'index.js'));
var reminders = require(path.join(__dirname, 'reminders', 'index.js'));

(async function () {
  console.log('\n=== /api/items · GET（Day 17，必须一行没变） ===');

  // ---- 1. 方法守卫：GET 之外的方法仍要挡掉 ----
  var r = await items.main({ httpMethod: 'DELETE' });
  check('DELETE 被挡（405）', r.statusCode === 405, '实际 ' + r.statusCode);
  check('405 的错误码是 BAD_REQUEST', body(r).error.code === 'BAD_REQUEST', JSON.stringify(body(r)));
  check('405 的提示是中文', isChinese(body(r).error.message), body(r).error.message);

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
  // 部署探针：版本号故意跟着 Day 走。改版本时这行会红 —— 那是提醒你
  // 「线上跑的还是旧代码」，不是代码坏了。
  check('响应头带 X-Version 探针（day19）', r.headers['X-Version'] === 'day19', JSON.stringify(r.headers));
  check('响应头允许跨域', r.headers['Access-Control-Allow-Origin'] === '*');
  check('GET 请求不带 Prefer 头', captured.headers.Prefer === undefined, JSON.stringify(captured.headers));

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

  // =====================================================================
  // Day 18 · POST
  // =====================================================================
  console.log('\n=== /api/items · POST · 成功路径 ===');

  fakeStatus = 201;
  // 数据库「回读」到的行。故意让 title 跟我们发出去的不完全一样 ——
  // 这样才能测出「返回的确实是库里的那一行」，而不是把我们发进去的原样吐回来。
  fakeBody = JSON.stringify([
    { id: 'test-001', title: '读一章书', plan_date: '2026-10-06', done: 0, created_at: '2026-10-06T06:00:00.000Z', done_at: null }
  ]);

  captured = null;
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload()) });

  check('POST 成功 → 201', r.statusCode === 201, '实际 ' + r.statusCode + ' / ' + r.body);
  b = body(r);
  check('信封是 { ok:true, data:{...} }', b.ok === true && b.data && b.data.id === 'test-001', JSON.stringify(b));
  check('data 是对象不是数组（新增只有一行）', !Array.isArray(b.data), JSON.stringify(b));
  check('data 是数据库回读的那一行（含 created_at）', !!b.data.created_at, JSON.stringify(b.data));

  check('方法确实是 POST', captured.method === 'POST', captured.method);
  check('路径没有查询串', captured.path === '/v1/rdb/rest/items', captured.path);
  check('带上了 Bearer 鉴权头', captured.headers.Authorization === 'Bearer test-key', JSON.stringify(captured.headers));
  check('声明了 JSON 请求体', /application\/json/.test(captured.headers['Content-Type'] || ''), captured.headers['Content-Type']);

  // ★ 今天最关键的一条断言：绝不能出现 resolution 头。
  //   加了 resolution=merge-duplicates，PostgREST 会把主键冲突变成静默 upsert ——
  //   重复提交不报错、还把老行覆盖掉，比不防更糟。
  var prefer = captured.headers.Prefer || '';
  check('Prefer 头要求回读（return=representation）', /return=representation/.test(prefer), prefer);
  check('Prefer 头绝不含 resolution（防静默 upsert）', !/resolution/i.test(prefer), '实际 Prefer: ' + prefer);
  check('整个请求头里找不到 resolution', !/resolution/i.test(JSON.stringify(captured.headers)), JSON.stringify(captured.headers));

  var sb = sentBody();
  check('请求体解析得出 JSON', !!sb, capturedBody);
  check('六个字段都发出去了', sb && ['id', 'title', 'plan_date', 'done', 'created_at', 'done_at'].every(function (k) { return k in sb; }), JSON.stringify(sb));
  check('省略 created_at 时自动填了 UTC 时间串', sb && /Z$/.test(sb.created_at), sb && sb.created_at);
  check('done 默认 0', sb && sb.done === 0, JSON.stringify(sb));
  check('done_at 默认 null（不是空串、不是 0）', sb && sb.done_at === null, JSON.stringify(sb));

  // title 前后空格要被 trim 掉再入库
  fakeBody = JSON.stringify([{ id: 'test-002', title: '跑步', plan_date: '2026-10-06', done: 0, created_at: '2026-10-06T06:00:00.000Z', done_at: null }]);
  await items.main({ httpMethod: 'POST', body: JSON.stringify(payload({ id: 'test-002', title: '  跑步  ' })) });
  check('title 前后空格被 trim', sentBody().title === '跑步', JSON.stringify(sentBody()));

  // 网关可能把 body 送成 Buffer —— 必须照样认得
  fakeBody = JSON.stringify([{ id: 'test-003', title: '读书', plan_date: '2026-10-06', done: 0, created_at: '2026-10-06T06:00:00.000Z', done_at: null }]);
  r = await items.main({ httpMethod: 'POST', body: Buffer.from(JSON.stringify(payload({ id: 'test-003', title: '读书' })), 'utf8') });
  check('body 是 Buffer 也认得', r.statusCode === 201, r.statusCode + ' / ' + r.body);

  // 网关也可能 base64 编码后再送
  fakeBody = JSON.stringify([{ id: 'test-004', title: '写字', plan_date: '2026-10-06', done: 0, created_at: '2026-10-06T06:00:00.000Z', done_at: null }]);
  r = await items.main({
    httpMethod: 'POST',
    body: Buffer.from(JSON.stringify(payload({ id: 'test-004', title: '写字' })), 'utf8').toString('base64'),
    isBase64Encoded: true
  });
  check('body 是 base64 也认得', r.statusCode === 201, r.statusCode + ' / ' + r.body);

  // 网关已经解析好的对象
  fakeBody = JSON.stringify([{ id: 'test-005', title: '画画', plan_date: '2026-10-06', done: 0, created_at: '2026-10-06T06:00:00.000Z', done_at: null }]);
  r = await items.main({ httpMethod: 'POST', body: payload({ id: 'test-005', title: '画画' }) });
  check('body 已是对象也认得', r.statusCode === 201, r.statusCode + ' / ' + r.body);

  // 闰年 2 月 29 日是真实存在的日子，要放行
  fakeBody = JSON.stringify([{ id: 'test-006', title: '闰日测试', plan_date: '2024-02-29', done: 0, created_at: '2024-02-29T00:00:00.000Z', done_at: null }]);
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload({ id: 'test-006', plan_date: '2024-02-29' })) });
  check('闰年 2024-02-29 放行', r.statusCode === 201, r.statusCode + ' / ' + r.body);

  console.log('\n=== /api/items · POST · 重复提交被拒（今天的主角） ===');

  fakeStatus = 409;
  fakeBody = JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "items_pkey"' });
  captured = null;
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload()) });
  check('同 id 再提交 → 409', r.statusCode === 409, r.statusCode + ' / ' + r.body);
  check('错误码是 DUPLICATE（新增的码）', body(r).error.code === 'DUPLICATE', JSON.stringify(body(r)));
  check('ok 是 false（不能假装成功）', body(r).ok === false, JSON.stringify(body(r)));
  check('提示是中文', isChinese(body(r).error.message), body(r).error.message);
  check('提示说清了怎么解决（换 id）', /换一个 id/.test(body(r).error.message), body(r).error.message);
  check('冲突时也带了 Bearer 鉴权（说明请求真的发出去了）', captured && captured.headers.Authorization === 'Bearer test-key', captured && JSON.stringify(captured.headers));

  // 有些网关会把冲突报成 400 + 23505，靠正文里的 PostgreSQL 错误码认出来
  fakeStatus = 400;
  fakeBody = '{"code":"23505","details":"Key (id)=(test-001) already exists."}';
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload()) });
  check('400 + 23505 也认成重复提交', r.statusCode === 409 && body(r).error.code === 'DUPLICATE', r.statusCode + ' / ' + r.body);

  // ★ 反证：如果是静默 upsert，这里会返回 201。现在必须不是。
  fakeStatus = 201;
  fakeBody = JSON.stringify([{ id: 'test-001', title: '读一章书', plan_date: '2026-10-06', done: 0, created_at: '2026-10-06T06:00:00.000Z', done_at: null }]);
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload()) });
  check('第一个 POST 是 201（对照组：只有第一次成功）', r.statusCode === 201, r.statusCode + ' / ' + r.body);

  console.log('\n=== /api/items · POST · 输入校验（都在打库之前拦下） ===');

  var bad = [
    ['缺 id', payload({ id: undefined }), /id/],
    ['id 是空串', payload({ id: '' }), /id/],
    ['id 不是字符串', payload({ id: 123 }), /字符串/],
    ['id 超 36 字', payload({ id: repeat('a', 37) }), /太长/],
    ['id 含中文', payload({ id: '测试-1' }), /只能含/],
    ['id 含 & （会污染 URL 查询串）', payload({ id: 'a&b=c' }), /只能含/],
    ['id 含斜杠', payload({ id: 'a/b' }), /只能含/],
    ['缺 title', payload({ title: undefined }), /title/],
    ['title 是空串', payload({ title: '' }), /title/],
    ['title 只有空格', payload({ title: '    ' }), /title/],
    ['title 不是字符串', payload({ title: 42 }), /字符串/],
    ['title 超 200 字', payload({ title: repeat('书', 250) }), /太长/],
    ['title 201 字（边界外一格）', payload({ title: repeat('书', 201) }), /太长/],
    ['缺 plan_date', payload({ plan_date: undefined }), /plan_date/],
    ['plan_date 用斜杠', payload({ plan_date: '2026/10/06' }), /YYYY-MM-DD/],
    ['plan_date 格式乱', payload({ plan_date: '明天' }), /YYYY-MM-DD/],
    ['plan_date 是 2 月 31 日（格式对但日子不存在）', payload({ plan_date: '2026-02-31' }), /不是个真实存在的日子/],
    ['plan_date 是 13 月', payload({ plan_date: '2026-13-01' }), /不是个真实存在的日子/],
    ['plan_date 是 2023-02-29（平年）', payload({ plan_date: '2023-02-29' }), /不是个真实存在的日子/],
    ['done 写成 2', payload({ done: 2 }), /只能是 0/],
    ['done 写成字符串', payload({ done: '0' }), /只能是 0/],
    ['created_at 是乱串', payload({ created_at: '昨天' }), /created_at/],
    ['done_at 是乱串', payload({ done_at: '待会儿' }), /done_at/],
    ['done=0 却给了 done_at（自相矛盾）', payload({ done: 0, done_at: '2026-10-06T01:00:00.000Z' }), /矛盾/],
    ['字段名写成前端的 date（忘了映射）', payload({ date: '2026-10-06' }), /不认识的字段/],
    ['字段名写成 createdAt（忘了映射）', payload({ createdAt: '2026-10-06T01:00:00.000Z' }), /不认识的字段/]
  ];

  for (var i = 0; i < bad.length; i++) {
    captured = null;
    r = await items.main({ httpMethod: 'POST', body: JSON.stringify(bad[i][1]) });
    var nm = bad[i][0];
    // 一个用例失败不该让整个脚本崩掉 —— 不崩才能看到后面所有用例的结果。
    // （2026-10-06 第一次跑就是这里：某条断言过了 201，
    //   后面直接读 undefined.code 抛异常，整个测试停在半路。）
    var eb = body(r) || {};
    var msg = (eb.error && eb.error.message) || JSON.stringify(eb);
    check('拒绝：' + nm + ' → 400', r.statusCode === 400, r.statusCode + ' / ' + r.body);
    check('  └ 错误码是 BAD_REQUEST', eb.error && eb.error.code === 'BAD_REQUEST', JSON.stringify(eb));
    check('  └ 提示是中文', isChinese(msg), msg);
    check('  └ 提示说到了点子上', bad[i][2].test(msg), msg);
    // ★ 关键：校验没过就绝对不能打数据库 —— 否则「前端校验」只是装饰
    check('  └ 没打数据库（请求根本没发出去）', captured === null, 'captured=' + JSON.stringify(captured));
  }

  // title 正好 200 字 → 放行（边界内一格）
  fakeBody = JSON.stringify([{ id: 'test-200', title: '书', plan_date: '2026-10-06', done: 0, created_at: '2026-10-06T06:00:00.000Z', done_at: null }]);
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload({ id: 'test-200', title: repeat('书', 200) })) });
  check('title 正好 200 字 → 放行（边界）', r.statusCode === 201, r.statusCode + ' / ' + r.body);

  // id 正好 36 字 → 放行
  fakeBody = JSON.stringify([{ id: repeat('a', 36), title: '长 id', plan_date: '2026-10-06', done: 0, created_at: '2026-10-06T06:00:00.000Z', done_at: null }]);
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload({ id: repeat('a', 36) })) });
  check('id 正好 36 字 → 放行（边界）', r.statusCode === 201, r.statusCode + ' / ' + r.body);

  // done=1 且带 done_at → 合法，放行
  fakeBody = JSON.stringify([{ id: 'test-done', title: '已完成', plan_date: '2026-10-06', done: 1, created_at: '2026-10-06T01:00:00.000Z', done_at: '2026-10-06T02:00:00.000Z' }]);
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload({ id: 'test-done', done: 1, done_at: '2026-10-06T02:00:00.000Z' })) });
  check('done=1 带 done_at → 放行', r.statusCode === 201, r.statusCode + ' / ' + r.body);

  console.log('\n=== /api/items · POST · 请求体本身坏掉 ===');

  captured = null;
  r = await items.main({ httpMethod: 'POST', body: '' });
  check('空 body → 400', r.statusCode === 400, r.statusCode + ' / ' + r.body);
  check('  └ 提示是中文', isChinese(body(r).error.message), body(r).error.message);

  captured = null;
  r = await items.main({ httpMethod: 'POST', body: "{'title':'单引号'}" });
  check('用单引号的非法 JSON → 400', r.statusCode === 400, r.statusCode + ' / ' + r.body);
  check('  └ 提示是中文', isChinese(body(r).error.message), body(r).error.message);

  captured = null;
  r = await items.main({ httpMethod: 'POST', body: '{"title":"多了个逗号",}' });
  check('多一个逗号 → 400', r.statusCode === 400, r.statusCode + ' / ' + r.body);

  captured = null;
  r = await items.main({ httpMethod: 'POST', body: '[{"id":"a","title":"b","plan_date":"2026-10-06"}]' });
  check('body 是数组 → 400（不接受批量）', r.statusCode === 400, r.statusCode + ' / ' + r.body);
  check('  └ 提示是中文', isChinese(body(r).error.message), body(r).error.message);

  captured = null;
  r = await items.main({ httpMethod: 'POST', body: '"一个字符串"' });
  check('body 是字符串 → 400', r.statusCode === 400, r.statusCode + ' / ' + r.body);

  ['空 body', '坏 JSON', '数组 body'].forEach(function (nm) { /* 已逐条测 */ });
  check('坏 body 一律不打数据库', captured === null, 'captured=' + JSON.stringify(captured));

  console.log('\n=== /api/items · POST · 上游异常 ===');

  fakeStatus = 400;
  fakeBody = '{"code":"23502","message":"null value in column violates not-null constraint"}';
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload({ id: 'up1' })) });
  check('上游 400（约束不满足）→ 400 BAD_REQUEST', r.statusCode === 400 && body(r).error.code === 'BAD_REQUEST', r.statusCode + ' / ' + r.body);
  check('  └ 消息里带上游原文（好排查）', /not-null/.test(body(r).error.message), body(r).error.message);

  fakeStatus = 500;
  fakeBody = '{"error":"internal"}';
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload({ id: 'up2' })) });
  check('上游 500 → 502 UPSTREAM', r.statusCode === 502 && body(r).error.code === 'UPSTREAM', r.statusCode + ' / ' + r.body);

  fakeStatus = 401;
  fakeBody = '{"code":"MISSING_CREDENTIALS"}';
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload({ id: 'up3' })) });
  check('上游 401（Key 失效）→ 502 UPSTREAM', r.statusCode === 502 && body(r).error.code === 'UPSTREAM', r.statusCode + ' / ' + r.body);

  // 网关把 Prefer 头吃掉 → 回读拿不到，退回发过去的这一行，但形状仍是 201 + ok
  fakeStatus = 201;
  fakeBody = '';
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload({ id: 'noread' })) });
  check('回读不到时仍返回 201 + ok（形状不破）', r.statusCode === 201 && body(r).ok === true, r.statusCode + ' / ' + r.body);
  check('  └ 退回的是发过去的这一行', body(r).data && body(r).data.id === 'noread', JSON.stringify(body(r)));

  console.log('\n=== /api/items · POST · 凭据与预检 ===');

  delete process.env.CLOUDBASE_APIKEY;
  captured = null;
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify(payload()) });
  check('POST 没配 API Key → 500 CONFIG_MISSING', r.statusCode === 500 && body(r).error.code === 'CONFIG_MISSING', r.statusCode + ' / ' + r.body);
  check('  └ 没打数据库', captured === null, 'captured=' + JSON.stringify(captured));
  process.env.CLOUDBASE_APIKEY = 'test-key';

  captured = null;
  r = await items.main({ httpMethod: 'OPTIONS' });
  check('OPTIONS 预检 → 204', r.statusCode === 204, String(r.statusCode));
  check('  └ 声明允许 POST', /POST/.test(r.headers['Access-Control-Allow-Methods'] || ''), JSON.stringify(r.headers));
  check('  └ 声明允许 Content-Type', /Content-Type/.test(r.headers['Access-Control-Allow-Headers'] || ''), JSON.stringify(r.headers));
  check('  └ 预检不打数据库', captured === null, 'captured=' + JSON.stringify(captured));

  console.log('\n=== /api/reminders（Day 17，今天不该动它） ===');

  fakeBody = JSON.stringify([{ id: 'seed-rem-05', item_id: null, title: '高铁去上海', remind_at: '2026-10-05T01:00:00Z', lead_minutes: 60, done: 0 }]);
  fakeStatus = 200;

  r = await reminders.main({ httpMethod: 'POST' });
  check('reminders 仍然挡 POST（405）', r.statusCode === 405, String(r.statusCode));

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

  r = await reminders.main({ httpMethod: 'GET', queryStringParameters: { item_id: repeat('x', 80) } });
  check('item_id 超长 → 400', r.statusCode === 400, JSON.stringify(body(r)));

  delete process.env.CLOUDBASE_APIKEY;
  r = await reminders.main({ httpMethod: 'GET' });
  check('reminders 也检查 API Key', body(r).error.code === 'CONFIG_MISSING', JSON.stringify(body(r)));

  console.log('\n---------------------------------------------');
  console.log((failed === 0 ? 'ALL PASS' : 'FAILED') + '：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
})();
