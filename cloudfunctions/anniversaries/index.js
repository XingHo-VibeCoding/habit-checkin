// CloudBase 云函数 /api/anniversaries（Day 26 新增）
// ---------------------------------------------------------------------------
// 作用：读 anniversaries 表（GET）、新增一条（POST）、改一条（PATCH）、删一条（DELETE）。
//
// 【这一层只管三件事】（与 items 同一套分层判据）
//   ① 接请求（解析 method / query / body）
//   ② 调函数（校验字段 → 调 repository）
//   ③ 返响应（套契约信封 { ok, data }）
//
// ────────────────────────────────────────────────────────────────────────────
// 【与 items 的六处不同，每一处都有原因。别照抄 items 忘改】
//
//  1. 表名 / 字段：happen_on（不是 plan_date）、yearly（不是 done）。
//     happen_on 存**这个日子发生过的那一天**。对一次性纪念日它是过去；
//     对每年重复的它是「起始那年」—— 前端 annivNext() 用它算「第 N 个」。
//
//  2. **不提供日期筛选**。items 可以 ?date=2026-10-10 筛「今天的清单」，
//     纪念日没有「今天的纪念日」这回事：每年重复的日子，下一次落在哪一天
//     取决于今天是哪天，得在应用层算。数据库里的 happen_on 是**历史日期**，
//     不是「下一次发生的日子」。所以 ?happen_on=eq.xxx 对倒数毫无意义，
//     加了只会诱导调用方写出静默返回空数组的错误查询（跟 items 当年 ?date= 的坑同类）。
//
//  3. yearly 收 0/1，**不收 true/false**。跟 items.done 同一个理由：
//     库里是 SMALLINT，发 JSON 的 true 会被 PostgreSQL 拒（invalid input syntax）。
//
//  4. 表很小（个人自用几十行），所以列表不排序 happen_on 而排 created_at ——
//     每年重复的日子里 2026-05-20 和 1998-05-20 会被劈成两堆，按 happen_on 排没意义。
//
//  5. **PATCH 页面还没入口**，但接口做齐。理由：等真有「改纪念日」UI 时，
//     不用回头改后端；而接口缺 PATCH 的话那时要补的是「线上滚动更新」，
//     比现在就多写一个分支风险大。
//
//  6. **不设 CHECK 拦未来日期**。happen_on 可以是过去、可以是将来的某一天
//     （「2027 拿学位证」这类一次性待办）。这不是 bug。
//
// 部署方式（控制台）：
//   1. 云函数 → **新建函数** anniversaries → 代码上传 → 传 zip（不是粘贴代码）
//      （zip 里有两个文件：index.js + anniversariesRepository.js，别漏）
//   2. 函数配置 → 开启「API Key」（或手动加环境变量 CLOUDBASE_APIKEY）
//   3. HTTP 访问服务 → **新建路由** /api/anniversaries，
//      同时勾 GET / POST / PATCH / DELETE，且**开启「路径透传」**
//      （PATCH/DELETE 的 id 在路径里，不开这个开关 id 传不进来）
//   4. 函数环境变量加 ALLOWED_ORIGINS，含线上域名
// 'use strict';

// ★ 唯一一处 require。数据访问层——只经它，不直接碰 https。
var repo = require('./anniversariesRepository');

var VERSION = 'day26';
var DEFAULT_LIMIT = 100;
var MAX_LIMIT = 200;

// ---------- CORS 白名单（同 items）----------
//
// ⚠️ 关键设计：**读不到白名单时不发这个头，而不是退回 '*'。**
// 「配置漏了」和「配置错了」要表现成同一种失败，这样漏配是显性的。
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

// 字段长度上限。跟 db/schema.sql 里的 VARCHAR(n) 对齐 —— 两边数字不一样的话，
// 就会出现「校验过了但数据库截断」或「数据库报错但说不清」。
var MAX_TITLE = 200;
var MAX_ID = 36;
var MAX_TS = 32;

// 允许写入的列。多一个字段都不认（理由见 validateBody）。
var WRITABLE = ['id', 'title', 'happen_on', 'yearly', 'created_at'];

// PATCH 允许改的列。
//
// 【为什么 created_at 不在里面】—— 它是「这行什么时候被创建的」。
// 改它会让记录失真（一条三天前加的纪念日突然显示成今天加的）。
// id 同理：它是主键，是这行的身份。
var PATCHABLE = ['title', 'happen_on', 'yearly'];

