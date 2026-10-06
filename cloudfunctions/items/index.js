// CloudBase 云函数 /api/items（Day 18 · GET + POST）
// ---------------------------------------------------------------------------
// 作用：读 items 表（GET，Day 17 做的），以及新增一条（POST，Day 18 加的）。
//
// 部署方式（控制台）：
//   1. 云函数 → items → 更新代码（传本文件）
//   2. 函数配置 → 开启「API Key」（或手动加环境变量 CLOUDBASE_APIKEY）
//   3. HTTP 访问服务 → /api/items 这条路由要**同时勾 GET 和 POST**
//      （Day 17 只勾了 GET，只勾 GET 的话 POST 会 405）
//
// 为什么不用 @cloudbase/node-sdk：本函数只做「读写一张表」，用内置 https 发一次
// PostgREST 请求就够了，多引一个 SDK 就多一层需要验证的版本假设。
// 为什么不用全局 fetch：云函数运行时可能是 Node 16，那时还没有 fetch；
// https 模块从 Node 8 就有，不赌运行时版本。
'use strict';

var https = require('https');

var VERSION = 'day18';
var TABLE = 'items';
var DEFAULT_LIMIT = 100;
var MAX_LIMIT = 200;
var TIMEOUT_MS = 8000;

// ① 环境 ID 不是秘密，写死兜底值，省一个环境变量。
var DEFAULT_ENV_ID = 'habit-checkin-d9giln6ke6594e88b';

// ② API Key 是服务端凭据：只读环境变量，绝不写进代码、绝不返回给前端。
//    两个名字都试 —— 控制台「开启 API Key 设置」注入的是 CLOUDBASE_APIKEY，
//    另有文档写成 CLOUDBASE_API_KEY。谁先命中用谁，避免赌一个拼写。
var API_KEY_VARS = ['CLOUDBASE_APIKEY', 'CLOUDBASE_API_KEY', 'TCB_API_KEY', 'API_KEY'];
var ENV_ID_VARS = ['CLOUDBASE_ENV_ID', 'TCB_ENV_ID', 'TCB_ENV'];

// ③ 字段长度上限。跟 db/schema.sql 里的 VARCHAR(n) 对齐 ——
//    两边数字不一样的话，就会出现「校验过了但数据库截断」或「数据库报错但说不清」。
var MAX_TITLE = 200;
var MAX_ID = 36;
var MAX_TS = 32;

// ④ 允许写入的列。多一个字段都不认（理由见 validateBody）。
var WRITABLE = ['id', 'title', 'plan_date', 'done', 'created_at', 'done_at'];

function pick(names) {
  for (var i = 0; i < names.length; i++) {
    var v = process.env[names[i]];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}
function envId() {
  return pick(ENV_ID_VARS) || DEFAULT_ENV_ID;
}
function apiKey() {
  return pick(API_KEY_VARS);
}

// ⑤ 出错时把「当前能看见哪些相关变量名」列出来（只列名不列值）。
//    为什么：部署阶段最常见的失败就是环境变量没生效，而云函数里没法交互式排查。
//    只输出变量名不会泄露凭据，却能让下一次尝试直接对准问题。
function envHint() {
  var keys = Object.keys(process.env || {}).filter(function (k) {
    return /CLOUDBASE|TCB|APIKEY|API_KEY|POSTGRES|^PG/i.test(k);
  });
  return keys.sort().join(', ') || '(一个都没有)';
}

// ⑥ 统一信封。形状由 api-contract.md 定死，换后端实现也不许改。
function ok(data) {
  return { ok: true, data: data };
}
function fail(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

// ⑦ HTTP 访问服务的「集成响应」包装：自己给状态码和响应头。
//    X-Version 是部署探针 —— 改完云函数没生效时，先看它变没变。
//    这样诊断信息不用污染 data 的形状，契约里 data 就纯粹是数据。
function withHttp(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 预检响应要靠这两个头，POST 跨域才会被浏览器放行（Day 20 前端接入时用得上）。
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
      'X-Service': 'habit-checkin',
      'X-Version': VERSION
    },
    body: JSON.stringify(payload)
  };
}

