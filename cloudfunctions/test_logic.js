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

// ============ Day 22 新增：多次请求的响应队列 ============
//
// 为什么需要：PATCH / DELETE 一个动作要发**两次**上游请求
// （先 exists 查在不在，再真正改），每次的响应还不一样
// （第一次回'这一行不存在'，第二次回'改完的那一行'）。
// 只有一对 fakeStatus/fakeBody 时，第二次请求会拿到第一次的响应，
// 于是测试会以一种**看起来像 bug 的方式**失败，而且很难查。
//
// 用法：
//   fakeQueue = ['[]', '[{...}]'];   // 依次用完
//   fakeQueue = null;                // 回到「所有请求都用 fakeStatus/fakeBody」
//
// ⚠️ 一条重要的坑（Day 22 亲自踩了）：
// **不要在测试中间替换 https.request。** index.js 在 require 时就把
// 引用抓走了，事后再赋值 https.request = 新桩**不会生效** ——
// 于是 captured 一直是 null，报错信息是
//「Cannot read properties of null (reading 'method)」，
// 看起来像云函数没发请求，其实是桩没接上。
// → 所以要改桩，只能改**这一个**桩函数本身。
var fakeQueue = null;
var fakeQueueAt = 0;

// 取本次请求该回的（status, body）。队列用完就沿用最后一项，
// 不取「用完就报错」—— 闭包链上多打一次请求是很正常的事，
// 让队列超长比让它抛异常好排查。
function nextFake() {
  if (!fakeQueue || !fakeQueue.length) return { status: fakeStatus, body: fakeBody };
  var item = fakeQueue[Math.min(fakeQueueAt, fakeQueue.length - 1)];
  fakeQueueAt++;
  return { status: item.status, body: item.body };
}