// ① 统一信封。形状由 api-contract.md 定死，换后端实现也不许改。
function ok(data) {
  return { ok: true, data: data };
}
function fail(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

// ============ Day 23 三类错误的人话层（已抽到共享文件） ============
//
// ⚠️ 为什么这里的 require 要试**两个**路径（Day 23 部署时踩的坑）：
//   仓库里这个文件跟 anniversaries/ 是兄弟目录，路径是 '../errors-human.js'；
//   但**部署时整个函数包会被解压成一个独立的根目录**，父目录根本不存在，
//   只写 '../errors-human.js' 的话，控制台点部署不会报错，一调用就
//   `Cannot find module '../errors-human.js'` —— 500，日志里很难看出是路径问题。
// → 两个都试：先试包内的 './'（部署后能走这条），再退回 '../'（本地仓库里能走那条）。
var human = (function () {
  try {
    return require('./errors-human.js');
  } catch (e1) {
    return require('../errors-human.js');
  }
})();
var humanValidation = human.humanValidation;
var humanConfig = human.humanConfig;
// 传 log 进去，让原文进日志而不是进响应。
var humanUpstream = function (e) { return human.humanUpstream(e, log); };

// ② HTTP 访问服务的「集成响应」包装。X-Version 是部署探针。
function withHttp(statusCode, payload, req) {
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Version, X-Service, Date',
    'Cache-Control': 'no-store',
    'X-Service': 'habit-checkin',
    'X-Version': VERSION
  };
  var origin = resolveOrigin(req && (req.headers || {})['origin']);
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return {
    statusCode: statusCode,
    headers: headers,
    body: JSON.stringify(payload)
  };
}

// ③ 服务端日志。一行 key=value。
//    只记 id 不记 title —— title 是用户自己写的私人内容，日志不该留全文。
function log(fields) {
  var parts = ['ts=' + new Date().toISOString()];
  for (var k in fields) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) parts.push(k + '=' + fields[k]);
  }
  console.log('[anniversaries] ' + parts.join(' '));
}

// ④ 取查询参数。CloudBase 的 HTTP 云函数在不同版本里给的字段不一样。
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

