// CloudBase 云函数 /api/health（Day 15）
// ---------------------------------------------------------------------------
// 部署方式：控制台 → 云函数 → 新建 → 函数名填 health → 运行环境 Node.js → 粘贴本文件 →
//          再开「HTTP 访问服务」，路径写成 /api/health。
// 逐段解释见 api-contract.md 与当天的会话记录；这里每段注释只写「为什么这么写」。
'use strict';

// ① 服务名与版本号：抽成常量，不放进函数体。
//    为什么：health 的返回值要能一眼看出「我打的是哪个环境、哪一版」。
//    环境搞混、改完没生效，是部署阶段最常见两类事故，这两个字段是它们的探针。
var SERVICE = 'habit-checkin';
var VERSION = 'day20';

// ---------- CORS 白名单（Day 20）----------
// 与 items / reminders 里那份逻辑完全相同，理由见withHttp 的注释。
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

// ② 统一信封：所有响应都套 { ok, data } 或 { ok, error }。
//    为什么：前端只看一个字段就知道成败，不用去猜 HTTP 状态码 + body 结构的组合。
//    契约里写死了这个形状（见 api-contract.md），换后端实现时这一层不许变。
function ok(data) {
  return { ok: true, data: data };
}
function fail(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

// ③ 入口。CloudBase 的约定：模块导出 main(event, context)。
//    event  —— 请求内容。走 HTTP 访问服务时，里面有 httpMethod / path / headers /
//              queryStringParameters / body。
//    context—— 运行时信息，含 function_name、request_id 等，排查时有用。
//    async  —— 云函数环境支持 Promise，就算今天没有异步操作也照写，
//              将来加数据库查询时不用改签名。
exports.main = async function (event, context) {
  // ④ 只认 GET。health 是只读探针，不写任何数据，所以显式挡掉其它方法。
  //    为什么显式判断而不是「反正也写不坏」：契约要可预测。
  //    POST /api/health 返回 200 会让调用方误以为写成功了。
  var method = (event && event.httpMethod) || 'GET';

  // 浏览器跨域发请求前先发 OPTIONS 探路，不回应的话真正的请求根本发不出去
  if (method === 'OPTIONS') {
    return withHttp(204, ok(null), event);
  }

  if (method !== 'GET') {
    return withHttp(405, fail('BAD_REQUEST', '只用 GET，收到 ' + method), event);
  }

  try {
    // ⑤ 真正的响应体。四个字段各有用途，不是凑数：
    //    status  —— 留了 "degraded" 的口子（依赖挂了但主流程还能用）
    //    service —— 确认打的是不是这个环境
    //    time    —— 服务端时间。前端拿它对表，能发现「拿到的是缓存的旧响应」
    //    version —— 改完云函数没生效时，先看它变没变
    //    new Date().toISOString() 固定输出 UTC，不带时区歧义。
    return withHttp(200, ok({
      status: 'ok',
      service: SERVICE,
      time: new Date().toISOString(),
      version: VERSION
    }), event);
  } catch (e) {
    // ⑥ 兜底。health 本身不该抛异常，但真抛了也不能让调用方拿到一个裸的 502 ——
    //    那样前端只能显示「请求失败」，看不出是环境没起来还是代码错了。
    //    转成契约里的 INTERNAL，消息带上原始报错。
    return withHttp(500, fail('INTERNAL', String((e && e.message) || e)), event);
  }
};

// ⑦ HTTP 访问服务的「集成响应」包装。
//    CloudBase 默认把函数返回值直接当 JSON body；开了集成响应之后，
//    要自己返回 { statusCode, headers, body }，才能控制状态码和响应头。
//    两种模式都兼容：body 一律是字符串化的 JSON，不开集成响应时它也是合法 JSON。
//
// CORS 白名单（Day 20 起与 items / reminders 同一套逻辑，重复是有意的——
// CloudBase 按函数独立打包，跨目录 require 在云端找不到文件）。
// ⚠️ 读不到白名单时不发这个头，而不是退回 '*'：漏配要显性地报 CORS 错。
function withHttp(statusCode, payload, req) {
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Version, X-Service, Date',
    'Cache-Control': 'no-store',
    'X-Service': SERVICE,
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
