// CloudBase 云函数 /api/items（Day 19 重构：数据库代码已拆到 itemsRepository.js）
// ---------------------------------------------------------------------------
// 作用：读 items 表（GET）、新增一条（POST）。
//
// 【这一层现在只管三件事】
//   ① 接请求（解析 method / query / body）
//   ② 调函数（校验字段 → 调 repository）
//   ③ 返响应（套契约信封 { ok, data }）
//
// 「怎么读数据库」「怎么拼查询串」「凭据从哪来」全在 itemsRepository.js 里。
// Day 19 重构的判据：**换掉数据库，这段代码要不要改？** 要改 → repository；不用改 → 这里。
//
// 部署方式（控制台）：
//   1. 云函数 → items → 更新代码 → **传 zip，不是粘贴代码**
//      （Day 19 起有两个文件了：index.js + itemsRepository.js，一起打包）
//   2. 函数配置 → 开启「API Key」（或手动加环境变量 CLOUDBASE_APIKEY）
//   3. HTTP 访问服务 → /api/items 路由要同时勾 GET 和 POST
'use strict';

// ★ 唯一一处 require。数据访问层——只经它，不直接碰 https。
var repo = require('./itemsRepository');

var VERSION = 'day20';
var DEFAULT_LIMIT = 100;
var MAX_LIMIT = 200;

// ---------- CORS 白名单（Day 20）----------
//
// 为什么不用通配符 '*'：
// '*' 的意思是「任何网站都能用我账号的权限调这个接口」。自己是单人自用，
// 风险看起来小，但通配符一旦漏到别的站点，别人就能随便读写你的清单。
// 所以改成白名单：只认 ALLOWED_ORIGINS 里列出来的域名。
//
// ⚠️ 关键设计：**读不到白名单时不发这个头，而不是退回 '*'。**
// 「配置漏了」和「配置错了」要表现成同一种失败（浏览器报 CORS 错），
// 这样漏配是显性的、静默降级是隐性的 —— 后者才危险。
//
// 同源请求和 curl 都不带 Origin 头，本来就不需要这个头，照常工作。
var ALLOWED_ORIGINS = (function () {
  var raw = process.env.ALLOWED_ORIGINS || '';
  return raw.split(',').map(function (s) { return s.trim(); })
            .filter(function (s) { return s !== ''; });
})();

// 返回该回的那个 Origin，或 null（本域请求 / 不在白名单里）
function resolveOrigin(origin) {
  if (!origin) return null;              // curl、同源 —— 不需要 CORS 头
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return origin;
  return null;
}

// 字段长度上限。跟 db/schema.sql 里的 VARCHAR(n) 对齐 ——
// 两边数字不一样的话，就会出现「校验过了但数据库截断」或「数据库报错但说不清」。
var MAX_TITLE = 200;
var MAX_ID = 36;
var MAX_TS = 32;

// 允许写入的列。多一个字段都不认（理由见 validateBody）。
var WRITABLE = ['id', 'title', 'plan_date', 'done', 'created_at', 'done_at'];

// ① 统一信封。形状由 api-contract.md 定死，换后端实现也不许改。
function ok(data) {
  return { ok: true, data: data };
}
function fail(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

// ② HTTP 访问服务的「集成响应」包装：自己给状态码和响应头。
//    X-Version 是部署探针 —— 改完云函数没生效时，先看它变没变。
function withHttp(statusCode, payload, req) {
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // 告诉浏览器「这几个自定义头你随便读」—— 不加这行，fetch 读 X-Version 会得到 null。
    'Access-Control-Expose-Headers': 'X-Version, X-Service, Date',
    'Cache-Control': 'no-store',
    'X-Service': 'habit-checkin',
    'X-Version': VERSION
  };
  // 只在白名单命中时才发 —— 见上面 resolveOrigin 的注释
  var origin = resolveOrigin(req && (req.headers || {})['origin']);
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    // 白名单是精确匹配，不带 Vary: Origin；命中与否两种响应都可能出现，
    // 告诉 CDN 别缓存死。
    headers['Vary'] = 'Origin';
  }
  return {
    statusCode: statusCode,
    headers: headers,
    body: JSON.stringify(payload)
  };
}

// ③ 服务端日志（Day 18 余力加练加的）。一行 key=value，字段固定，方便以后 grep。
//    只记 id 不记 title —— title 是用户自己写的私人内容，日志不该留全文。
//    云函数 stdout 会被平台收进日志中心，报障时先来这里看。
function log(fields) {
  var parts = ['ts=' + new Date().toISOString()];
  for (var k in fields) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) parts.push(k + '=' + fields[k]);
  }
  console.log('[items] ' + parts.join(' '));
}

// ④ 取查询参数。CloudBase 的 HTTP 云函数在不同版本里给的字段不一样：
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

// ⑤ 取并解析请求体。
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

// ⑥ 校验 limit。
//    为什么设上限：不设的话 ?limit=99999999 会把整表拉回来，读接口被打成全表扫描。
function toLimit(raw) {
  var s = raw == null ? String(DEFAULT_LIMIT) : String(raw);
  if (!/^\d+$/.test(s)) return { error: 'limit 必须是正整数，收到 "' + s + '"' };
  var n = Number(s);
  if (n < 1 || n > MAX_LIMIT) return { error: 'limit 必须在 1–' + MAX_LIMIT + ' 之间，收到 ' + s };
  return { value: n };
}

// ⑦ 「格式对」不等于「这个日子存在」。'2026-02-31' 能过 /^\d{4}-\d{2}-\d{2}$/，
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

// ⑧ 校验并组装要插入的一行。返回 { row } 或 { error }（中文，直接给用户看）。
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
  // 放过 & ? / # 这类字符就是在给自己造注入面和URL 解析坑。
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

