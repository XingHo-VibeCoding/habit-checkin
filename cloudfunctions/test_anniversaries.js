// cloudfunctions/test_anniversaries.js · Day 26 本地逻辑测试
// ---------------------------------------------------------------------------
// 跟 test_logic.js 同规格：把 https.request 换成假的，捕获它想发的请求，再喂假响应。
// **不验证真实数据库**，只验证「函数逻辑对不对」。真实链路靠部署后 curl 公网地址。
//
// 跑法：node cloudfunctions/test_anniversaries.js
//
// 【这个测试重点盯什么】纪念日跟 items 长得像但有五处不同（见 index.js 文件头），
// 而其中最容易测漏的是「不提供日期筛选」这条 —— 它不是「少个功能」，
// 而是「加错了会静默返回空数组」，测不出来就得等线上纪念日全空才发现。
// 所以这条单独列了一组用例。
'use strict';

var EventEmitter = require('events').EventEmitter;
var https = require('https');
var path = require('path');

// ============ ① 假网络层（桩的机制照抄 test_logic.js，别各写一套） ============
var captured = null;
var capturedBody = '';
var fakeStatus = 200;
var fakeBody = '[]';

// 多步动作（PATCH / DELETE = 先 exists 再真正改）要不同响应，用队列。
// ⚠️ 别在测试中间替换 https.request —— index.js 在 require 时就把引用抓走了，
// 事后赋值不生效（Day 22 亲自踩过，报错是 "Cannot read properties of null"）。
var fakeQueue = null;
var fakeQueueAt = 0;

function nextFake() {
  if (!fakeQueue || !fakeQueue.length) return { status: fakeStatus, body: fakeBody };
  var item = fakeQueue[Math.min(fakeQueueAt, fakeQueue.length - 1)];
  fakeQueueAt++;
  return { status: item.status, body: item.body };
}

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
  req.write = function (chunk) {
    capturedBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return true;
  };
  req.end = function () {
    var f = nextFake();          // ★ 在 end() 里才取，不能提前
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
    console.log('  FAIL  ' + name + (detail !== undefined ? '  ->  ' + JSON.stringify(detail) : ''));
  }
}

function sentBody() {
  try { return JSON.parse(capturedBody); }
  catch (e) { return null; }
}

// 提示必须是中文（透传数据库英文原文这里就会红）
var CJK = /[一-龥]/;
function isChinese(s) { return CJK.test(String(s || '')); }

// ⚠️ process.env 必须在 require() **之前**设好。
// index.js 顶层就执行了 `ALLOWED_ORIGINS = ... process.env.ALLOWED_ORIGINS ...`，
// 那个值在 require 那一刻就定死了 —— 之后再设环境变量不会有任何效果。
// （Day 23/25 踩过：白名单用例莫名 FAIL，根因就是这个。）
var ORIGIN = 'https://daily-checkin-list.app.workbuddy.host';
process.env.ALLOWED_ORIGINS = ORIGIN;
process.env.CLOUDBASE_APIKEY = 'test-fake-key';

var fn = require(path.join(__dirname, 'anniversaries', 'index.js'));

// 调函数并解析响应
function call(ev) {
  return fn.main(ev).then(function (r) {
    var b = null;
    try { b = JSON.parse(r.body); } catch (e) { /* 下面按 null 判 */ }
    return { status: r.statusCode, headers: r.headers, body: b, raw: r.body };
  });
}

function get(qs, extra) {
  var ev = { httpMethod: 'GET', queryStringParameters: qs || {}, headers: {} };
  if (extra) { for (var k in extra) ev[k] = extra[k]; }
  return call(ev);
}
function post(obj, extra) {
  var ev = { httpMethod: 'POST', body: obj, headers: {} };
  if (extra) { for (var k in extra) ev[k] = extra[k]; }
  return call(ev);
}
function patch(id, obj) {
  return call({ httpMethod: 'PATCH', pathParameters: { id: id }, body: obj, headers: {} });
}
function del(id, qs) {
  return call({ httpMethod: 'DELETE', pathParameters: { id: id }, queryStringParameters: qs || {}, headers: {} });
}

// 合法 POST 体
function payload(over) {
  var p = { id: 'ann-test-001', title: '生日', happen_on: '2000-05-20', yearly: 1 };
  if (over) {
    for (var k in over) {
      if (Object.prototype.hasOwnProperty.call(over, k)) p[k] = over[k];
    }
  }
  return p;
}

