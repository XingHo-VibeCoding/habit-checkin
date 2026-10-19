// CloudBase 云函数 /api/reminders（Day 19 重构：数据库代码已拆到 remindersRepository.js）
// ---------------------------------------------------------------------------
// 作用：把 PostgreSQL 里的 reminders 表读出来，套上契约信封 { ok, data } 返回。
//
// 【这一层现在只管三件事】
//   ① 接请求（解析 method / query）
//   ② 调函数（校验参数 → 调 repository）
//   ③ 返响应（套契约信封 { ok, data }）
//
// 「怎么读数据库」「查询串怎么拼」「凭据从哪来」全在 remindersRepository.js 里。
// Day 19 重构的判据：**换掉数据库，这段代码要不要改？** 要改 → repository；不用改 → 这里。
//
// 部署方式（控制台）：
//   1. 云函数 → reminders → 更新代码 → **传 zip**（现在有两个文件了，一起打包）
//   2. 函数配置 → 开启「API Key」
//   3. HTTP 访问服务 → /api/reminders → 关联本函数 → 方法 GET
'use strict';

// ★ 唯一一处 require。数据访问层——只经它，不直接碰 https。
var repo = require('./remindersRepository');

var VERSION = 'day27';
var DEFAULT_LIMIT = 100;
var MAX_LIMIT = 200;

// Day 27：写入相关常量，与 items 侧同值（同一条契约）。
var MAX_TITLE = 200;
var MAX_ID = 36;
var MAX_TS = 32;
var MAX_LEAD = 10080;   // 7 天 = 10080 分钟。提醒提前量超过一周没有现实意义，
                        // 而且设上限能挡住 ?lead=999999999 这种手滑。
// 可写字段。前端字段名是 at/lead（见 api-contract 的映射表），
// 发原始字段名过来会在这里被拒掉，而不是静默存进一个空列。
var WRITABLE = ['id', 'title', 'item_id', 'remind_at', 'lead_minutes', 'done'];

// ---------- CORS 白名单（Day 20）----------
// 与 items 函数里那份**完全相同**的逻辑，重复是有意的：
// CloudBase 按函数独立打包，跨目录 require 在云端找不到文件，
// 要共用只能走 HTTP 调另一个函数 —— 为一次请求往返不值得。重复比耦合便宜。
//
// ⚠️ 读不到白名单时**不发**这个头，而不是退回 '*'：
// 漏配要表现成「浏览器报 CORS 错」（显性），不能静默开成通配符（隐性）。
var ALLOWED_ORIGINS = (function () {
  var raw = process.env.ALLOWED_ORIGINS || '';
  return raw.split(',').map(function (s) { return s.trim(); })
            .filter(function (s) { return s !== ''; });
})();

function resolveOrigin(origin) {
  if (!origin) return null;              // curl、同源 —— 不需要 CORS 头
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return origin;
  return null;
}

