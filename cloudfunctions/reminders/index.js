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

var VERSION = 'day23';
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

  if (method !== 'GET') {
    // Day 23：错误码跟 items 侧对齐成 METHOD_NOT_ALLOWED（原来写的是 BAD_REQUEST）。
    // 405 和 400 排查动作完全不同：405 是「你调错方法了」，400 是「参数不对」。
    // 混用会把排查方向带偏 —— 跟 items 侧不一致更要命，两处同一件事两种说法。
    var r405 = withHttp(405, fail('METHOD_NOT_ALLOWED', '这个接口只支持 GET，收到 ' + method + '。'), event);
    // 405 必须带 Allow 头（RFC 7231 要求），否则有些客户端报的是「方法不支持」而不是 405
    r405.headers.Allow = 'GET, OPTIONS';
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