// ⑧ 服务端日志（余力加练加的）。一行 key=value，字段固定，方便以后 grep。
//    只记 id 不记 title —— title 是用户自己写的私人内容，日志不该留全文。
//    云函数 stdout 会被平台收进日志中心，报障时先来这里看。
function log(fields) {
  var parts = ['ts=' + new Date().toISOString()];
  for (var k in fields) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) parts.push(k + '=' + fields[k]);
  }
  console.log('[items] ' + parts.join(' '));
}

// ⑨ 取查询参数。CloudBase 的 HTTP 云函数在不同版本里给的字段不一样：
//    有的是 queryStringParameters（对象），有的是 queryString（原始串）。
//    两种都认，省得部署完才发现参数全丢了。
function parseQuery(event) {
  var e = event || {};
  if (e.queryStringParameters && typeof e.queryStringParameters === 'object') {
    return e.queryStringParameters;
  }
  if (e.query && typeof e.query === 'object') return e.query;
  var out = {};
  var raw = typeof e.queryString === 'string' ? e.queryString : '';
  String(raw).replace(/^\?/, '').split('&').forEach(function (kv) {
    if (!kv) return;
    var i = kv.indexOf('=');
    var k = i < 0 ? kv : kv.slice(0, i);
    var v = i < 0 ? '' : kv.slice(i + 1);
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  });
  return out;
}

// ⑩ 取并解析请求体。
//     两个坑：① body 可能是 Buffer（网关按二进制传的时候）；
//             ② 可能是 base64 编码的字符串，isBase64Encoded 为 true。
//     只处理 String(body) 的话，这两种都会变成一段乱码 JSON 解析错误，
//     报出来是「请求体不是 JSON」—— 指向错的排查方向。
function parseBody(event) {
  var raw = (event || {}).body;
  if (raw === undefined || raw === null || raw === '') {
    return { error: '请求体是空的。要新增一条请用 POST，并在 body 里传一个 JSON 对象。' };
  }
  // 网关已经解析好的对象，直接用。
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return { value: raw };
  var text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if ((event || {}).isBase64Encoded) {
    try {
      text = Buffer.from(text, 'base64').toString('utf8');
    } catch (e) {
      return { error: '请求体是 base64 编码的，但解不开。' };
    }
  }
  try {
    return { value: JSON.parse(text) };
  } catch (e2) {
    return { error: '请求体不是合法的 JSON。检查一下有没有多逗号、单引号，或中文引号「」。' };
  }
}

// ⑪ 调 CloudBase PG 的自动 REST 层（PostgREST）。
//     GET  https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/<table>?<filters>
//     POST 同 URL，body 是 JSON 对象
//     用 API Key 鉴权 → 网关把它解成 service_role，绕过 RLS。
//     为什么用 service_role：本环境还没做用户体系，表上也没有 RLS 策略，
//     走「转发调用方 token」那条路会查不到任何行（RLS 零策略 = 全拒）。
//
//     不像 Day 17 那样「非 2xx 就抛错」：POST 需要分辨 409（重复提交）
//     和 400（字段不满足约束），两者的排查动作完全不同 —— 一个去看幂等键，
//     一个去看字段。所以这里把状态码和原文都交回去，让调用方决定。
function pg(method, table, query, payload) {
  return new Promise(function (resolve, reject) {
    var headers = {
      Authorization: 'Bearer ' + apiKey(),
      Accept: 'application/json'
    };
    var bodyText = null;
    if (payload !== null && payload !== undefined) {
      bodyText = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
      // ★ 关键：return=representation = 插入后把新行返回来，
      //   这样响应里的 data 是数据库真正存进去的东西，而不是我们以为存进去的东西。
      //
      //   故意**不**加 resolution=merge-duplicates —— 那个头会把主键冲突
      //   从「报错」变成「静默 upsert」：重复提交不但不报错，
      //   还会把老那一行覆盖掉。比不防还糟。要让重复提交响亮地失败。
      headers.Prefer = 'return=representation';
    }

    var req = https.request(
      {
        hostname: envId() + '.api.tcloudbasegateway.com',
        path: '/v1/rdb/rest/' + table + (query ? '?' + query : ''),
        method: method,
        headers: headers,
        timeout: TIMEOUT_MS
      },
      function (res) {
        var chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end', function () {
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('timeout', function () { req.destroy(new Error('PG REST 超时（' + TIMEOUT_MS + 'ms）')); });
    req.on('error', reject);
    if (bodyText !== null) req.write(bodyText);
    req.end();
  });
}

// ⑫ 读接口专用：非 2xx 抛错，统一走 UPSTREAM（Day 17 的行为，一字未改）。
function pgRead(table, query) {
  return pg('GET', table, query, null).then(function (r) {
    if (r.status < 200 || r.status >= 300) {
      throw new Error('PG REST 返回 ' + r.status + '：' + r.text.slice(0, 300));
    }
    try {
      return JSON.parse(r.text);
    } catch (e) {
      throw new Error('PG REST 返回的不是 JSON：' + r.text.slice(0, 300));
    }
  });
}

// ⑬ 校验 limit。
//     为什么设上限：不设的话 ?limit=99999999 会把整表拉回来，读接口被打成全表扫描。
function toLimit(raw) {
  var s = raw == null ? String(DEFAULT_LIMIT) : String(raw);
  if (!/^\d+$/.test(s)) return { error: 'limit 必须是正整数，收到 "' + s + '"' };
  var n = Number(s);
  if (n < 1 || n > MAX_LIMIT) return { error: 'limit 必须在 1–' + MAX_LIMIT + ' 之间，收到 ' + s };
  return { value: n };
}

// ⑭ 「格式对」不等于「这个日子存在」。'2026-02-31' 能过 /^\d{4}-\d{2}-\d{2}$/，
//     但 2 月没有 31 号。数据库的 CHECK 只查格式，会放它过关；
//     所以这里多查一层真实存在性 ——
//     宁可现在告诉用户「这天不存在」，也别写进去之后排序时才发现。
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var y = Number(s.slice(0, 4));
  var m = Number(s.slice(5, 7));
  var d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  var dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[m - 1];
}

function isIsoString(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_TS) return false;
  return !isNaN(Date.parse(s));
}