// ① 统一信封。形状由 api-contract.md 定死。
function ok(data) {
  return { ok: true, data: data };
}
function fail(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

// ============ Day 23：三类错误的人话层（与 items 共用同一份） ============
//
// 改前：`fail('UPSTREAM', String(e.message))`
//   → 用户看到 `request to https://... failed, reason: getaddrinfo ENOTFOUND`
// 改后：说人话，并说清「这不是你操作的问题」。
//
// ⚠️ 这个文件必须跟着 items 侧一起改 —— **这就是把它抽成共享文件的原因**：
//   Day 17~20 已经漏过一次（改了 items 忘了改 reminders）。
//   措辞漂移的代价：同一件事有两种说法，排查时更费劲。
//
//   两个路径都试的原因见items/index.js 里的同一段注释：
//   部署时函数包被解压成独立根目录，'../' 会找不到文件，而且**部署不报错、一调用才 500**。
var human = (function () {
  try {
    return require('./errors-human.js');
  } catch (e1) {
    return require('../errors-human.js');
  }
})();
var humanConfig = human.humanConfig;
// reminders 里没有 log 函数（它没接X-Version 探针那套），
// 所以第二个参数不传 —— humanUpstream 会自动跳过记日志这一步。
var humanUpstream = function (e) { return human.humanUpstream(e, null); };

// ② HTTP 访问服务的「集成响应」包装。
//    只在 Origin 命中白名单时才发 Access-Control-Allow-Origin。
function withHttp(statusCode, payload, req) {
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // 不加这行，浏览器 fetch 读 X-Version 会得到 null（它只认「简单响应头」）
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

// ③ 取查询参数。CloudBase 的 HTTP 云函数在不同版本里给的字段不一样：
//    queryStringParameters（对象）或 queryString（原始串）。两种都认。
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

// ④ 校验 limit。为什么设上限：不设的话 ?limit=99999999 会把整表拉回来，
//    读接口被打成全表扫描。
function toLimit(raw) {
  var s = raw == null ? String(DEFAULT_LIMIT) : String(raw);
  if (!/^\d+$/.test(s)) return { error: 'limit 必须是正整数，收到 "' + s + '"' };
  var n = Number(s);
  if (n < 1 || n > MAX_LIMIT) return { error: 'limit 必须在 1–' + MAX_LIMIT + ' 之间，收到 ' + s };
  return { value: n };
}

// ⑤ Day 27：请求体解析。照 items/index.js 的 parseBody 抄（网关已解析对象 / 原始串 / base64 三种都认）。
function parseBody(event) {
  var raw = (event || {}).body;
  if (raw === undefined || raw === null || raw === '') {
    return { error: '请求体是空的。要新增一条提醒请用 POST，并在 body 里传一个 JSON 对象。' };
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

// ⑥ Day 27：remind_at 是「时间轴上的一个点」（带时区），跟 plan_date 的校验不同 ——
//    它接受 ISO 8601 带时区的串（前端入库前会把本地时间转成 UTC）。
//    格式对不等于时间真实存在，Date.parse 能挡掉大部分；秒级精度不做强校验，
//    数据库列是 text（时刻一律存 ISO UTC 字符串，见 db/schema.sql 的契约注释）。
function isIsoTimestamp(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_TS + 8) return false;
  return !isNaN(Date.parse(s)) && /\d{2}:\d{2}/.test(s);
}

// ⑦ Day 27：校验并组装要插入的一行。返回 { row } 或 { error }（中文，直接给用户看）。
//
//     【id 必填且由客户端生成】—— 与 items 同一条契约：id 是幂等键，
//     重试时带同一个 id，重复提交撞主键 → 409，不会凭空多出两条。
//
//     【remind_at 必须是 UTC ISO 串】—— 前端 toDbReminder 负责「本地时间 → UTC」。
//     这里只查形状（有日期有时间、能被 Date.parse 解析）。时区在服务端无从校验，
//     靠的是前端映射函数 + verify_project 的字段映射检查。
function validateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是一个 JSON 对象，形如 {"id":"...","title":"...","remind_at":"2026-10-19T09:00:00.000Z"}。' };
  }

  var extra = [];
  for (var k in body) {
    if (Object.prototype.hasOwnProperty.call(body, k) && WRITABLE.indexOf(k) < 0) extra.push(k);
  }
  if (extra.length) {
    return { error: '不认识的字段：' + extra.join('、') + '。可写字段只有：' + WRITABLE.join('、') + '。' };
  }

  // id（幂等键）—— 与 items 同一条契约、同一段理由
  var id = body.id;
  if (id === undefined || id === null || id === '') {
    return { error: '缺 id。id 是防重复提交的幂等键，必须由你（调用方）生成并带上，重试时用同一个 id。' };
  }
  if (typeof id !== 'string') return { error: 'id 必须是字符串，收到 ' + typeof id + '。' };
  if (id.length > MAX_ID) return { error: 'id 太长了（' + id.length + ' 字），最多 ' + MAX_ID + ' 字。' };
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return { error: 'id 只能含字母、数字、下划线和连字符，收到 "' + id + '"。' };
  }

  // title —— 与 items 同规则（≤200，trim 后非空）
  var title = body.title;
  if (title === undefined || title === null || title === '') {
    return { error: '缺 title（提醒内容）。' };
  }
  if (typeof title !== 'string') return { error: 'title 必须是字符串，收到 ' + typeof title + '。' };
  var t = title.trim();
  if (!t) return { error: 'title 不能是空字符串或只有空格。' };
  if (t.length > MAX_TITLE) {
    return { error: 'title 太长了（' + t.length + ' 字），最多 ' + MAX_TITLE + ' 字 —— 手机上一行显示不完，请改短。' };
  }

  // remind_at —— 必填，ISO 8601 时间戳
  var remindAt = body.remind_at;
  if (remindAt === undefined || remindAt === null || remindAt === '') {
    return { error: '缺 remind_at（提醒时间），格式 ISO 8601，例如 "2026-10-19T09:00:00.000Z"。' };
  }
  if (typeof remindAt !== 'string') return { error: 'remind_at 必须是字符串，收到 ' + typeof remindAt + '。' };
  if (!isIsoTimestamp(remindAt)) {
    return { error: 'remind_at 必须是合法的 ISO 8601 时间戳（带日期和时间），收到 "' + remindAt + '"。' };
  }

  // lead_minutes —— 可空，默认 0。上限 7 天（见 MAX_LEAD 注释）。
  var lead = body.lead_minutes;
  if (lead === undefined || lead === null || lead === '') lead = 0;
  if (typeof lead !== 'number' || !isFinite(lead) || Math.floor(lead) !== lead) {
    return { error: 'lead_minutes 必须是整数（提前多少分钟提醒），收到 "' + lead + '"。' };
  }
  if (lead < 0 || lead > MAX_LEAD) {
    return { error: 'lead_minutes 必须在 0–' + MAX_LEAD + ' 之间（最多提前 7 天），收到 ' + lead + '。' };
  }

  // item_id —— 可空（NULL = 独立提醒，不挂在任何清单项下）。挂了的话长度同 id 规则。
  var itemId = body.item_id;
  if (itemId !== undefined && itemId !== null && itemId !== '') {
    if (typeof itemId !== 'string') return { error: 'item_id 必须是字符串，收到 ' + typeof itemId + '。' };
    if (itemId.length > MAX_ID) return { error: 'item_id 太长了（' + itemId.length + ' 字），最多 ' + MAX_ID + ' 字。' };
    if (!/^[A-Za-z0-9_-]+$/.test(itemId)) {
      return { error: 'item_id 只能含字母、数字、下划线和连字符，收到 "' + itemId + '"。' };
    }
  } else {
    itemId = null;
  }

  // done —— 可空，默认 0。SMALLINT 只认 0/1，不认 boolean（契约硬约束）。
  var done = body.done;
  if (done === undefined || done === null || done === '') done = 0;
  if (done !== 0 && done !== 1) {
    return { error: 'done 只认 0 或 1（不认 true/false）—— 数据库列是 SMALLINT，发布尔值会被拒。' };
  }

  return {
    row: {
      id: id,
      title: t,
      item_id: itemId,
      remind_at: remindAt,
      lead_minutes: lead,
      done: done
    }
  };
}