// ⑤ 取并解析请求体。两个坑：① body 可能是 Buffer；② 可能是 base64 字符串。
//     只处理 String(body) 的话，这两种都会变成乱码 JSON 解析错误，
//     报出来是「请求体不是 JSON」—— 指向错的排查方向。
function parseBody(event) {
  var raw = (event || {}).body;
  if (raw === undefined || raw === null || raw === '') {
    return { error: '请求体是空的。要新增一条请用 POST，并在 body 里传一个 JSON 对象。' };
  }
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

// ⑥ 校验 limit。不设上限的话 ?limit=99999999 会把整表拉回来。
function toLimit(raw) {
  var s = raw == null ? String(DEFAULT_LIMIT) : String(raw);
  if (!/^\d+$/.test(s)) return { error: 'limit 必须是正整数，收到 "' + s + '"' };
  var n = Number(s);
  if (n < 1 || n > MAX_LIMIT) return { error: 'limit 必须在 1–' + MAX_LIMIT + ' 之间，收到 ' + s };
  return { value: n };
}

// ⑦「格式对」不等于「这个日子存在」。'2026-02-31' 能过 /^\d{4}-\d{2}-\d{2}$/，
//    但 2 月没有 31 号。数据库的 CHECK 只查格式，会放它过关。
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
//     id 是幂等键。同一条内容提交两次，两次带同一个 id，第二次撞主键 → 409。
//     反过来，如果 id 由服务端每次现生成，手快点两下就是两条不同 id 的记录，
//     幂等键形同虚设。**发请求的一方必须持有 id。**
function validateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是一个 JSON 对象，形如 {"id":"...","title":"...","happen_on":"2026-10-06","yearly":1}。' };
  }

  // 拒绝未知字段。静默忽略会得到一个 happen_on 为空的请求，
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
    return { error: '缺 title（纪念日的名字，比如「生日」「认识纪念日」）。' };
  }
  if (typeof title !== 'string') return { error: 'title 必须是字符串，收到 ' + typeof title + '。' };
  var t = title.trim();
  if (!t) return { error: 'title 不能是空字符串或只有空格。' };
  if (t.length > MAX_TITLE) {
    return { error: 'title 太长了（' + t.length + ' 字），最多 ' + MAX_TITLE + ' 字 —— 手机上一行显示不完，请改短。' };
  }

  // happen_on
  //
  // 【这里允许「将来的日子」】—— 一次性纪念日完全可能还没发生
  // （「2027 拿学位证」）。所以这里只校验「格式对 + 日子真实存在」，
  // **不**校验「不能是将来」。前端能不能接受将来日期是它自己的判断。
  //
  // ⚠️ 反过来说，也不拦「很久以前」—— 昨天建的纪念日可以写 1950 年。
  //   那不是非法数据，只是可能填错了（填成了别的年份）。要拦得靠 UI 提示，
  //   不靠接口替用户做判断。
  var happenOn = body.happen_on;
  if (happenOn === undefined || happenOn === null || happenOn === '') {
    return { error: '缺 happen_on（这个日子发生在哪一天），格式 "YYYY-MM-DD"，例如 "2000-05-20"。' };
  }
  if (typeof happenOn !== 'string') {
    return { error: 'happen_on 必须是字符串，收到 ' + typeof happenOn + '。' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(happenOn)) {
    return { error: 'happen_on 必须是 YYYY-MM-DD，收到 "' + happenOn + '"。' };
  }
  if (!isRealDate(happenOn)) {
    return { error: 'happen_on "' + happenOn + '" 不是个真实存在的日子（比如 2 月没有 31 号）。' };
  }

  // yearly：可选，默认 0；只收 0 或 1，不收 true/false（见文件头第 3 条）。
  var yearly = (body.yearly === undefined || body.yearly === null) ? 0 : body.yearly;
  if (yearly !== 0 && yearly !== 1) {
    return { error: 'yearly 只能是 0（就那一天）或 1（每年重复），收到 ' + JSON.stringify(yearly) + '。' };
  }

  // created_at：可选，省略就用服务器当前时间（UTC ISO 串）。
  var createdAt = body.created_at;
  if (createdAt === undefined || createdAt === null || createdAt === '') {
    createdAt = new Date().toISOString();
  } else if (!isIsoString(createdAt)) {
    return { error: 'created_at 要么省略，要么是能解析的时间串（ISO 8601），收到 ' + JSON.stringify(createdAt) + '。' };
  }

  return {
    row: {
      id: id,
      title: t,
      happen_on: happenOn,
      yearly: yearly,
      created_at: createdAt
    }
  };
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

  // ★ 主键撞了 = 重复提交。绝不「假装成功」——
  //   前端拿到 ok:true 会把这条从待办里划掉，而库里其实根本没这一行。
  if (r.status === 409 || /23505|duplicate key/i.test(r.text)) {
    log({ m: 'POST', id: row.id, st: 'duplicate', ms: Date.now() - startedAt });
    return withHttp(409, fail('DUPLICATE',
      '这个 id 已经在纪念日里了（重复提交）。id 是防重复提交的幂等键 —— 如果你确实想加两条不同的内容，请换一个 id。'), event);
  }

  // 字段没满足数据库约束。原文不直接拼给用户（用户看到英文只会懵），
  // 先猜一个**可能的**中文说法并明说是推测，原文留日志。
  if (r.status === 400 || r.status === 422) {
    log({ m: 'POST', id: row.id, st: 'rejected_detail', up: r.status, raw: String(r.text).slice(0, 300) });
    return withHttp(400, fail('BAD_REQUEST',
      '这一条没能存进数据库：' + guessDbReason(r.text) +
      '如果反复出现，说明页面和数据库的字段对不上，请联系开发。'), event);
  }

  if (r.status < 200 || r.status >= 300) {
    log({ m: 'POST', id: row.id, st: 'upstream', up: r.status, ms: Date.now() - startedAt });
    log({ m: 'POST', id: row.id, st: 'upstream_detail', up: r.status, raw: String(r.text).slice(0, 300) });
    return withHttp(502, fail('UPSTREAM', humanUpstream(new Error('PG REST 返回 ' + r.status + '：' + r.text))), event);
  }

  if (!r.parsed) {
    log({ m: 'POST', id: row.id, st: 'inserted_noread', ms: Date.now() - startedAt });
    return withHttp(201, ok(row), event);
  }
  log({ m: 'POST', id: row.id, st: 'inserted', ms: Date.now() - startedAt });
  return withHttp(201, ok(r.parsed), event);
}