// ⑨ POST 分支。校验 → 插入 → 把数据库真正存进去的那一行原样返回。
async function handlePost(event, startedAt) {
  var parsed = parseBody(event);
  if (parsed.error) {
    log({ m: 'POST', st: 'bad_body', ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST', parsed.error), event);
  }

  var v = validateBody(parsed.value);
  if (v.error) {
    log({ m: 'POST', st: 'invalid', ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST', v.error), event);
  }

  var row = v.row;
  var r = await repo.insert(row);

  // ★ 主键撞了 = 重复提交。同一个 id 第二次进来，就走到这里。
  //   200/201 之外一律按失败处理，绝不「假装成功」——
  //   前端拿到 ok:true 就会把这条从待办里划掉，而库里其实根本没这一行。
  if (r.status === 409 || /23505|duplicate key/i.test(r.text)) {
    log({ m: 'POST', id: row.id, st: 'duplicate', ms: Date.now() - startedAt });
    return withHttp(409, fail('DUPLICATE',
      '这个 id 已经在清单里了（重复提交）。id 是防重复提交的幂等键 —— 如果你确实想加两条不同的内容，请换一个 id。'), event);
  }

  // 字段没满足数据库约束（比如漏了 NOT NULL、CHECK 没过）。
  // 我们的校验已经挡了大部分，漏到这里的说明两边规则不一致 —— 消息里带上原文。
  if (r.status === 400 || r.status === 422) {
    log({ m: 'POST', id: row.id, st: 'rejected', up: r.status, ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST',
      '数据库拒收了这一行（可能是字段对不上表结构）：' + r.text.slice(0, 300)), event);
  }

  if (r.status < 200 || r.status >= 300) {
    log({ m: 'POST', id: row.id, st: 'upstream', up: r.status, ms: Date.now() - startedAt });
    return withHttp(502, fail('UPSTREAM', 'PG REST 返回 ' + r.status + '：' + r.text.slice(0, 300)), event);
  }

  // 201/200 + return=representation → repository 已把回读的那一行解析好。
  // 原样返回：前端看到的和库里存的是同一份，不存在「以为存进去了」。
  // 万一网关把 Prefer 头吃掉了（parsed 为 null），退回发过去的这一行——
  // 至少形状对，而且日志里 st=inserted_noread 就是这个信号。
  if (!r.parsed) {
    log({ m: 'POST', id: row.id, st: 'inserted_noread', ms: Date.now() - startedAt });
    return withHttp(201, ok(row), event);
  }
  log({ m: 'POST', id: row.id, st: 'inserted', ms: Date.now() - startedAt });
  return withHttp(201, ok(r.parsed), event);
}

// ⑩ GET 分支。Day 17 的逻辑，一字未改。
async function handleGet(event, startedAt) {
  var q = parseQuery(event);

  // date 过滤（YYYY-MM-DD）。库里 plan_date 就是 CHAR(10)，格式对不上直接 400，
  // 别把非法值拼进 URL 让数据库去报语法错 —— 那样的错误信息前端没法看。
  var date = (q.date == null) ? '' : String(q.date);
  var dateStr = String(date);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return withHttp(400, fail('BAD_REQUEST', 'date 必须是 YYYY-MM-DD，收到 "' + date + '"'), event);
  }

  var lim = toLimit(q.limit);
  if (lim.error) return withHttp(400, fail('BAD_REQUEST', lim.error), event);

  // ★ 只调 repository —— 查询串怎么拼、凭据从哪来，它自己知道。
  var rows = await repo.list({ date: dateStr, limit: lim.value });
  log({ m: 'GET', st: 'ok', n: Array.isArray(rows) ? rows.length : -1, ms: Date.now() - startedAt });

  // 直接返回数据库列名，不做前端字段映射。
  // 映射（items.date ↔ plan_date 等）是前端接入时的事，
  // 今天先保证「库里有什么，接口就吐什么」，避免两处同时改、出错时分不清哪边的锅。
  return withHttp(200, ok(rows), event);
}

// ⑪ 入口。
exports.main = async function (event) {
  var method = (event && event.httpMethod) || 'GET';
  var startedAt = Date.now();

  // 浏览器跨域发 POST 之前会先发 OPTIONS 探路（问「这个方法、这个头允许吗」）。
  // 不回应的话，真正的 POST 根本发不出去 —— 浏览器报的是 CORS 错，
  // 跟函数逻辑毫无关系，很容易查错方向。
  if (method === 'OPTIONS') {
    return withHttp(204, ok(null), event);
  }

  // 方法守卫：只放行 GET 和 POST。契约要可预测，
  // 返回 200 或凭空支持 PUT 都会误导调用方。
  if (method !== 'GET' && method !== 'POST') {
    return withHttp(405, fail('BAD_REQUEST', '这个接口只支持 GET 和 POST，收到 ' + method + '。'), event);
  }

  try {
    // 先查凭据，缺了就直接说缺哪个 —— 别等到请求发出去报 401 才猜。
    if (!repo.hasCredential()) {
      var hint = repo.credentialHint();
      return withHttp(500, fail('CONFIG_MISSING',
        '云函数拿不到 API Key。请在函数配置里开启 API Key，或手动加环境变量 ' +
        hint.vars.join(' / ') + '。当前可见的相关变量名：' + hint.visible), event);
    }

    if (method === 'POST') return await handlePost(event, startedAt);
    return await handleGet(event, startedAt);
  } catch (e) {
    log({ m: method, st: 'error', ms: Date.now() - startedAt });
    return withHttp(500, fail('UPSTREAM', String((e && e.message) || e)), event);
  }
};