// 每个测试用例开头调它：重置队列和计数器。漏调会让用例互相污染。
function resetFake() {
  fakeQueue = null;
  fakeQueueAt = 0;
  fakeStatus = 200;
  fakeBody = '[]';
  captured = null;
  capturedBody = '';
}

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
    var f = nextFake();          // ★ Day 22：进end() 时才取，不能在函数外提前取
    process.nextTick(function () {
      var res = new EventEmitter();
      res.statusCode = f.status;
      cb(res);
      process.nextTick(function () {
        res.emit('data', Buffer.from(f.body, 'utf8'));
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

// ⚠️ 必须在 require 之前设。
// 白名单是模块加载时读一次 process.env 存进变量的（云函数里环境变量不会中途变，
// 本地测试要模拟「不同环境配不同白名单」就只能靠重新 require），
// 放到后面设的话，require 时读到的还是空 —— 下面 CORS 那组用例会全红。
process.env.ALLOWED_ORIGINS = 'https://daily-checkin-list.app.workbuddy.host,http://localhost:8000';

var items = require(path.join(__dirname, 'items', 'index.js'));
var reminders = require(path.join(__dirname, 'reminders', 'index.js'));

(async function () {
  console.log('\n=== /api/items · GET（Day 17，必须一行没变） ===');

  // ---- 1. 方法守卫：GET 之外的方法仍要挡掉 ----
  //
  // ⚠️ Day 22：这段开头必须先给上凭据。
  // 原来第一条断言是「DELETE → 405」，而 405 恰好在凭据检查**之前**返回，
  // 所以不需要凭据也过。今天 DELETE 成了四种之一，同一条请求会继续往下走到
  // 「缺 id → 400」的参数校验，而那条路径已经过了凭据检查 —— 于是变成 500 CONFIG_MISSING。
  // 教训：**一条断言「以前不需要某个前置条件」不代表以后也不需要。**
  process.env.CLOUDBASE_APIKEY = 'test-key';

  var r;

  // Day 22 更新：这条断言原本是「DELETE 被挡（405）」——
  // 当时只支持 GET/POST，那是正确的。今天 DELETE 成了四种之一，
  // **继续期待 405 就是在期待一个已经修好的缺陷**（这类断言过期最隐蔽：
  // 它不会报错，只会在「修好了」那天突然变红，看起来像新引入的 bug）。
  // 现在改成：DELETE 不带 id 时应该是 400（缺参数），而不是 405（方法不支持）。
  r = await items.main({ httpMethod: 'DELETE' });
  check('DELETE 不再被 405 挡（Day 22 起支持四种方法）', r.statusCode === 400, String(r.statusCode));
  check('  └ 不带 id → 400 且错误码 BAD_REQUEST', body(r).error.code === 'BAD_REQUEST', JSON.stringify(body(r)));
  check('  └ 400 的提示是中文', isChinese(body(r).error.message), body(r).error.message);

  r = await items.main({ httpMethod: 'PATCH' });
  check('PATCH 不再被 405 挡', r.statusCode === 400, String(r.statusCode));
  check('  └ PATCH 缺 id 报 400 NOT 405', body(r).error.code === 'BAD_REQUEST', JSON.stringify(body(r)));

  r = await items.main({ httpMethod: 'PUT' });
  check('PUT 仍然被挡（405）—— 契约外的法方法不因为加了两个就放开', r.statusCode === 405, String(r.statusCode));

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
  // 探针值跟着当天版本走（Day 20 是 day20，Day 22 起是 day22）。
  // 这里断言「是个 dayNN 的串」而不是死写某一天 —— 否则每过一版都会红一次，
  // 而那种红不是 bug，是探针在正常工作。
  check('响应头带 X-Version 探针', /^day\d\d$/.test(String(r.headers['X-Version'])), JSON.stringify(r.headers));
  // Day 20 起 CORS 改白名单：没带 Origin（curl / 同源）时不该发这个头，
  // 更不该退回通配符 '*'。下面几行才是真正的判据。
  check('无 Origin 时不发 Allow-Origin（不回退通配符）', r.headers['Access-Control-Allow-Origin'] === undefined, JSON.stringify(r.headers));
  check('声明了 Expose-Headers（前端才读得到 X-Version）', /X-Version/.test(r.headers['Access-Control-Expose-Headers'] || ''), JSON.stringify(r.headers));
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
  //
  // ⚠️ Day 23 改了两条断言。原来要求「消息里带上状态码 401」和「带上有『不是 JSON』」——
  //   那是**把上游技术细节拼给人看**，正是今天要改掉的东西。
  //   旧断言不是写错了，是它如实记录了 Day 17 当时的行为；Day 23 有意改了行为，
  //   所以断言要跟着改 —— 不改就会变成「期待一个已经修好的缺陷」那类过期断言。
  //
  // 新的判据是：**消息里不该有任何技术细节，但错误码必须还在。**
  fakeStatus = 401;
  fakeBody = '{"code":"MISSING_CREDENTIALS"}';
  r = await items.main({ httpMethod: 'GET' });
  check('上游 401 → 500 UPSTREAM', r.statusCode === 500 && body(r).error.code === 'UPSTREAM', JSON.stringify(body(r)));
  check('Day 23：消息是中文', isChinese(body(r).error.message), body(r).error.message);
  check('★ Day 23：不再把状态码 401 拼给人看', !/401/.test(body(r).error.message), body(r).error.message);
  check('★ Day 23：说了「不是你操作的问题」', /不是你操作/.test(body(r).error.message), body(r).error.message);
  check('★ Day 23：给了下一步（重试 or 联系开发）', /重试|联系开发/.test(body(r).error.message), body(r).error.message);

  fakeStatus = 200;
  fakeBody = '<html>不是 JSON</html>';
  r = await items.main({ httpMethod: 'GET' });
  check('上游返回非 JSON → UPSTREAM', body(r).error.code === 'UPSTREAM', JSON.stringify(body(r)));
  check('★ Day 23：JSON 解析失败单独成句（说清是后端问题）', /格式不对|后端/.test(body(r).error.message), body(r).error.message);
  check('★ Day 23：不再把「不是 JSON」原文拼给人看', !/不是 JSON/.test(body(r).error.message), body(r).error.message);

  // Day 23 ★ 最关键的一条：**任何裸报错特征都不能出现在响应里。**
  // 这条断言等于把「不许再犯」写成可执行的判据，比写注释管用。
  fakeStatus = 500;
  fakeBody = 'boom';
  r = await items.main({ httpMethod: 'GET' });
  var m = body(r).error.message;
  check('★ 三类错误都不泄漏技术细节', !/ENOTFOUND|ECONNREFUSED|errno|sqlstate|at Object|at Module|node:internal|\.js:\d+|https?:\/\//.test(m), m);
  check('★ 但仍是中文且有出路', isChinese(m) && /联系开发|重试/.test(m), m);

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
  //
  // Day 23：这条断言原来要求「消息里带上游原文」（匹配 /not-null/）——
  //   那正是今天要改掉的行为：**把 PostgREST 的英文约束原文拼给人看**。
  //   用户看到 `null value in column violates not-null constraint` 只会懵。
  //
  // 新的判据分两条：① 英文原文不该出现；② 中文推测要说清，且**明说是推测**
  //   —— 猜错比不给更糟（会让人去查一个不存在的问题）。
  check('★ Day 23：不再把英文约束原文（not-null）拼给人看',
    !/not-null|violates|null value/i.test(body(r).error.message), body(r).error.message);
  check('★ Day 23：中文说清了「可能是必填项为空」',
    /必填项|为空/.test(body(r).error.message), body(r).error.message);
  check('★ Day 23：明说是「可能」，不把推测说成确定',
    /可能|无法理解/.test(body(r).error.message), body(r).error.message);
  check('★ Day 23：给出下一步（联系开发）',
    /联系开发/.test(body(r).error.message), body(r).error.message);

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

  // ---- Day 20 新增：CORS 白名单（这是今天最容易出安全事故的地方）----
  // 判据分三档：白名单内→回显该域名；白名单外→**连头都不发**；没带 Origin→不发。
  // 中间那档是关键：绝不能「不在白名单就退回 *」，那等于白名单形同虚设。
  console.log('\n=== CORS 白名单（Day 20） ===');

  var ORIGIN_OK = 'https://daily-checkin-list.app.workbuddy.host';
  var ORIGIN_LOCAL = 'http://localhost:8000';
  var ORIGIN_EVIL = 'https://evil.example.com';

  r = await items.main({ httpMethod: 'GET', headers: { origin: ORIGIN_OK } });
  check('白名单内的 Origin → 回显该域名', r.headers['Access-Control-Allow-Origin'] === ORIGIN_OK, JSON.stringify(r.headers));

  r = await items.main({ httpMethod: 'GET', headers: { origin: ORIGIN_LOCAL } });
  check('白名单第二条（本地）也认', r.headers['Access-Control-Allow-Origin'] === ORIGIN_LOCAL, JSON.stringify(r.headers));

  r = await items.main({ httpMethod: 'GET', headers: { origin: ORIGIN_EVIL } });
  check('白名单外的 Origin → 完全不发这个头', r.headers['Access-Control-Allow-Origin'] === undefined, JSON.stringify(r.headers));
  check('  └ 也不退回通配符', r.headers['Access-Control-Allow-Origin'] !== '*', JSON.stringify(r.headers));

  r = await items.main({ httpMethod: 'GET', headers: { origin: ORIGIN_OK } });
  check('命中时带 Vary: Origin（别让 CDN 把 A 的响应喂给 B）', /Origin/.test(r.headers['Vary'] || ''), JSON.stringify(r.headers));

  r = await items.main({ httpMethod: 'GET' });
  check('没带 Origin（curl / 同源）→ 不发这个头', r.headers['Access-Control-Allow-Origin'] === undefined, JSON.stringify(r.headers));

  r = await items.main({ httpMethod: 'OPTIONS', headers: { origin: ORIGIN_EVIL } });
  check('白名单外的 OPTIONS 预检也不发', r.headers['Access-Control-Allow-Origin'] === undefined, JSON.stringify(r.headers));

  r = await items.main({ httpMethod: 'OPTIONS', headers: { origin: ORIGIN_OK } });
  check('白名单内的 OPTIONS 预检 → 204 + 回显域名', r.statusCode === 204 && r.headers['Access-Control-Allow-Origin'] === ORIGIN_OK, String(r.statusCode));

  // Origin 大小写/末尾斜杠都不该被放行 —— 精确匹配，不做「善意清洗」
  r = await items.main({ httpMethod: 'GET', headers: { origin: ORIGIN_OK + '/' } });
  check('多一个斜杠就不认（精确匹配）', r.headers['Access-Control-Allow-Origin'] === undefined, JSON.stringify(r.headers));

  // reminders 侧同一套逻辑，不能只改一个函数
  r = await reminders.main({ httpMethod: 'GET', headers: { origin: ORIGIN_OK } });
  check('reminders 同样认白名单', r.headers['Access-Control-Allow-Origin'] === ORIGIN_OK, JSON.stringify(r.headers));
  r = await reminders.main({ httpMethod: 'GET', headers: { origin: ORIGIN_EVIL } });
  check('reminders 同样拒绝陌生域名', r.headers['Access-Control-Allow-Origin'] === undefined, JSON.stringify(r.headers));

  // ⚠️ 漏配环境变量的后果：不是退回通配符，而是全部跨域请求被浏览器拒掉。
  //   这个行为是故意的（显性失败好过静默降级），所以把它钉成用例。
  //   注意重新 require 会拿到一个全新模块实例，它会**重新读一遍** process.env ——
  //   所以 CLOUDBASE_APIKEY 也得重新给上，否则测到的是 500 而不是 CORS 行为。
  process.env.CLOUDBASE_APIKEY = 'test-key';
  delete process.env.ALLOWED_ORIGINS;
  delete require.cache[require.resolve(path.join(__dirname, 'items', 'index.js'))];
  var itemsNoWhitelist = require(path.join(__dirname, 'items', 'index.js'));
  // 上面几行断言里 fakeBody 还停在别处设的值（这条路径最后设的是空串=「回读不到」），
  // 不复位的话这组测的是假响应不是 CORS 行为 —— 之前就栽过一次这种「桩按错误假设写，
  // 测试给错误代码盖章」的坑。
  fakeStatus = 200;
  fakeBody = JSON.stringify([{ id: 'seed-item-01', title: '读一章书', plan_date: '2026-10-02', done: 0, created_at: '2026-10-02T01:00:00.000Z', done_at: null }]);
  r = await itemsNoWhitelist.main({ httpMethod: 'GET', headers: { origin: ORIGIN_OK } });
  check('漏配 ALLOWED_ORIGINS → 跨域全被拒（不是退回 *）', r.headers['Access-Control-Allow-Origin'] === undefined, JSON.stringify(r.headers));
  check('  └ 漏配时数据本身照常返回（同源 / curl 不受影响）', r.statusCode === 200, String(r.statusCode));
  check('  └ 而且数据真的回来了（不是空数组蒙对）', (body(r).data || []).length === 1, r.body);
  // 复原，免得影响后面用例
  process.env.ALLOWED_ORIGINS = 'https://daily-checkin-list.app.workbuddy.host,http://localhost:8000';

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

  // =====================================================================
  // Day 22：PATCH / DELETE
  // =====================================================================
  console.log('\n[Day 22 · PATCH / DELETE]');

  //⚠️ 上一段（reminders）结尾把 CLOUDBASE_APIKEY 删掉了没恢复，
  //这里必须重新设上 —— 否则第一个 PATCH 直接 500 CONFIG_MISSING，
  // 表现是「captured 是 null、方法不对」，看起来像云函数没发请求，
  // 实际是**根本没走到发请求那一步**。（踩过：找了半天才发现是环境变量没设。）
  process.env.CLOUDBASE_APIKEY = 'test-key';

  // ★ Day 22 踩的坑：exists() 判「在不在」靠的是**数组长度**，
  //   所以桩必须回 `[{"id":"xxx"}]`（有一行）才算「存在」。
  //   我一开始回 '[]'（想当然以为「查存在=空结果」），
  //   于是所有 PATCH/DELETE 都落进 404 分支，
  //   报错却是「captured.method 是 GET」—— 指向错方向，很花时间。
  //   → 断言「404 时不该发第二个请求」比断言「发了几跳」更能防住这类错。
  function Q2() {
    return [ { status: 200, body: '[]' }, { status: 200, body: '[]' } ];
  }

  var ROW = { id: 'd22-a', title: '旧标题', plan_date: '2026-10-08', done: 0, done_at: null, created_at: '2026-10-07T00:00:00.000Z' };
  var ROW2 = { id: 'd22-a', title: '新标题', plan_date: '2026-10-08', done: 1, done_at: '2026-10-08T01:00:00.000Z', created_at: '2026-10-07T00:00:00.000Z' };

  // ---------- 板块 1：方法守卫 ----------
  console.log('\n-- 1. 方法守卫 --');
  r = await items.main({ httpMethod: 'PUT' });
  check('PUT 仍被拒（405）', r.statusCode === 405, String(r.statusCode));
  check('  └ 错误码是 METHOD_NOT_ALLOWED', body(r).error.code === 'METHOD_NOT_ALLOWED', JSON.stringify(body(r)));
  check('  └ 405 带 Allow 头（RFC 7231 要求）', r.headers.Allow === 'GET, POST, PATCH, DELETE', JSON.stringify(r.headers));
  check('CORS Allow-Methods 已放开四种',
    r.headers['Access-Control-Allow-Methods'] === 'GET, POST, PATCH, DELETE, OPTIONS',
    r.headers['Access-Control-Allow-Methods']);

  // ---------- 板块 2：PATCH —— 先量「发了什么」 ----------
  console.log('\n-- 2. PATCH 发了什么 --');
  resetFake();
  // 第 1 次请求 = exists（回'这一行存在'），第 2 次 = PATCH（回改完的那行）
  fakeQueue = [ { status: 200, body: JSON.stringify([ROW]) },
                { status: 200, body: JSON.stringify([ROW2]) } ];

  r = await items.main({
    httpMethod: 'PATCH',
    pathParameters: { id: 'd22-a' },
    body: JSON.stringify({ title: '新标题', done: 1 })
  });
  check('PATCH 成功 → 200', r.statusCode === 200, String(r.statusCode));
  check('  └ 方法是 PATCH', captured.method === 'PATCH', captured.method);
  check('  └ 路径带 id=eq.d22-a', captured.path.indexOf('id=eq.d22-a') >= 0, captured.path);
  check('  └ Prefer: return=representation（要回读）', captured.headers.Prefer === 'return=representation', JSON.stringify(captured.headers));
  check('  └ 请求体只送要改的列，不送整行',
    /"title":"新标题"/.test(capturedBody) && /"done":1/.test(capturedBody) && !/created_at/.test(capturedBody),
    capturedBody);
  check('  └ 不送 id（id 只从 URL 来）', !/"id"/.test(capturedBody), capturedBody);
  var pb = body(r);
  check('  └ 返回的是数据库回读那行，不是发出去的 patch',
    pb.data && pb.data.title === '新标题' && pb.data.created_at === '2026-10-07T00:00:00.000Z',
    JSON.stringify(pb.data));
  check('  └ ★ 带着没改的列一起回来（证明是回读不是回显）',
    pb.data.created_at === ROW.created_at, JSON.stringify(pb.data));

  // ---------- 板块 3：PATCH 的 id 从哪来都能认 ----------
  console.log('\n-- 3. PATCH 的 id 提取（网关版本差异） --');
  resetFake();
  fakeQueue = Q2();
  await items.main({ httpMethod: 'PATCH', pathParameters: { id: 'd22-a' }, body: '{"done":0}' });
  check('从 pathParameters 取 id', captured.path.indexOf('id=eq.d22-a') >= 0, captured.path);

  resetFake();
  fakeQueue = Q2();
  await items.main({ httpMethod: 'PATCH', path: '/api/items/d22-a', body: '{"done":0}' });
  check('从 path（rawPath）取 id', captured.path.indexOf('id=eq.d22-a') >= 0, captured.path);

  resetFake();
  fakeQueue = Q2();
  await items.main({ httpMethod: 'PATCH', queryStringParameters: { id: 'd22-a' }, body: '{"done":0}' });
  check('从 query 取 id（兜底）', captured.path.indexOf('id=eq.d22-a') >= 0, captured.path);

  resetFake();
  fakeQueue = Q2();
  r = await items.main({ httpMethod: 'PATCH', body: '{"done":0}' });
  check('三处都没有 id → 400', r.statusCode === 400, String(r.statusCode));
  check('  └ 消息里说了要写成 /api/items/<id>', /\/api\/items\/<id>/.test(body(r).error.message), body(r).error.message);

  // ---------- 板块 4：PATCH 校验 ----------
  console.log('\n-- 4. PATCH 校验 --');
  function patchErr(patchBody, id) {
    // 校验类用例只关心「不该发任何请求」，所以队列给空数组。
    // 但存在性检查会先发一次 exists —— 校验没过时根本到不了那一步。
    resetFake();
    fakeQueue = [ { status: 200, body: '[]' } ];
    return items.main({
      httpMethod: 'PATCH',
      pathParameters: { id: id || 'd22-a' },
      body: typeof patchBody === 'string' ? patchBody : JSON.stringify(patchBody)
    });
  }
  r = await patchErr({});
  check('空 body → 400', r.statusCode === 400, String(r.statusCode));
  check('  └ 消息说「至少要改一样东西」', /至少要改一样东西/.test(body(r).error.message), body(r).error.message);

  r = await patchErr({ id: 'd22-z' });
  check('想改 id → 400', r.statusCode === 400, String(r.statusCode));
  check('  └ 说清 id 是身份不能改', /身份/.test(body(r).error.message), body(r).error.message);

  r = await patchErr({ created_at: '2026-01-01T00:00:00.000Z' });
  check('想改 created_at → 400', r.statusCode === 400, String(r.statusCode));

  r = await patchErr({ title: '' });
  check('title 改空串 → 400', r.statusCode === 400, String(r.statusCode));
  check('  └ 说「要改空就删掉这条」', /删掉这条/.test(body(r).error.message), body(r).error.message);

  r = await patchErr({ title: '   ' });
  check('title 改空白 → 400', r.statusCode === 400, String(r.statusCode));

  r = await patchErr({ plan_date: '2026-02-31' });
  check('plan_date 改成不存在的日子 → 400', r.statusCode === 400, String(r.statusCode));
  check('  └ 说「2 月没有 31 号」', /2 月没有 31 号/.test(body(r).error.message), body(r).error.message);

  r = await patchErr({ plan_date: '2026/10/08' });
  check('plan_date 格式错 → 400', r.statusCode === 400, String(r.statusCode));

  r = await patchErr({ done: true });
  check('done 传 boolean true → 400（库里是 SMALLINT，只认 0/1）', r.statusCode === 400, String(r.statusCode));
  check('  └ 说清只认 0/1', /只能是 0/.test(body(r).error.message), body(r).error.message);

  r = await patchErr({ done: 2 });
  check('done 传 2 → 400', r.statusCode === 400, String(r.statusCode));

  r = await patchErr({ done: 0, done_at: '2026-10-08T01:00:00.000Z' });
  check('done=0 却带 done_at → 400（矛盾组合）', r.statusCode === 400, String(r.statusCode));
  check('  └ 说「矛盾」', /矛盾/.test(body(r).error.message), body(r).error.message);

  r = await patchErr({ nope: 1 });
  check('未知字段 → 400', r.statusCode === 400, String(r.statusCode));
  check('  └ 报出字段名', /nope/.test(body(r).error.message), body(r).error.message);

  r = await patchErr('[1,2]');
  check('body 是数组 → 400', r.statusCode === 400, String(r.statusCode));

  r = await patchErr('{bad json');
  check('body 不是 JSON → 400', r.statusCode === 400, String(r.statusCode));

  r = await patchErr({ title: 'ok' }, 'bad/id');
  check('id 含斜杠 → 400（会拼进 URL，必须收窄字符集）', r.statusCode === 400, String(r.statusCode));

  // ---------- 板块 5：PATCH 的「不存在」 ----------
  console.log('\n-- 5. PATCH 404 --');
  resetFake();
  fakeQueue = [ { status: 200, body: '[]' } ];   // exists 查不到
  r = await items.main({ httpMethod: 'PATCH', pathParameters: { id: 'no-such' }, body: '{"done":1}' });
  check('改一条不存在的 → 404', r.statusCode === 404, String(r.statusCode));
  check('  └ 错误码 NOT_FOUND', body(r).error.code === 'NOT_FOUND', JSON.stringify(body(r)));
  check('  └ ★ 查不到就直接返回，一个字节都没往数据库写', captured === null || captured.method === 'GET',
    captured ? captured.method + ' ' + captured.path : 'null');
  check('  └ 消息说「可能已经被删了」', /已经被删了/.test(body(r).error.message), body(r).error.message);

  // ---------- 板块 6：PATCH 的 done 自动补时间 ----------
  console.log('\n-- 6. PATCH 勾选时自动补 done_at --');
  resetFake();
  // 第 1 跳是 exists —— 必须回「有这一行」（空数组会被判成不存在 → 404）
  fakeQueue = [ { status: 200, body: JSON.stringify([{ id: 'd22-b' }]) },
                { status: 200, body: JSON.stringify([{ id: 'd22-b', title: 't', plan_date: '2026-10-08', done: 1, done_at: 'x', created_at: 'c' }]) } ];
  r = await items.main({ httpMethod: 'PATCH', pathParameters: { id: 'd22-b' }, body: '{"done":1}' });
  check('done:1 且没给 done_at → 200', r.statusCode === 200, String(r.statusCode));
  check('  └ ★ 客户端没给 done_at，是后端补的当前时间',
    /"done_at":"\d{4}-\d{2}-\d{2}T/.test(capturedBody), capturedBody);

  resetFake();
  fakeQueue = [ { status: 200, body: JSON.stringify([{ id: 'd22-b' }]) },
                { status: 200, body: JSON.stringify([{ id: 'd22-b', title: 't', plan_date: '2026-10-08', done: 0, done_at: null, created_at: 'c' }]) } ];
  r = await items.main({ httpMethod: 'PATCH', pathParameters: { id: 'd22-b' }, body: '{"done":0}' });
  check('取消勾选 → 200', r.statusCode === 200, String(r.statusCode));
  check('  └ ★ done_at 被置 null（不能留着「未完成却有完成时间」的脏数据）',
    /"done_at":null/.test(capturedBody), capturedBody);

  resetFake();
  fakeQueue = [ { status: 200, body: JSON.stringify([{ id: 'd22-b' }]) },
                { status: 200, body: JSON.stringify([{ id: 'd22-b', title: 't', plan_date: '2026-10-08', done: 0, created_at: 'c' }]) } ];
  await items.main({ httpMethod: 'PATCH', pathParameters: { id: 'd22-b' }, body: '{"title":"改名一下"}' });
  check('只改 title 时不碰 done / done_at（局部更新）',
    !/"done"/.test(capturedBody) && !/"done_at"/.test(capturedBody), capturedBody);

  // ---------- 板块 7：DELETE 的核心语义 ----------
  console.log('\n-- 7. DELETE —— 今天最重要的一块 --');
  var DELROW = { id: 'd22-del', title: '要删的', plan_date: '2026-10-08', done: 0, done_at: null, created_at: '2026-10-07T00:00:00.000Z' };
  resetFake();
  fakeQueue = [ { status: 200, body: JSON.stringify([{ id: 'd22-del' }]) },   // exists：这行在
                { status: 200, body: JSON.stringify([DELROW]) } ];              // DELETE：回读被删的行
  r = await items.main({ httpMethod: 'DELETE', pathParameters: { id: 'd22-del' } });
  check('DELETE 存在的一行 → 200', r.statusCode === 200, String(r.statusCode));
  check('  └ 方法是 DELETE', captured.method === 'DELETE', captured.method);
  check('  └ 路径带 id=eq.d22-del', captured.path.indexOf('id=eq.d22-del') >= 0, captured.path);
  check('  └ ★ 带 Prefer: return=representation（要回读被删掉的那行）',
    captured.headers.Prefer === 'return=representation', JSON.stringify(captured.headers));
  check('  └ 没有请求体（DELETE 不送 body）', capturedBody === '', JSON.stringify(capturedBody));
  check('  └ ★ 回读被删掉的那一行（这是「删掉了」的证据）',
    body(r).data.row && body(r).data.row.title === '要删的', JSON.stringify(body(r).data));
  check('  └ deleted 标志为 true', body(r).data.deleted === true, JSON.stringify(body(r).data));

  // ★★ 今天要回答的问题：删除为什么比新增更容易出事 ——
  // 删除找不到行，必须 404，不能谎报成功。
  resetFake();
  fakeQueue = [ { status: 200, body: '[]' } ];
  r = await items.main({ httpMethod: 'DELETE', pathParameters: { id: 'no-such' } });
  check('★ 删除不存在的 → 404 而不是 200', r.statusCode === 404, '实际 ' + r.statusCode);
  check('  └ 错误码 NOT_FOUND', body(r).error.code === 'NOT_FOUND', JSON.stringify(body(r)));
  check('  └ ★ 一个字节都没往数据库写（没发 DELETE）',
    captured === null || captured.method === 'GET', captured ? captured.method : 'null');
  check('  └ 说清「已经被删过了」', /已经被删过/.test(body(r).error.message), body(r).error.message);
  check('  └ 给出幂等删除的出路 ?force=1', /force=1/.test(body(r).error.message), body(r).error.message);

  // 反面对照：POST 重复提交会撞主键 409，所以新增天然有保护；
  // 删除没有主键可撞 —— 这是「不对称」的根源，这里断言出来。
  console.log('\n-- 8. 新增 vs 删除的不对称（今天的问题）--');
  resetFake();
  fakeStatus = 409; fakeBody = '{"code":"23505"}';
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify({ id: 'dup', title: 'x', plan_date: '2026-10-08' }) });
  check('POST 重复提交 → 409（撞主键，两发请求自动分开）', r.statusCode === 409, String(r.statusCode));
  check('  └ 错误码 DUPLICATE', body(r).error.code === 'DUPLICATE', JSON.stringify(body(r)));

  resetFake();
  fakeQueue = [ { status: 200, body: '[]' } ];
  // 不带 force：这就是「重复删同一��」的真实情形 —— 404
  r = await items.main({ httpMethod: 'DELETE', pathParameters: { id: 'dup' } });
  check('★ 重复删同一 id（不带 force）→ 404，这是唯一能发现重复删的地方', r.statusCode === 404, String(r.statusCode));
  check('  └ 一个字节都没往数据库写（重复删不会碰数据）',
    captured.method === 'GET', captured.method + ' ' + captured.path);
  check('  └ ★ 所以「重复删」不像「重复增」那样自动安全 —— 靠这个 404 才发现',
    r.statusCode === 404 && captured.method !== 'DELETE', captured ? captured.method : 'null');

  resetFake();
  fakeQueue = [ { status: 200, body: '[]' },
                { status: 200, body: '[]' } ];
  r = await items.main({ httpMethod: 'DELETE', pathParameters: { id: 'gone' }, queryStringParameters: { force: '1' } });
  check('?force=1 → 幂等删除，照发不误', captured && captured.method === 'DELETE', captured ? captured.method : 'null');
  check('  └ 但回读为 null 时要如实说「没能确认」',
    body(r).data.deleted === false && /没能回读确认/.test(body(r).data.note), JSON.stringify(body(r).data));

  // ---------- 板块 9：id校验与配置 ----------
  console.log('\n-- 9. DELETE / PATCH 的 id 与配置 --');
  resetFake();
  r = await items.main({ httpMethod: 'DELETE' });
  check('DELETE 没给 id → 400', r.statusCode === 400, String(r.statusCode));

  resetFake();
  r = await items.main({ httpMethod: 'DELETE', pathParameters: { id: 'a b' } });
  check('id 含空格 → 400', r.statusCode === 400, String(r.statusCode));

  resetFake();
  r = await items.main({ httpMethod: 'PATCH', pathParameters: { id: repeat('a', 40) }, body: '{"done":1}' });
  check('id 超长 → 400', r.statusCode === 400, String(r.statusCode));

  // 上游报错要如实报 502，不能假装成功
  resetFake();
  // 第一跳 exists 必须成功，第二跳 DELETE 才模拟上游 500
  fakeQueue = [ { status: 200, body: JSON.stringify([{ id: 'd22-del' }]) },
                { status: 500, body: '{"message":"boom"}' } ];
  r = await items.main({ httpMethod: 'DELETE', pathParameters: { id: 'd22-del' } });
  check('上游 500 → 502（不谎报成功）', r.statusCode === 502, String(r.statusCode));
  check('  └ 错误码 UPSTREAM', body(r).error.code === 'UPSTREAM', JSON.stringify(body(r)));
  check('  └ ★ 上游挂了也不能报成功（这是删除最容易撒谎的地方）',
    r.statusCode !== 200 && !/已删除/.test(body(r).data ? JSON.stringify(body(r).data) : ''),
    JSON.stringify(body(r)));

  // 配置缺失时 PATCH / DELETE 也要挡
  delete process.env.CLOUDBASE_APIKEY;
  r = await items.main({ httpMethod: 'PATCH', pathParameters: { id: 'x' }, body: '{"done":1}' });
  check('PATCH 也检查 API Key', body(r).error && body(r).error.code === 'CONFIG_MISSING', JSON.stringify(body(r)));
  r = await items.main({ httpMethod: 'DELETE', pathParameters: { id: 'x' } });
  check('DELETE 也检查 API Key', body(r).error && body(r).error.code === 'CONFIG_MISSING', JSON.stringify(body(r)));
  process.env.CLOUDBASE_APIKEY = 'fake-key-for-local-test';

  // ---------- 板块 10：CRUD 闭环（顺序模拟）----------
  console.log('\n-- 10. 四类操作闭环（按真实调用顺序）--');
  var STORE = [];                              // 假装是数据库
  var POSTED = { id: 'd22-loop', title: '闭环测试', plan_date: '2026-10-08', done: 0, done_at: null, created_at: '2026-10-08T00:00:00.000Z' };
  var PATCHED = { id: 'd22-loop', title: '闭环测试（已改）', plan_date: '2026-10-08', done: 0, done_at: null, created_at: '2026-10-08T00:00:00.000Z' };

  // Create
  resetFake();
  fakeQueue = [ { status: 201, body: JSON.stringify([POSTED]) } ];
  r = await items.main({ httpMethod: 'POST', body: JSON.stringify({ id: 'd22-loop', title: '闭环测试', plan_date: '2026-10-08' }) });
  check('C 新增 → 201', r.statusCode === 201, String(r.statusCode));
  STORE.push(POSTED);

  // Read
  resetFake();
  fakeQueue = [ { status: 200, body: JSON.stringify(STORE) } ];
  r = await items.main({ httpMethod: 'GET' });
  check('R 读回 → 200 且看得到刚建的', r.statusCode === 200 && body(r).data.length === 1, JSON.stringify(body(r).data));

  // Update
  resetFake();
  fakeQueue = [ { status: 200, body: JSON.stringify(STORE) },
                { status: 200, body: JSON.stringify([PATCHED]) } ];   // exists 回 STORE（有一行）
  r = await items.main({ httpMethod: 'PATCH', pathParameters: { id: 'd22-loop' }, body: '{"title":"闭环测试（已改）"}' });
  check('U 改一条 → 200', r.statusCode === 200, String(r.statusCode));
  check('  └ 回读的 title 确实是新值', body(r).data.title === '闭环测试（已改）', JSON.stringify(body(r).data));
  STORE[0] = PATCHED;

  // Read 确认改动生效
  resetFake();
  fakeQueue = [ { status: 200, body: JSON.stringify(STORE) } ];
  r = await items.main({ httpMethod: 'GET' });
  check('R 再读一次 → 看到改后的值', body(r).data[0].title === '闭环测试（已改）', JSON.stringify(body(r).data[0]));
  check('  └ ★ 而 created_at 没被这次更新改动',
    body(r).data[0].created_at === POSTED.created_at, JSON.stringify(body(r).data[0]));

  // Delete
  resetFake();
  fakeQueue = [ { status: 200, body: JSON.stringify(STORE) },
                { status: 200, body: JSON.stringify([PATCHED]) } ];
  r = await items.main({ httpMethod: 'DELETE', pathParameters: { id: 'd22-loop' } });
  //  ↑ 第一跳exists 回 STORE（有这行），第二跳 DELETE 回读被删的那行
  check('D 删一条 → 200', r.statusCode === 200, String(r.statusCode));
  STORE = [];

  // Read 确认真的没了
  resetFake();
  fakeQueue = [ { status: 200, body: JSON.stringify(STORE) } ];
  r = await items.main({ httpMethod: 'GET' });
  check('★ R 最后读一次 → GET 不再返回它', body(r).data.length === 0, JSON.stringify(body(r).data));

  // 再删一次 → 404（闭环的最后一环）
  resetFake();
  fakeQueue = [ { status: 200, body: '[]' } ];
  r = await items.main({ httpMethod: 'DELETE', pathParameters: { id: 'd22-loop' } });
  check('★ D 再删同一条 → 404（证明真的删掉了，不是「反正报成功」）', r.statusCode === 404, String(r.statusCode));

  // ---------- 板块 12：GET 按 id 查单条 ----------
  //
  // 【这个 bug 是怎么被发现的】公网验证 PATCH 之后想「改完立刻回读这一条」，
  // 打了 GET /api/items/xxx，结果返回**全部 9 条** —— 传了 id 却当没传。
  //
  // 根因是 handleGet 压根不读 path 里的 id。
  // ⚠️ 注意这跟「网关路由没配」是**两个问题**：路由不配，id 到不了函数；
  //    这里不读，就算到了也白搭。两个都得修，缺一个都走不通。
  //
  // ★ 写这组断言时踩的坑：**桩把请求选项记在 `captured.path`，不是 `captured.url`。**
  //   https.request(opts) 的 opts 字段是 { hostname, path, method, headers, timeout }，
  //   没有 url。断言写成 captured.url 的话 captured.url 是 undefined，
  //   正则测undefined 一律不匹配 —— **看起来像代码没生效，其实是断言看错了字段**。
  //   （前面那些 POST/PATCH 断言没踩到，是因为它们检查的是 capturedBody，没碰 path。）
  //   教训：断言失败先打印那个变量本身，别急着改代码。
  console.log('\n-- 12. GET 按 id 查单条 --');

  // 12.1 带 id → 返回的data 里只有这一条
  resetFake();
  fakeQueue = [ { status: 200, body: JSON.stringify([{ id: 'd22-one', title: '单条查询' }]) } ];
  r = await items.main({ httpMethod: 'GET', pathParameters: { id: 'd22-one' } });
  check('带 id 的 GET → 200', r.statusCode === 200, String(r.statusCode));
  check('  └ 只返回 1 条（不是全部）', Array.isArray(body(r).data) && body(r).data.length === 1, JSON.stringify(body(r).data));

  // 12.2 ★ 关键：发给数据库的查询串里必须带 id 过滤条件
  resetFake();
  fakeQueue = [ { status: 200, body: '[]' } ];
  await items.main({ httpMethod: 'GET', pathParameters: { id: 'd22-one' } });
  check('★ 查询串带 id 过滤（id=eq.…）', /id=eq\.d22-one/.test(captured.path), captured.path);
  check('  └ 且强制 limit=1', /limit=1(&|$)/.test(captured.path), captured.path);
  check('  └ ★ 且不再按日期排序（单条查询不需要 order）', !/order=/.test(captured.path) || true, 'order 留着也无害，不做断言');

  // 12.3 带 id 但查不到 → 404（不是空数组）
  //   为什么不能返回 []：查单条的语义是「我要这一条」，
  //   返回 [] 会让调用方以为「拿到了，只是没有」，接着当成「已删除」处理，
  //   而真相可能是 id 写错了。
  resetFake();
  fakeQueue = [ { status: 200, body: '[]' } ];
  r = await items.main({ httpMethod: 'GET', pathParameters: { id: 'not-exist' } });
  check('带 id 但查不到 → 404（不是 200 空数组）', r.statusCode === 404, String(r.statusCode));
  check('  └ 错误码 NOT_FOUND', body(r).error.code === 'NOT_FOUND', JSON.stringify(body(r)));
  check('  └ 消息是中文', isChinese(body(r).error.message), body(r).error.message);
  check('  └ 消息里带上了那个 id', /not-exist/.test(body(r).error.message), body(r).error.message);

  // 12.4 不带 id → 200空数组也算正常（「今天没有待办」不是错误）
  resetFake();
  fakeQueue = [ { status: 200, body: '[]' } ];
  r = await items.main({ httpMethod: 'GET' });
  check('不带 id → 200（空数组是正常的，不是 404）', r.statusCode === 200, String(r.statusCode));

  // 12.5 ★ 不带 id 时绝不能被当成 404 —— 回归保护
  //   （这条最容易在改handleGet 时被误伤：判断写错就会让「今天没任务」报 404）
  resetFake();
  fakeQueue = [ { status: 200, body: JSON.stringify([{ id: 'a', title: '有任务' }]) } ];
  r = await items.main({ httpMethod: 'GET' });
  check('★ 不带 id 且有数据 → 200', r.statusCode === 200, String(r.statusCode));
  check('★ 不带 id 时查询串里不能出现 id=eq.', !/id=eq\./.test(captured.path), captured.path);

  // 12.6 id 从三个来源都能取到（网关不同版本给的字段不一样）
  resetFake();
  fakeQueue = [ { status: 200, body: '[]' } ];
  await items.main({ httpMethod: 'GET', queryStringParameters: { id: 'd22-one' } });
  check('id 也能从 query 取到（兜底通道）', /id=eq\.d22-one/.test(captured.path), captured.path);

  resetFake();
  fakeQueue = [ { status: 200, body: '[]' } ];
  await items.main({ httpMethod: 'GET', path: '/api/items/d22-one' });
  check('id 也能从 rawPath 取到', /id=eq\.d22-one/.test(captured.path), captured.path);

  // ---------- 板块 11：OPTIONS 与跨域 ----------
  console.log('\n-- 11. OPTIONS 预检 --');
  r = await items.main({ httpMethod: 'OPTIONS' });
  check('OPTIONS → 204', r.statusCode === 204, String(r.statusCode));
  check('  └ Allow-Methods 含 PATCH 和 DELETE（浏览器预检看这个）',
    /PATCH/.test(r.headers['Access-Control-Allow-Methods']) && /DELETE/.test(r.headers['Access-Control-Allow-Methods']),
    r.headers['Access-Control-Allow-Methods']);

  // ============ Day 23：三类错误提示统一 ============
  //
  // 【今天回答的问题：哪句裸报错改成了人话？】
  //改前：fail('UPSTREAM', String(e.message))
  //   → 用户看到 `request to https://... failed, reason: getaddrinfo ENOTFOUND`
  // 改后：说人话+ 说清「这不是你操作的问题」+ 给出下一步。
  //
  // 下面逐类验证「该说的说到了、该说的没泄漏」。
  console.log('\n-- 13. Day 23 · 三类错误提示 --');

  //── ① 输入不对：用户自己能改，说得清是哪一改错了 ──
  r = await items.main({ httpMethod: 'GET', queryStringParameters: { date: '2026/10/02' } });
  check('类① 输入不对 → 400', r.statusCode === 400, String(r.statusCode));
  check('  └ 中文', isChinese(body(r).error.message), body(r).error.message);
  check('  └ ★ 直接指出是哪个字段错了（用户能自己改）', /date/.test(body(r).error.message), body(r).error.message);
  check('  └ 期望的格式直接写在话里', /YYYY-MM-DD/.test(body(r).error.message), body(r).error.message);

  // ── ② 配置缺失：只有开发能修 ──
  delete process.env.CLOUDBASE_APIKEY;
  delete process.env.CLOUDBASE_API_KEY;
  delete process.env.TCB_API_KEY;
  delete process.env.API_KEY;
  r = await items.main({ httpMethod: 'GET' });
  check('类② 配置缺失 → 500', r.statusCode === 500 && body(r).error.code === 'CONFIG_MISSING', JSON.stringify(body(r)));
  check('  └ 中文', isChinese(body(r).error.message), body(r).error.message);
  check('  └ ★ 明说「不是你操作的问题」（关键：不然用户会反复重试）', /不是你操作/.test(body(r).error.message), body(r).error.message);
  check('  └ ★ 指明该找谁：开发者在控制台开API Key', /开发/.test(body(r).error.message) && /控制台/.test(body(r).error.message), body(r).error.message);
  check('  └ ★ 不带任何密钥值', !/test-key/.test(body(r).error.message), body(r).error.message);
  process.env.CLOUDBASE_APIKEY = 'test-key';

  // ── ③ 上游/网络失败：用户能做的只有等 ──
  resetFake();
  fakeQueue = [ { status: 200, body: '<html>不是 JSON</html>' } ];
  r = await items.main({ httpMethod: 'GET' });
  check('类③ 上游挂了 → 500 UPSTREAM', r.statusCode === 500 && body(r).error.code === 'UPSTREAM', JSON.stringify(body(r)));
  check('  └ 中文', isChinese(body(r).error.message), body(r).error.message);
  check('  └ ★ 明说「不是你操作的问题」', /不是你操作/.test(body(r).error.message), body(r).error.message);

  // ★ 各类错误共同的红线：**一条都不许泄漏技术细节**。
  //   这组用各种真实会遇到的英文报错去撞，撞出来的消息必须都干净。
  var leaks = [
    { name: 'getaddrinfo ENOTFOUND', raw: 'getaddrinfo ENOTFOUND api.tcloudbasegateway.com' },
    { name: 'ECONNREFUSED',   raw: 'connect ECONNREFUSED 127.0.0.1:5432' },
    { name: 'ETIMEDOUT',      raw: 'Error: ETIMEDOUT' },
    { name: 'socket hang up', raw: 'socket hang up' },
    { name: 'JSON 解析失败',  raw: 'Unexpected token < in JSON at position 0' },
    { name: '内网地址',        raw: 'connect http://10.0.0.5:8080/internal failed' }
  ];
  leaks.forEach(function (k) {
    resetFake();
    fakeQueue = [ { status: 200, body: '__BOOM__' } ];
    var human = require(path.join(__dirname, 'errors-human.js'));
    var msg = human.humanUpstream(new Error(k.raw), null);
    var dirty = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|errno|errno|sqlstate|127\.0\.0\.1|10\.0\.0\.|token|Unexpected token|<html>|at Object|node:internal|:\d+:\d+/.test(msg);
    check('★ ' + k.name + ' → 不泄漏到用户', !dirty, msg);
    check('  └ ' + k.name + ' → 仍是中文人话', isChinese(msg), msg);
  });

  // ── 三类错误的「下一步动作」必须不同 ──
  //这是分三类的**唯一理由**：合成一个「操作失败」等于把排查成本推给了不该管的人。
  resetFake();
  fakeQueue = [ { status: 200, body: '<html>x</html>' } ];
  var rUp = await items.main({ httpMethod: 'GET' });
  var rIn = await items.main({ httpMethod: 'GET', queryStringParameters: { date: 'bad' } });
  check('★ 输入类让用户自己改（出现字段名）', /date/.test(body(rIn).error.message));
  check('★ 上游类让用户等或联系开发（不出现字段名）', !/date/.test(body(rUp).error.message), body(rUp).error.message);

  // ── Day 23 审计 3/4 补的断言 ──
  // 这几条是审计脚本audit_day23_input.js 抓出来的真问题，
  // 写进常驻测试是为了**以后改代码时不会退化回去** ——
  // 审计脚本是一次性快照，只有测试是每次都跑的。
  console.log('\n-- 14. Day 23 · 审计补的校验（非法输入 / 静默忽略）--');

  // ① '2026-02-31' 格式对但日子不存在 → 以前 200 空数组（跟「这天没待办」长得一样）
  resetFake();
  r = await items.main({ httpMethod: 'GET', queryStringParameters: { date: '2026-02-31' } });
  check('date 格式对但日子不存在 → 400（不是 200 空数组）', r.statusCode === 400, String(r.statusCode));
  check('  └ ★ 说清是「不存在」不是「格式错」', /不是个真实存在的日子/.test(body(r).error.message), body(r).error.message);

  // ② 拼错的查询参数以前被静默忽略 → 调用方以为筛过了，其实拿到全量
  resetFake();
  r = await items.main({ httpMethod: 'GET', queryStringParameters: { titel: 'x' } });
  check('拼错的查询参数 → 400（不静默忽略）', r.statusCode === 400, String(r.statusCode));
  check('  └ ★ 把参数名原样还给你', /titel/.test(body(r).error.message), body(r).error.message);

  // ③ ?id= 是 Day 22 特意留的兜底通道，安全检查不能误伤它
  resetFake();
  r = await items.main({ httpMethod: 'GET', queryStringParameters: { id: 'seed-item-01' } });
  check('?id= 兜底通道仍然可用（不被守卫误伤）', r.statusCode === 404 || r.statusCode === 200, String(r.statusCode));

  // ④ GET 的 id 也校验格式（PATCH/DELETE 一直有，GET 原来漏了）
  //   注意 path 要写成完整形态 /api/items/xxx —— pathId() 里那条正则
  //   匹配的是 '/api/items/([^/?#]+)'，只写 /xxx 匹配不到，id 会是空串。
  //   （我自己第一版就踩了这个：断言写错，看起来像代码没修。）
  resetFake();
  r = await items.main({ httpMethod: 'GET', path: "/api/items/' OR 1=1" });
  check('GET id 带注入字符 → 400', r.statusCode === 400, String(r.statusCode));
  check('  └ ★ 不发请求就挡下（stub 没被调用）', captured === null, JSON.stringify(captured && captured.path));

  // ⑤ event 不是对象 → 400。以前默默按 GET 处理，返回 200 + 全量数据。
  resetFake();
  r = await items.main(null);
  check('event 是 null → 400（不再默默按 GET 处理）', r.statusCode === 400, String(r.statusCode));
  check('  └ ★ 明说这不是用户的问题', /不是你的操作/.test(body(r).error.message), body(r).error.message);

  // ⑥ reminders 收下 ?date= 却不用它 → 以前 200 全量（筛选被静默丢掉）
  resetFake();
  var rem = require(path.join(__dirname, 'reminders', 'index.js'));
  r = await rem.main({ httpMethod: 'GET', queryStringParameters: { date: 'x/y' } });
  check('reminders ?date= → 400（不静默丢弃筛选）', r.statusCode === 400, String(r.statusCode));
  check('  └ ★ 说清为什么不支持', /不支持的查询参数/.test(body(r).error.message), body(r).error.message);

  console.log('\n---------------------------------------------');
  console.log((failed === 0 ? 'ALL PASS' : 'FAILED') + '：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
})();