// 把数据库的英文约束错误翻成「能看懂但不死咬」的中文。
// 刻意做成**推测**：猜错比不给更糟 —— 会让人去查一个不存在的问题。
function guessDbReason(text) {
  var t = String(text || '').toLowerCase();

  if (t.indexOf('not-null') >= 0 || t.indexOf('null value') >= 0) {
    var col = String(text).match(/column "([^"]+)"/);
    return '可能有必填项是空的' + (col ? '（字段 ' + col[1] + '）' : '') + '。';
  }
  if (t.indexOf('too long') >= 0 || t.indexOf('character varying') >= 0 ||
      t.indexOf('value too long') >= 0) {
    var col2 = String(text).match(/column "([^"]+)"/);
    return '某一项太长了' + (col2 ? '（字段 ' + col2[1] + '）' : '') + '，请缩短一点。';
  }
  if (t.indexOf('check') >= 0 || t.indexOf('chk_') >= 0) {
    return '某一项的值不符合要求（比如日期格式、yearly 只能是 0 或 1）。';
  }
  if (t.indexOf('duplicate') >= 0 || t.indexOf('unique') >= 0 || t.indexOf('23505') >= 0) {
    return '有一条内容跟现有的重了。';
  }
  // 认不出来就实说认不出来 —— 这比编一个像模像样的原因诚实。
  return '数据库给出的原因无法理解（这本身就是个需要排查的问题）。';
}

// ⑩ GET 分支。纪念日版的 id 校验跟 items 完全一致（口径统一，别留特例）。
async function handleGet(event, startedAt) {
  var q = parseQuery(event);
  var id = pathId(event);

  if (id.length > MAX_ID) {
    return withHttp(400, fail('BAD_REQUEST', 'id 太长了（' + id.length + ' 字），最多 ' + MAX_ID + ' 字。'), event);
  }
  if (id && !/^[A-Za-z0-9_-]+$/.test(id)) {
    return withHttp(400, fail('BAD_REQUEST',
      'id 只能含字母、数字、下划线和连字符，收到 "' + id + '"。'), event);
  }

  var lim = toLimit(q.limit);
  if (lim.error) return withHttp(400, fail('BAD_REQUEST', lim.error), event);

  // 不认识的查询参数要说出来，不能当没看见。
  //   `?titel=xxx`（拼错了）以前会被静默忽略，调用方拿到 200 + 全量数据，
  //   以为筛过了其实没筛。这类错不产生任何错误信号，最难查。
  //   只在**只传了一个陌生键**时报错（多键混传时放行）。
  //
  //   `id` 在白名单里：它是路径 /api/anniversaries/{id} 的兜底通道 ——
  //   万一「路径透传」开关被关了，还有 ?id= 这条路能通。
  //   容错通道不能被安全检查误伤。
  //
  // ⚠️ 白名单里**没有** happen_on / date —— 这个接口不提供日期筛选（见文件头第 2 条）。
  //   传了就要报错，否则调用方会以为筛过了其实拿到的是全量。
  var KNOWN_Q = ['limit', 'id'];
  var qkeys = Object.keys(q);
  if (qkeys.length === 1 && KNOWN_Q.indexOf(qkeys[0]) < 0) {
    return withHttp(400, fail('BAD_REQUEST',
      '不认识的查询参数 "' + qkeys[0] + '"。这个接口只认：limit、id（都可以不传）；要查某一条请用路径 /api/anniversaries/{id}。' +
      '（注意：这个接口**不支持**按日期筛选 —— 每年重复的纪念日，「下一次」是哪天要按今天算，不是按库里的 happen_on。）'), event);
  }

  var rows = await repo.list({ id: id, limit: lim.value });
  log({ m: 'GET', st: 'ok', n: Array.isArray(rows) ? rows.length : -1, ms: Date.now() - startedAt });

  // 按 id 查却没查到 → 404，不要返回空数组。
  // 返回 [] 会让调用方以为「拿到了，只是没有」，接着可能当成「已删除」去处理，
  // 而真相是 id 写错了。404 才说得出「你找的那条不存在」。
  // （不带 id 时返回 [] 是正常的，那是「一个纪念日都没加」，不是错误。）
  if (id && (!Array.isArray(rows) || rows.length === 0)) {
    return withHttp(404, fail('NOT_FOUND', '纪念日里没有 id 为 "' + id + '" 的这一条。'), event);
  }

  // 直接返回数据库列名，不做前端字段映射（映射是前端接入时的事）。
  return withHttp(200, ok(rows), event);
}