// ⑮ 校验并组装要插入的一行。返回 { row } 或 { error }（中文，直接给用户看）。
//
//     【为什么 id 必填、而且由客户端生成】—— 这就是防重复提交的全部机制：
//     id 是幂等键。同一条内容提交两次，两次带的是同一个 id，第二次撞主键 → 409。
//     于是「重复提交被拒」和「内容不同的两条都正常入库」自动分开了，
//     不需要额外的查重逻辑。
//     反过来，如果 id 由服务端每次现生成，手快点两下就是两条不同 id 的记录，
//     幂等键形同虚设。**发请求的一方必须持有 id**。
//
//     【为什么不靠「标题查重」】：那会把合法内容也挡掉
//     （今天读两本书，第二本不叫重复），而且查重和插入之间有时间差，是竞态。
function validateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是一个 JSON 对象，形如 {"id":"...","title":"...","plan_date":"2026-10-06"}。' };
  }

  // 拒绝未知字段。前端字段名是 date / createdAt / doneAt（见 api-contract 的映射表），
  // 如果哪天真忘了转换就发过来，静默忽略会得到一个 plan_date 为空的请求，
  // 数据库只回一句 NOT NULL violation —— 指向错误的排查方向。
  // 明确报出「不认识的字段名」，一看就知道是拼错了还是没做映射。
  var extra = [];
  for (var k in body) {
    if (Object.prototype.hasOwnProperty.call(body, k) && WRITABLE.indexOf(k) < 0) extra.push(k);
  }
  if (extra.length) {
    return { error: '不认识的字段：' + extra.join('、') + '。可写字段只有：' + WRITABLE.join('、') + '。' };
  }

  // id（幂等键）
  var id = body.id;
  if (id === undefined || id === null || id === '') {
    return { error: '缺 id。id 是防重复提交的幂等键，必须由你（调用方）生成并带上，重试时用同一个 id。' };
  }
  if (typeof id !== 'string') return { error: 'id 必须是字符串，收到 ' + typeof id + '。' };
  if (id.length > MAX_ID) return { error: 'id 太长了（' + id.length + ' 字），最多 ' + MAX_ID + ' 字。' };
  // 字符集收窄到「字母数字 - _」。id 会拼进 PostgREST 的 URL 查询串，
  // 放过 & ? / # 这类字符就是在给自己造注入面和 URL 解析坑。
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return { error: 'id 只能含字母、数字、下划线和连字符，收到 "' + id + '"。' };
  }

  // title
  var title = body.title;
  if (title === undefined || title === null || title === '') {
    return { error: '缺 title（要做的事情）。' };
  }
  if (typeof title !== 'string') return { error: 'title 必须是字符串，收到 ' + typeof title + '。' };
  var t = title.trim();
  if (!t) return { error: 'title 不能是空字符串或只有空格。' };
  if (t.length > MAX_TITLE) {
    return { error: 'title 太长了（' + t.length + ' 字），最多 ' + MAX_TITLE + ' 字 —— 手机上一行显示不完，请改短。' };
  }

  // plan_date
  var planDate = body.plan_date;
  if (planDate === undefined || planDate === null || planDate === '') {
    return { error: '缺 plan_date（计划做哪一天），格式 "YYYY-MM-DD"，例如 "2026-10-06"。' };
  }
  if (typeof planDate !== 'string') return { error: 'plan_date 必须是字符串，收到 ' + typeof planDate + '。' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) {
    return { error: 'plan_date 必须是 YYYY-MM-DD，收到 "' + planDate + '"。' };
  }
  if (!isRealDate(planDate)) {
    return { error: 'plan_date "' + planDate + '" 不是个真实存在的日子（比如 2 月没有 31 号）。' };
  }

  // done：可选，默认 0；只收 0 或 1。
  var done = (body.done === undefined || body.done === null) ? 0 : body.done;
  if (done !== 0 && done !== 1) {
    return { error: 'done 只能是 0（没做）或 1（做完了），收到 ' + JSON.stringify(done) + '。' };
  }

  // created_at：可选，省略就用服务器当前时间（UTC ISO 串）。
  var createdAt = body.created_at;
  if (createdAt === undefined || createdAt === null || createdAt === '') {
    createdAt = new Date().toISOString();
  } else if (!isIsoString(createdAt)) {
    return { error: 'created_at 要么省略，要么是能解析的时间串（ISO 8601），收到 ' + JSON.stringify(createdAt) + '。' };
  }

  // done_at：可空。没做完就是 null —— 不用 '' 或 0 当哨兵值，
  // 哨兵值的代价是将来一定有人忘了判断它。
  var doneAt = (body.done_at === undefined) ? null : body.done_at;
  if (doneAt !== null && !isIsoString(doneAt)) {
    return { error: 'done_at 要么省略，要么是 null，要么是能解析的时间串，收到 ' + JSON.stringify(doneAt) + '。' };
  }
  if (doneAt !== null && done !== 1) {
    return { error: 'done 是 0（还没做），却又给了 done_at —— 这两件事矛盾了。' };
  }

  return { row: { id: id, title: t, plan_date: planDate, done: done, created_at: createdAt, done_at: doneAt } };
}

