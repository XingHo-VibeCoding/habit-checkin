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

var VERSION = 'day20';
var DEFAULT_LIMIT = 100;
var MAX_LIMIT = 200;

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

// ② HTTP 访问服务的「集成响应」包装。
//    只在 Origin 命中白名单时才发 Access-Control-Allow-Origin。
function withHttp(statusCode, payload, req) {
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// ⑤ 入口。
exports.main = async function (event) {
  var method = (event && event.httpMethod) || 'GET';

  // 浏览器跨域发请求前先发 OPTIONS 探路。不回应的话真正的请求根本发不出去，
  // 而且浏览器报的是 CORS 错，跟这里面的逻辑毫无关系，很容易查错方向。
  if (method === 'OPTIONS') {
    return withHttp(204, ok(null), event);
  }

  if (method !== 'GET') {
    return withHttp(405, fail('BAD_REQUEST', '只用 GET，收到 ' + method), event);
  }

  try {
    // 先查凭据，缺了就直接说缺哪个 —— 别等到请求发出去报 401 才猜。
    if (!repo.hasCredential()) {
      var hint = repo.credentialHint();
      return withHttp(500, fail('CONFIG_MISSING',
        '云函数拿不到 API Key。请在函数配置里开启 API Key，或手动加环境变量 ' +
        hint.vars.join(' / ') + '。当前可见的相关变量名：' + hint.visible), event);
    }

    var q = parseQuery(event);

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
    return withHttp(500, fail('UPSTREAM', String((e && e.message) || e)), event);
  }
};