// ⑪ 取出路径里的 id。
//     为什么用 pathParameters 而不是 query：契约写的是 RESTful 惯例，
//     网关会把它放进 pathParameters。但不同控制台版本给的字段不一样，
//     query 里也认一下 —— 同一个 id 从哪来都能跑，别赌一个。
//     ⚠️ 字符集收窄跟 POST 一样（字母数字 - _）：这个值会直接拼进 URL 查询串。
function pathId(event) {
  var e = event || {};
  var raw = '';
  var pp = e.pathParameters || {};
  if (pp && pp.id !== undefined && pp.id !== null) raw = String(pp.id);
  if (!raw && e.path) {
    // path 可能形如 /api/anniversaries/abc123，也可能是完整 URL
    var m = String(e.path).match(/\/api\/anniversaries\/([^/?#]+)/);
    if (m) raw = m[1];
  }
  if (!raw) {
    var q = parseQuery(e);
    if (q.id !== undefined && q.id !== null && String(q.id) !== '') raw = String(q.id);
  }
  return decodeURIComponent(raw);
}

// ⑫ 校验 PATCH 的 body，返回要改的列。
//     【与 POST 校验的三个区别，理由同 items】
//     ① id 不再必填（它在 URL 上，一律只认 URL）
//     ② 没有任何一个字段是必填的，但空对象直接拒 —— 静默成功最难查
//     ③ 矛盾检查看合并后的状态
function validatePatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是一个 JSON 对象，形如 {"title":"新名字"} 或 {"happen_on":"2001-05-20"}。' };
  }

  var keys = Object.keys(body);
  if (!keys.length) {
    return { error: 'body 是空的 —— 没有任何要改的字段。PATCH 至少要改一样东西。' };
  }

  var extra = [];
  for (var i = 0; i < keys.length; i++) {
    if (PATCHABLE.indexOf(keys[i]) < 0) extra.push(keys[i]);
  }
  if (extra.length) {
    return {
      error: '这些字段不能改：' + extra.join('、') + '。' +
             '可改的只有：' + PATCHABLE.join('、') + '。' +
             '（id 是身份、created_at 是创建时间，都不该被改；想换 id 请删了重建）'
    };
  }

  var patch = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return { error: 'title 必须是字符串，收到 ' + typeof body.title + '。' };
    var t = body.title.trim();
    if (!t) return { error: 'title 不能是空字符串或只有空格（要改空，那就删掉这条）。' };
    if (t.length > MAX_TITLE) {
      return { error: 'title 太长了（' + t.length + ' 字），最多 ' + MAX_TITLE + ' 字 —— 手机上一行显示不完，请改短。' };
    }
    patch.title = t;
  }

  if (body.happen_on !== undefined) {
    if (typeof body.happen_on !== 'string') {
      return { error: 'happen_on 必须是字符串，收到 ' + typeof body.happen_on + '。' };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.happen_on)) {
      return { error: 'happen_on 必须是 YYYY-MM-DD，收到 "' + body.happen_on + '"。' };
    }
    if (!isRealDate(body.happen_on)) {
      return { error: 'happen_on "' + body.happen_on + '" 不是个真实存在的日子（比如 2 月没有 31 号）。' };
    }
    patch.happen_on = body.happen_on;
  }

  if (body.yearly !== undefined) {
    // 跟 items.done 同理：库里是 SMALLINT，只认 0/1，不给 boolean 开后门。
    if (body.yearly !== 0 && body.yearly !== 1) {
      return { error: 'yearly 只能是 0（就那一天）或 1（每年重复），收到 ' + JSON.stringify(body.yearly) + '。' };
    }
    patch.yearly = body.yearly;
  }

  return { patch: patch };
}