// ⑯ POST 分支。校验 → 插入 → 把数据库真正存进去的那一行原样返回。
async function handlePost(event, startedAt) {
  var parsed = parseBody(event);
  if (parsed.error) {
    log({ m: 'POST', st: 'bad_body', ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST', parsed.error));
  }

  var v = validateBody(parsed.value);
  if (v.error) {
    log({ m: 'POST', st: 'invalid', ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST', v.error));
  }

  var row = v.row;
  var r = await pg('POST', TABLE, null, row);

  // ★ 主键撞了 = 重复提交。同一个 id 第二次进来，就走到这里。
  //   200/201 之外一律按失败处理，绝不「假装成功」——
  //   前端拿到 ok:true 就会把这条从待办里划掉，而库里其实根本没这一行。
  if (r.status === 409 || /23505|duplicate key/i.test(r.text)) {
    log({ m: 'POST', id: row.id, st: 'duplicate', ms: Date.now() - startedAt });
    return withHttp(409, fail('DUPLICATE',
      '这个 id 已经在清单里了（重复提交）。id 是防重复提交的幂等键 —— 如果你确实想加两条不同的内容，请换一个 id。'));
  }

  // 字段没满足数据库约束（比如漏了 NOT NULL、CHECK 没过）。
  // 我们的校验已经挡了大部分，漏到这里的说明两边规则不一致 —— 消息里带上原文。
  if (r.status === 400 || r.status === 422) {
    log({ m: 'POST', id: row.id, st: 'rejected', up: r.status, ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST',
      '数据库拒收了这一行（可能是字段对不上表结构）：' + r.text.slice(0, 300)));
  }

  if (r.status < 200 || r.status >= 300) {
    log({ m: 'POST', id: row.id, st: 'upstream', up: r.status, ms: Date.now() - startedAt });
    return withHttp(502, fail('UPSTREAM', 'PG REST 返回 ' + r.status + '：' + r.text.slice(0, 300)));
  }

  // 201/200 + return=representation → 正文是插入的那一行（数组形式）。
  // 解析出来原样返回：这样前端看到的和库里存的是同一份，不存在「以为存进去了」。
  var inserted = null;
  try {
    inserted = JSON.parse(r.text);
  } catch (e) {
    // 网关可能把 Prefer 头吃掉了，那就返回我们发过去的这一行 ——
    // 至少形状对，而且日志里能看出来「没拿到回读」（下面 st=inserted_noread 就是这个信号）。
    inserted = null;
  }
  if (Array.isArray(inserted)) inserted = inserted.length ? inserted[0] : null;
  if (!inserted || typeof inserted !== 'object') {
    log({ m: 'POST', id: row.id, st: 'inserted_noread', ms: Date.now() - startedAt });
    inserted = row;
  } else {
    log({ m: 'POST', id: row.id, st: 'inserted', ms: Date.now() - startedAt });
  }

  return withHttp(201, ok(inserted));
}

// ⑰ 读接口。Day 17 的逻辑，一字未改。
async function handleGet(event, startedAt) {
  var q = parseQuery(event);

  // date 过滤（YYYY-MM-DD）。库里 plan_date 就是 CHAR(10)，格式对不上直接 400，
  // 别把非法值拼进 URL 让数据库去报语法错 —— 那样的错误信息前端没法看。
  var date = (q.date == null) ? '' : String(q.date);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return withHttp(400, fail('BAD_REQUEST', 'date 必须是 YYYY-MM-DD，收到 "' + date + '"'));
  }

  var lim = toLimit(q.limit);
  if (lim.error) return withHttp(400, fail('BAD_REQUEST', lim.error));

  // 拼 PostgREST 查询串。顺序固定，方便对着 URL 一眼核对。
  var parts = ['select=*'];
  if (date) parts.push('plan_date=eq.' + encodeURIComponent(date));
  parts.push('order=' + encodeURIComponent('plan_date.asc,created_at.asc'));
  parts.push('limit=' + lim.value);

  var rows = await pgRead(TABLE, parts.join('&'));
  log({ m: 'GET', st: 'ok', n: Array.isArray(rows) ? rows.length : -1, ms: Date.now() - startedAt });

  // 直接返回数据库列名，不做前端字段映射。
  // 映射（items.date ↔ plan_date 等）是前端接入时的事，
  // 今天先保证「库里有什么，接口就吐什么」，避免两处同时改、出错时分不清哪边的锅。
  return withHttp(200, ok(rows));
}

// ⑱ 入口。
exports.main = async function (event) {
  var method = (event && event.httpMethod) || 'GET';
  var startedAt = Date.now();

  // 浏览器跨域发 POST 之前会先发 OPTIONS 探路（问「这个方法、这个头允许吗」）。
  // 不回应的话，真正的 POST 根本发不出去 —— 浏览器报的是 CORS 错，
  // 跟函数逻辑毫无关系，很容易查错方向。
  if (method === 'OPTIONS') {
    return withHttp(204, ok(null));
  }

  // 方法守卫：只放行 GET 和 POST。契约要可预测，
  // 返回 200 或凭空支持 PUT 都会误导调用方。
  if (method !== 'GET' && method !== 'POST') {
    return withHttp(405, fail('BAD_REQUEST', '这个接口只支持 GET 和 POST，收到 ' + method + '。'));
  }

  try {
    // 先查凭据，缺了就直接说缺哪个 —— 别等到请求发出去报 401 才猜。
    if (!apiKey()) {
      return withHttp(500, fail('CONFIG_MISSING',
        '云函数拿不到 API Key。请在函数配置里开启 API Key，或手动加环境变量 ' +
        API_KEY_VARS.join(' / ') + '。当前可见的相关变量名：' + envHint()));
    }

    if (method === 'POST') return await handlePost(event, startedAt);
    return await handleGet(event, startedAt);
  } catch (e) {
    log({ m: method, st: 'error', ms: Date.now() - startedAt });
    return withHttp(500, fail('UPSTREAM', String((e && e.message) || e)));
  }
};