var ROW = { id: 'ann-test-001', title: '生日', happen_on: '2000-05-20', yearly: 1,
            created_at: '2026-10-10T00:00:00.000Z' };

function rowJson(row) { return JSON.stringify([row || ROW]); }

// ---- 收尾 ----
// 为什么用 async main 而不是顶层 Promise 链：
//   模块里的顶层 `return` 会**立即结束整个模块**，后面所有用例一行都不跑，
//   而退出码仍是 0 —— 看起来「跑过了」，其实什么都没验。
//   （这个坑真的踩了一次：只有前 3 条 PASS 打印出来，exit code = 0。）
// → 每条 await 都是真顺序等待，跑不完就会抛错，不会假装成功。
async function main() {
  // ============================================================
  //  1. 方法守卫
  // ============================================================
  console.log('\n== 1. 方法守卫 ==');

  resetFake();
  await call({ httpMethod: 'PUT', headers: {} }).then(function (r) {
    check('PUT 被拒 405', r.status === 405, r.status);
    check('405 带 Allow 头（RFC 7231 要求）',
      r.headers.Allow === 'GET, POST, PATCH, DELETE', r.headers.Allow);
    check('405 的提示是中文', isChinese(r.body.error.message), r.body.error.message);
  });

  resetFake();
  await call({ httpMethod: 'OPTIONS', headers: {} }).then(function (r) {
    check('OPTIONS 回 204（跨域探路必须应，否则真请求发不出去）', r.status === 204, r.status);
  });

  resetFake();
  await call(null).then(function (r) {
    // Day 23 的判据：event 不是对象 → 响亮地失败，不默默按 GET 处理
    check('event 为 null 回 400（不是默默当 GET）', r.status === 400, r.status);
    check('提示是中文', isChinese(r.body.error.message), r.body.error.message);
  });

  // ============================================================
  //  2. POST 校验
  // ============================================================
  console.log('\n== 2. POST 校验 ==');

  resetFake();
  await post(payload()).then(function (r) {
    check('合法 POST 回 201', r.status === 201, r.status);
    check('响应是 { ok:true, data } 信封', r.body.ok === true && !!r.body.data, r.body);
  });

  resetFake();
  await post(payload({ id: null })).then(function (r) {
    check('缺 id 回 400', r.status === 400, r.status);
    check('提示提到「幂等键」（要说清为什么必填）',
      /幂等键/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  await post(payload({ id: 'bad id!' })).then(function (r) {
    check('id 含非法字符回 400', r.status === 400, r.status);
    check('提示说清字符集', /只能含/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  await post(payload({ title: '' })).then(function (r) {
    check('空 title 回 400', r.status === 400, r.status);
  });

  resetFake();
  await post(payload({ title: 'x'.repeat(201) })).then(function (r) {
    check('title 超 200 字回 400', r.status === 400, r.status);
    check('提示说「请改短」（给可执行的建议，不只是拒绝）',
      /改短|缩短/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  await post(payload({ happen_on: '2026/10/10' })).then(function (r) {
    check('happen_on 格式错回 400', r.status === 400, r.status);
    check('提示说清要 YYYY-MM-DD', /YYYY-MM-DD/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  await post(payload({ happen_on: '2026-02-31' })).then(function (r) {
    check('happen_on 填 2026-02-31 回 400（格式对但日子不存在）', r.status === 400, r.status);
    check('提示点明「2 月没有 31 号」这类原因',
      /2 月没有 31 号/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  await post(payload({ happen_on: '2026-02-29' })).then(function (r) {
    check('2026-02-29 合法（2026 不是闰年？—— 2026/4 不整除，是平年，故非法）',
      r.status === 400, r.status);
  });

  resetFake();
  await post(payload({ happen_on: '2024-02-29' })).then(function (r) {
    fakeBody = rowJson();
    check('2024-02-29 合法（2024 是闰年）', r.status === 201, r.status + ' ' + r.raw);
  });

  // yearly 只认 0/1 —— 这是与 items.done 同一个坑（SMALLINT 拒 boolean）
  resetFake();
  await post(payload({ yearly: true })).then(function (r) {
    check('★ yearly=true 回 400（库里是 SMALLINT，boolean 会被 PostgreSQL 拒）',
      r.status === 400, r.status);
    check('提示说清只认 0/1', /只能/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  await post(payload({ yearly: 2 })).then(function (r) {
    check('yearly=2 回 400', r.status === 400, r.status);
  });

  // ★ 将来的一次性纪念日必须允许（「2027 拿学位证」）
  resetFake();
  await post(payload({ id: 'ann-future', yearly: 0, happen_on: '2027-06-30' })).then(function (r) {
    fakeBody = rowJson();
    check('★ 将来的一次性纪念日允许（不是所有纪念日都已发生）',
      r.status === 201, r.status + ' ' + r.raw);
  });

  // 未知字段要说出来，不能静默忽略（否则 forget 映射时报 NOT NULL，指向错的排查方向）
  resetFake();
  await post(payload({ plan_date: '2026-10-10' })).then(function (r) {
    check('★ 送了 items 的字段名 plan_date 要被点名（拼错/忘映射一眼看出）',
      r.status === 400 && /不认识的字段/.test(r.body.error.message) &&
      /plan_date/.test(r.body.error.message), r.body.error.message);
  });

  // ============================================================
  //  3. POST 落库与重复提交
  // ============================================================
  console.log('\n== 3. POST 落库与重复提交 ==');

  resetFake();
  await post(payload()).then(function (r) {
    var b = sentBody();
    check('发出去的表是 anniversaries（不是 items）',
      captured.path.indexOf('/anniversaries') >= 0, captured.path);
    check('请求体里 happen_on 原样（不做时区转换 —— 它没有时区）',
      b && b.happen_on === '2000-05-20', b);
    check('yearly 发的是数字 1 不是 true', b && b.yearly === 1, b);
    check('带 Prefer: return=representation（要回读确认存进去的是啥）',
      captured.headers.Prefer === 'return=representation', captured.headers.Prefer);
    check('★ 不带 merge-duplicates（那个头会把重复提交变成静默 upsert）',
      String(captured.headers.Prefer).indexOf('merge-duplicates') < 0,
      captured.headers.Prefer);
  });

  resetFake();
  fakeStatus = 409;
  await post(payload()).then(function (r) {
    check('主键冲突回 409 DUPLICATE', r.status === 409 && r.body.error.code === 'DUPLICATE', r.status);
    check('★ 409 绝不谎报成功（前端拿到 ok:true 会把这条从界面划掉，而库里没有）',
      r.body.ok === false, r.body);
  });

  resetFake();
  fakeStatus = 400;
  fakeBody = 'null value in column "happen_on" violates not-null constraint';
  await post(payload()).then(function (r) {
    check('上游 400 转成人话，不是把英文原文丢给用户',
      r.status === 400 && isChinese(r.body.error.message), r.body.error.message);
    check('★ 不含数据库英文原文（那个只会让人懵：哪个列？什么 not-null？）',
      r.body.error.message.indexOf('violates not-null') < 0, r.body.error.message);
    check('猜的原因标了「可能」（不假装确定 —— 猜错比不给更糟）',
      /可能/.test(r.body.error.message), r.body.error.message);
  });

  // ============================================================
  //  4. GET —— 重点：没有日期筛选
  // ============================================================
  console.log('\n== 4. GET：没有日期筛选（纪念日最易测漏的一条） ==');

  resetFake();
  fakeBody = rowJson();
  await get({}).then(function (r) {
    check('GET 列表回 200', r.status === 200, r.status);
    check('默认排序用 created_at 不是 happen_on',
      decodeURIComponent(captured.path).indexOf('order=created_at.asc') >= 0,
      decodeURIComponent(captured.path));
    check('★ 查询串里没有日期筛选（下次在哪天要按今天算，筛库里的 happen_on 没意义）',
      decodeURIComponent(captured.path).indexOf('happen_on=eq') < 0,
      decodeURIComponent(captured.path));
  });

  resetFake();
  fakeBody = rowJson();
  await get({ happen_on: '2000-05-20' }).then(function (r) {
    check('★ 传 ?happen_on= 被明确拒绝（不是静默返回全量）',
      r.status === 400 && /不认识的查询参数/.test(r.body.error.message), r.status);
    check('★ 拒绝时顺便解释「为什么不支持按日期筛」（省得下一个人再问一遍）',
      /不支持|下一次/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  fakeBody = rowJson();
  await get({ date: '2026-10-10' }).then(function (r) {
    check('传 ?date= 也被拒（这是 items 的参数，别顺手带过来）', r.status === 400, r.status);
  });

  resetFake();
  fakeBody = rowJson();
  await get({ titel: 'x' }).then(function (r) {
    check('★ 拼错的参数被点名（静默忽略会让调用方以为筛过了）',
      r.status === 400 && /titel/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  fakeBody = rowJson();
  await get({ limit: 'abc' }).then(function (r) {
    check('limit 非数字回 400', r.status === 400, r.status);
  });

  resetFake();
  fakeBody = rowJson();
  await get({ limit: '999999' }).then(function (r) {
    check('limit 超上限回 400（不然 ?limit=99999999 会全表扫）', r.status === 400, r.status);
  });

  resetFake();
  fakeBody = '[]';
  await get({}, { pathParameters: { id: 'not-exist' } }).then(function (r) {
    check('按 id 查但没有 → 404（不返回 []，那会让调用方以为「拿到了，只是没有」）',
      r.status === 404 && r.body.error.code === 'NOT_FOUND', r.status);
  });

  resetFake();
  fakeBody = '[]';
  await get({ id: 'not-exist' }).then(function (r) {
    check('?id= 兜底通道同样 404（路径透传关了也能查）', r.status === 404, r.status);
  });

  resetFake();
  fakeBody = '[]';
  await get({}, { pathParameters: { id: 'bad id!' } }).then(function (r) {
    check('GET 的 id 也校验格式（与 POST/PATCH/DELETE 口径一致）',
      r.status === 400, r.status);
  });

  // ============================================================
  //  5. PATCH
  // ============================================================
  console.log('\n== 5. PATCH ==');

  resetFake();
  fakeQueue = [{ status: 200, body: rowJson() },
               { status: 200, body: rowJson({ id: 'ann-test-001', title: '生日', happen_on: '2000-05-20', yearly: 0, created_at: '2026-10-10T00:00:00.000Z' }) }];
  await patch('ann-test-001', { yearly: 0 }).then(function (r) {
    check('PATCH 存在的一行回 200', r.status === 200, r.status);
    check('回读的是数据库真正那行（含 yearly=0）',
      r.body.data && r.body.data.yearly === 0, r.body.data);
  });

  resetFake();
  fakeQueue = [{ status: 200, body: '[]' }, { status: 200, body: '[]' }];
  await patch('ann-test-001', { title: '新名字' }).then(function (r) {
    check('改不存在的一行回 404（先查存在再改，判据干净）',
      r.status === 404 && r.body.error.code === 'NOT_FOUND', r.status);
  });

  resetFake();
  await call({ httpMethod: 'PATCH', body: { title: 'x' }, headers: {} }).then(function (r) {
    check('URL 里没 id 回 400', r.status === 400, r.status);
    check('★ 提示提到「路径透传」（部署最常见的坑就是忘开这个）',
      /路径透传/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  await call({ httpMethod: 'PATCH', pathParameters: { id: 'a' }, body: {}, headers: {} }).then(function (r) {
    check('空 body 被拒（静默成功最难查）', r.status === 400, r.status);
    check('提示说「至少要改一样东西」', /至少要改/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  await patch('a', { yearly: true }).then(function (r) {
    check('★ PATCH 的 yearly=true 也被拒（跟 POST 同一口径）', r.status === 400, r.status);
  });

  resetFake();
  await patch('a', { created_at: '2026-01-01T00:00:00.000Z' }).then(function (r) {
    check('created_at 不可改（改了记录失真）',
      r.status === 400 && /created_at/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  await patch('a', { id: 'other' }).then(function (r) {
    check('id 不可改（它是这行的身份）',
      r.status === 400 && /id 是身份/.test(r.body.error.message), r.body.error.message);
  });

  // ============================================================
  //  6. DELETE —— 找不到必须 404，不能谎报成功
  // ============================================================
  console.log('\n== 6. DELETE ==');

  resetFake();
  fakeQueue = [{ status: 200, body: rowJson() },
               { status: 200, body: rowJson() }];
  await del('ann-test-001').then(function (r) {
    check('删存在的一行回 200', r.status === 200, r.status);
    check('★ 回读被删掉那行（前端撤销条要靠它，刷新后才恢复得出来）',
      r.body.data && r.body.data.row && r.body.data.row.id === 'ann-test-001', r.body.data);
    check('deleted 标记为 true', r.body.data && r.body.data.deleted === true, r.body.data);
  });

  resetFake();
  fakeQueue = [{ status: 200, body: '[]' }, { status: 200, body: '[]' }];
  await del('ann-test-001').then(function (r) {
    check('★ 删不存在的行回 404，**不谎报成功**',
      r.status === 404 && r.body.error.code === 'NOT_FOUND', r.status);
    check('★ 提示给出路 ?force=1（要幂等重试的人有办法继续）',
      /force=1/.test(r.body.error.message), r.body.error.message);
  });

  resetFake();
  fakeQueue = [{ status: 200, body: '[]' }, { status: 200, body: '[]' }];
  await del('ann-test-001', { force: '1' }).then(function (r) {
    check('?force=1 幂等删除放行（0 行也回 200）', r.status === 200, r.status);
  });

  resetFake();
  await call({ httpMethod: 'DELETE', headers: {} }).then(function (r) {
    check('URL 里没 id 回 400', r.status === 400, r.status);
  });

  // ============================================================
  //  7. CORS 与配置
  // ============================================================
  console.log('\n== 7. CORS 与配置 ==');

  resetFake();
  fakeBody = rowJson();
  await get({}, { headers: { origin: ORIGIN } }).then(function (r) {
    check('白名单内的 Origin 回显 Access-Control-Allow-Origin',
      r.headers['Access-Control-Allow-Origin'] === ORIGIN, r.headers['Access-Control-Allow-Origin']);
    check('带 Vary: Origin（命中与否两种响应都可能出现，别让 CDN 缓存死）',
      r.headers['Vary'] === 'Origin', r.headers['Vary']);
  });

  resetFake();
  fakeBody = rowJson();
  await get({}, { headers: { origin: 'https://evil.example.com' } }).then(function (r) {
    check('★ 白名单外的 Origin 不回 CORS 头（不回退成 *）',
      r.headers['Access-Control-Allow-Origin'] === undefined,
      r.headers['Access-Control-Allow-Origin']);
  });

  resetFake();
  fakeBody = rowJson();
  await get({}).then(function (r) {
    check('无 Origin（curl / 同源）不发 CORS 头也照样工作',
      r.status === 200 && r.headers['Access-Control-Allow-Origin'] === undefined, r.status);
  });

  resetFake();
  var savedKey = process.env.CLOUDBASE_APIKEY;
  delete process.env.CLOUDBASE_APIKEY;
  delete process.env.CLOUDBASE_API_KEY;
  delete process.env.TCB_API_KEY;
  delete process.env.API_KEY;
  await call({ httpMethod: 'GET', headers: {} }).then(function (r) {
    check('缺凭据回 500 CONFIG_MISSING',
      r.status === 500 && r.body.error.code === 'CONFIG_MISSING', r.status);
    check('★ 提示只列变量名不列值（列值等于泄露密钥）',
      r.body.error.message.indexOf('test-fake-key') < 0 &&
      /CLOUDBASE|APIKEY/i.test(r.body.error.message), r.body.error.message);
    process.env.CLOUDBASE_APIKEY = savedKey;    // 复原，免得影响后续
  });

  // ============================================================
  //  8. 错误信息不许是英文裸报错
  // ============================================================
  console.log('\n== 8. 错误提示不许是英文裸报错 ==');

  resetFake();
  fakeStatus = 503;
  fakeBody = 'upstream connect error';
  await post(payload()).then(function (r) {
    check('上游 5xx 转 502 UPSTREAM', r.status === 502 && r.body.error.code === 'UPSTREAM', r.status);
    check('提示是中文', isChinese(r.body.error.message), r.body.error.message);
    check('★ 不含 PostgREST 英文原文',
      r.body.error.message.indexOf('upstream connect error') < 0, r.body.error.message);
// ⚠️ 这条断言的判据要写成「排除责任」而不是死抠某一句措辞：
  //   提示实际说的是「不是你操作错了」，而我原来写的是 /不是你/ —— 没匹配上，
  //   一个 FAIL 报出来，看起来像功能坏了。
  //   **断言要问「这句话有没有把责任推给用户」，而不是「是不是我起草的那句话」** ——
  //   否则改个措辞就红，红了就有人去改代码迁就测试，那测试就成了摆设。
  check('★ 说了「不是你操作的问题」（避免用户白跑一趟去查数据库）',
    /不是.*(你操作|操作错)/.test(r.body.error.message), r.body.error.message);
  });

  // ---- 收尾 ----
  console.log('\n' + '-'.repeat(50));
  console.log(failed === 0
    ? 'ALL PASS：' + passed + ' 通过 / ' + failed + ' 失败'
    : '有FAIL：' + passed + ' 通过 / ' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
  // 走到这里说明测试本身就崩了（比如某个用例漏了 await）——
  // 必须以非 0 退出，否则「崩了」会被当成「全过」。
  console.error('\n测试自身抛异常（这算失败，不是通过）：', e && e.stack || e);
  process.exit(1);
});