// ⑧ Day 27：从路径取 id。reminders 挂在 /api/reminders 下，照 items 的 pathId 抄，
//    只把正则里的表名换成 reminders。
function pathId(event) {
  var e = event || {};
  var raw = '';
  var pp = e.pathParameters || {};
  if (pp && pp.id !== undefined && pp.id !== null) raw = String(pp.id);
  if (!raw && e.path) {
    // path 可能形如 /api/reminders/abc123，也可能是完整 URL
    var m = String(e.path).match(/\/api\/reminders\/([^/?#]+)/);
    if (m) raw = m[1];
  }
  if (!raw) {
    var q = parseQuery(e);
    if (q.id !== undefined && q.id !== null && String(q.id) !== '') raw = String(q.id);
  }
  return decodeURIComponent(raw);
}

// ⑨ Day 27：新增一条提醒。模式照 items 的 handlePost 一字不差地抄 ——
//    校验 → insert → 409 → 400/422 → 5xx → 201 回读。
//    两处一致比一套耦合便宜（本文件头部的老理由，Day 23 也引用过）。
async function handlePost(event, startedAt) {
  var parsed = parseBody(event);
  if (parsed.error) {
    return withHttp(400, fail('BAD_REQUEST', parsed.error), event);
  }

  var v = validateBody(parsed.value);
  if (v.error) {
    return withHttp(400, fail('BAD_REQUEST', v.error), event);
  }

  var row = v.row;
  var r = await repo.insert(row);

  // ★ 主键撞了 = 重复提交。同一个 id 第二次进来，就走到这里。
  if (r.status === 409 || /23505|duplicate key/i.test(r.text)) {
    return withHttp(409, fail('DUPLICATE',
      '这个 id 已经在提醒里了（重复提交）。id 是防重复提交的幂等键 —— 如果你确实想加两条不同的提醒，请换一个 id。'), event);
  }

  if (r.status === 400 || r.status === 422) {
    return withHttp(400, fail('BAD_REQUEST',
      '这一条没能存进数据库：' + String(r.text).slice(0, 200) +
      '。如果反复出现，说明页面和数据库的字段对不上，请联系开发。'), event);
  }

  if (r.status < 200 || r.status >= 300) {
    return withHttp(502, fail('UPSTREAM', humanUpstream(new Error('PG REST 返回 ' + r.status + '：' + r.text))), event);
  }

  // 201 + return=representation → 返回库里真正存的那行；网关把 Prefer 头吃掉时
  // parsed 为 null，退回发过去的这一行 —— 至少形状对。
  return withHttp(201, ok(r.parsed || row), event);
}

// ⑩ Day 27：删除一条提醒。模式照 items 的 handleDelete：
//    id 校验 → 预查存在（404）→ remove → 回读那一行（撤销条要用）。
async function handleDelete(event, startedAt) {
  var id = pathId(event);
  if (!id) {
    return withHttp(400, fail('BAD_REQUEST',
      'URL 里没有 id。删一条要写成 /api/reminders/<id>。'), event);
  }
  if (id.length > MAX_ID) return withHttp(400, fail('BAD_REQUEST', 'id 太长了（' + id.length + ' 字）。'), event);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return withHttp(400, fail('BAD_REQUEST', 'id 只能含字母、数字、下划线和连字符，收到 "' + id + '"。'), event);
  }

  var q = parseQuery(event);
  var force = q.force === '1' || q.force === 'true';

  var found = await repo.exists(id);
  if (!found && !force) {
    return withHttp(404, fail('NOT_FOUND',
      '提醒里没有 id 为 "' + id + '" 的这一条 —— 也许已经被删过了。' +
      '如果你要的是「确保它不在」（幂等删除），加 ?force=1。'), event);
  }

  var r = await repo.remove(id);

  if (r.status === 404) {
    return withHttp(404, fail('NOT_FOUND', '这一条在删除过程中消失了。'), event);
  }
  if (r.status < 200 || r.status >= 300) {
    return withHttp(502, fail('UPSTREAM', humanUpstream(new Error('PG REST 返回 ' + r.status + '：' + r.text))), event);
  }

  var deleted = r.parsed;
  return withHttp(200, ok({
    deleted: !!deleted,
    row: deleted,
    // 把被删掉的那行原样还回去 —— 前端撤销条要用它重新 POST。
    note: deleted ? '已删除。row 是从数据库回读的那一行，可用于撤销。'
                  : '删除已执行，但没能回读确认（Prefer 头可能没生效）。'
  }), event);
}

// ⑪ 入口。
exports.main = async function (event) {
  var startedAt = Date.now();   // Day 27：POST/DELETE 的日志埋点要用（与 items 对齐）
  // Day 23：跟 items 侧同一条改动（同一天做的两处必须一样，
  // 不然「同一个错在两个函数里说法不同」这种坑又要重踩）。
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

  // 浏览器跨域发请求前先发 OPTIONS 探路。不回应的话真正的请求根本发不出去，
  // 而且浏览器报的是 CORS 错，跟这里面的逻辑毫无关系，很容易查错方向。
  if (method === 'OPTIONS') {
    return withHttp(204, ok(null), event);
  }

  // Day 27：从只读升级为 GET/POST/DELETE。PATCH 暂无场景（提醒没有勾选/编辑 UI），
  // 不做「以防万一」的实现 —— 没被走过的分支不会被发现，也不会被测到。
  var ALLOWED = ['GET', 'POST', 'DELETE'];
  if (ALLOWED.indexOf(method) < 0) {
    var r405 = withHttp(405, fail('METHOD_NOT_ALLOWED',
      '这个接口支持 ' + ALLOWED.join(' / ') + '，收到 ' + method + '。'), event);
    r405.headers.Allow = ALLOWED.join(', ');
    return r405;
  }

  try {
    // 先查凭据，缺了就直接说缺哪个 —— 别等到请求发出去报 401 才猜。
    if (!repo.hasCredential()) {
      var hint = repo.credentialHint();
      // Day 23：humanConfig —— 原句「云函数拿不到 API Key」是开发者的话，
      // 页面上的人要知道的是「这不是你操作的问题」。
      return withHttp(500, fail('CONFIG_MISSING', humanConfig(hint)), event);
    }

    if (method === 'POST') return await handlePost(event, startedAt);
    if (method === 'DELETE') return await handleDelete(event, startedAt);

    var q = parseQuery(event);

    // Day 23 审计补的一条：**把不认识的查询参数指出来，而不是当没看见**。
    //
    // 之前这个函数只读 item_id 和 limit，别的键一律不理。
    // 于是 `?date=2026-10-09` 这种调用会**成功返回全量数据**（200），
    // 调用方以为按天过滤了，其实拿到的是所有天的提醒 ——
    // 数据没少，但少了「这一层筛选」，前端画出来的东西就是错的，而且不报错。
    //
    // 为什么这比直接报错更值得管：漏筛和"数据错"一样有破坏性，
    // 但它不产生任何错误信号，没人会去查。
    //
    // 注意别把它做成「只允许白名单里的键」那种严格模式 ——
    // 网关或 SDK 有时会塞自己的参数进来，一刀切会把正常请求也打死。
    // 只拒绝「看起来是想筛选、但我这儿不支持」的那几个已知键。
    var KNOWN = ['item_id', 'limit'];
    var SUGGESTED = { date: 'reminders 表的 remind_at 是时间戳，没有按天过滤这个功能；要按天筛请在拿到全量后自己过滤。' };
    var keys = Object.keys(q);
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      if (KNOWN.indexOf(k) >= 0) continue;
      if (SUGGESTED[k]) {
        return withHttp(400, fail('BAD_REQUEST', '不支持的查询参数 "' + k + '"。' + SUGGESTED[k]), event);
      }
      // 完全陌生的键：告诉它被忽略了，但不拒绝（可能来自网关自己）
      if (keys.length === 1) {
        return withHttp(400, fail('BAD_REQUEST',
          '不认识的查询参数 "' + k + '"。这个接口只认：' + KNOWN.join('、') + '（都可以不传）。'),
          event);
      }
    }

    // ⑥ item_id 过滤：契约里写明「可带 ?item_id= 过滤挂在某条清单下的」。
    //    不传就是全量 —— 独立提醒（item_id 为 NULL）也会一起返回，
    //    这是刻意的：前端要画的是「今天所有要响的提醒」，不该默认被过滤掉。
    var itemId = q.item_id == null ? '' : String(q.item_id);
    if (itemId && itemId.length > 64) {
      return withHttp(400, fail('BAD_REQUEST', 'item_id 太长（>64），收到 ' + itemId.length + ' 个字符'), event);
    }

    var lim = toLimit(q.limit);
    if (lim.error) return withHttp(400, fail('BAD_REQUEST', lim.error), event);

    // ★ 只调 repository —— 查询串怎么拼、凭据从哪来，它自己知道。
    var rows = await repo.list({ itemId: itemId, limit: lim.value });
    return withHttp(200, ok(rows), event);
  } catch (e) {
    return withHttp(500, fail('UPSTREAM', humanUpstream(e)), event);
  }
};