// ⑬ PATCH 分支。流程：校验 body → 确认这行存在（404）→ 改 → 回读真正那行。
//     【为什么先查存在再改】
//       PostgREST 的 PATCH 找不到行时返回 **204 No Content**，
//       和「成功改了但改成的值恰好跟原来一样」的 200 分不开。判据含糊。
//       预查一次多一个 RTT，换来一个干净的 404，值得。
async function handlePatch(event, startedAt) {
  var id = pathId(event);
  if (!id) {
    return withHttp(400, fail('BAD_REQUEST',
      'URL 里没有 id。改一条要写成 /api/anniversaries/<id>（注意 CloudBase 网关的路由' +
      '要配成 /api/anniversaries/{id} 或 /api/anniversaries/*，并且开启「路径透传」，才能把 id 传进来）。'), event);
  }
  if (id.length > MAX_ID) return withHttp(400, fail('BAD_REQUEST', 'id 太长了（' + id.length + ' 字）。'), event);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return withHttp(400, fail('BAD_REQUEST', 'id 只能含字母、数字、下划线和连字符，收到 "' + id + '"。'), event);
  }

  var parsed = parseBody(event);
  if (parsed.error) {
    log({ m: 'PATCH', id: id, st: 'bad_body', ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST', parsed.error), event);
  }

  var v = validatePatch(parsed.value);
  if (v.error) {
    log({ m: 'PATCH', id: id, st: 'invalid', ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST', v.error), event);
  }

  var found = await repo.exists(id);
  if (!found) {
    log({ m: 'PATCH', id: id, st: 'not_found', ms: Date.now() - startedAt });
    return withHttp(404, fail('NOT_FOUND', '纪念日里没有 id 为 "' + id + '" 的这一条 —— 可能已经被删了。'), event);
  }

  var r = await repo.update(id, v.patch);

  if (r.status === 404) {
    log({ m: 'PATCH', id: id, st: 'gone', ms: Date.now() - startedAt });
    return withHttp(404, fail('NOT_FOUND', '这一条在改动过程中被删掉了。'), event);
  }
  if (r.status < 200 || r.status >= 300) {
    log({ m: 'PATCH', id: id, st: 'upstream', up: r.status, ms: Date.now() - startedAt });
    log({ m: 'PATCH', id: id, st: 'upstream_detail', up: r.status, raw: String(r.text).slice(0, 300) });
    return withHttp(502, fail('UPSTREAM', humanUpstream(new Error('PG REST 返回 ' + r.status + '：' + r.text))), event);
  }

  if (!r.parsed) {
    // 多半是 Prefer 头被网关吃了。不猜，直接报 ——
    // 报「不确定有没有改成」比报「改成了」诚实。
    log({ m: 'PATCH', id: id, st: 'updated_noread', ms: Date.now() - startedAt });
    return withHttp(200, ok({
      id: id,
      changed: v.patch,
      reread: null,
      note: '改动已发出，但没能回读数据库确认。请重新 GET 一次核对。'
    }), event);
  }

  log({ m: 'PATCH', id: id, st: 'updated', f: Object.keys(v.patch).join('+'), ms: Date.now() - startedAt });
  return withHttp(200, ok(r.parsed), event);
}

// ⑭ DELETE 分支。
//
//【最重要的一条：删除找不到行，必须报 404，不能报成功】
//     POST  重复发 → 撞主键 → 409，两次发送天然分开，不会静默。
//     DELETE 重复发 → 第二次「成功地什么都没做」。
//     如果这里返回 200，调用方会以为「我删成功了」，而真实情况可能是
//     第一次请求压根没生效 —— 数据还在，调用方以为已经清掉了。
//     这种谎报比报错危险得多：报错会让人去查，谎报只会让人接着往下走。
//     → 所以：**0 行被删 = 404 NOT_FOUND。**
//     要幂等重试的场景，显式带 ?force=1。
async function handleDelete(event, startedAt) {
  var id = pathId(event);
  if (!id) {
    return withHttp(400, fail('BAD_REQUEST',
      'URL 里没有 id。删一条要写成 /api/anniversaries/<id>。'), event);
  }
  if (id.length > MAX_ID) return withHttp(400, fail('BAD_REQUEST', 'id 太长了（' + id.length + ' 字）。'), event);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return withHttp(400, fail('BAD_REQUEST', 'id 只能含字母、数字、下划线和连字符，收到 "' + id + '"。'), event);
  }

  var q = parseQuery(event);
  var force = q.force === '1' || q.force === 'true';

  var found = await repo.exists(id);
  if (!found && !force) {
    log({ m: 'DELETE', id: id, st: 'not_found', ms: Date.now() - startedAt });
    return withHttp(404, fail('NOT_FOUND',
      '纪念日里没有 id 为 "' + id + '" 的这一条 —— 也许已经被删过了。' +
      '如果你要的是「确保它不在」（幂等删除），加 ?force=1。'), event);
  }

  var r = await repo.remove(id);

  if (r.status === 404) {
    log({ m: 'DELETE', id: id, st: 'gone', ms: Date.now() - startedAt });
    return withHttp(404, fail('NOT_FOUND', '这一条在删除过程中消失了。'), event);
  }
  if (r.status < 200 || r.status >= 300) {
    log({ m: 'DELETE', id: id, st: 'upstream', up: r.status, ms: Date.now() - startedAt });
    log({ m: 'DELETE', id: id, st: 'upstream_detail', up: r.status, raw: String(r.text).slice(0, 300) });
    return withHttp(502, fail('UPSTREAM', humanUpstream(new Error('PG REST 返回 ' + r.status + '：' + r.text))), event);
  }

  var deleted = r.parsed;
  log({
    m: 'DELETE', id: id,
    st: deleted ? 'deleted' : 'deleted_noread',
    ms: Date.now() - startedAt
  });

  return withHttp(200, ok({
    deleted: !!deleted,
    row: deleted,
    // 把被删掉的那行原样还回去 —— 唯一的证据。
    // 前端撤销条要靠它（「已删除「生日」」+ 撤销），刷新后还能恢复。
    note: deleted ? '已删除。row 是从数据库回读的那一行，可用于撤销。'
                  : '删除已执行，但没能回读确认（Prefer 头可能没生效）。'
  }), event);
}

// ⑮ 入口。
exports.main = async function (event) {
  // Day 23 审计改的判据（同 items）：event 连对象都不是 → 响亮地失败，
  // 别默默按 GET 处理。「连请求方法都没有」时返回 200 + 数据，
  // 看起来像成功，实际是网关配置错了 —— 那类错正确表现是**响亮地失败**。
  var method = '';
  if (event && typeof event === 'object' && event.httpMethod != null) {
    method = String(event.httpMethod).toUpperCase();
  } else if (event && typeof event === 'object') {
    method = 'GET';
  } else {
    return withHttp(400, fail('BAD_REQUEST',
      '服务端收到空的请求（event 不是对象），无法判断要做什么。这是网关或调用方的问题，不是你的操作。'),
      event);
  }
  var startedAt = Date.now();

  // 浏览器跨域发 PATCH/DELETE 之前会先发 OPTIONS 探路。不回应的话，
  // 真正的请求根本发不出去 —— 浏览器报的是 CORS 错，跟函数逻辑毫无关系。
  if (method === 'OPTIONS') {
    return withHttp(204, ok(null), event);
  }

  // 方法守卫：只放行契约里有的四种。405 必须带 Allow 头（RFC 7231 要求）。
  var ALLOWED = ['GET', 'POST', 'PATCH', 'DELETE'];
  if (ALLOWED.indexOf(method) < 0) {
    var r405 = withHttp(405, fail('METHOD_NOT_ALLOWED',
      '这个接口只支持 ' + ALLOWED.join(' / ') + '，收到 ' + method + '。'), event);
    r405.headers.Allow = ALLOWED.join(', ');
    return r405;
  }

  try {
    // 先查凭据，缺了就直接说缺哪个 —— 别等到请求发出去报 401 才猜。
    if (!repo.hasCredential()) {
      var hint = repo.credentialHint();
      return withHttp(500, fail('CONFIG_MISSING', humanConfig(hint)), event);
    }

    if (method === 'POST') return await handlePost(event, startedAt);
    if (method === 'PATCH') return await handlePatch(event, startedAt);
    if (method === 'DELETE') return await handleDelete(event, startedAt);
    return await handleGet(event, startedAt);
  } catch (e) {
    log({ m: method, st: 'error', err: String(e && e.message), ms: Date.now() - startedAt });
    return withHttp(500, fail('UPSTREAM', humanUpstream(e)), event);
  }
};
