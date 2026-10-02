// CloudBase 云函数 /api/items（Day 17）
// ---------------------------------------------------------------------------
// 作用：把 PostgreSQL 里的 items 表读出来，套上契约信封 { ok, data } 返回。
//
// 部署方式（控制台）：
//   1. 云函数 → 新建 → 函数名 items → 运行环境 Node.js → 粘贴本文件
//   2. 函数配置 → 开启「API Key」（或手动加环境变量 CLOUDBASE_APIKEY）
//   3. HTTP 访问服务 → 新建 → 路径 /api/items → 关联函数 items → 方法 GET
//
// 为什么不用 @cloudbase/node-sdk：本函数只做「读一张表」，用内置 https 发一次
// PostgREST 请求就够了，多引一个 SDK 就多一层需要验证的版本假设。
// 为什么不用全局 fetch：云函数运行时可能是 Node 16，那时还没有 fetch；
// https 模块从 Node 8 就有，不赌运行时版本。
'use strict';

var https = require('https');

var VERSION = 'day17';
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

// ③ 出错时把「当前能看见哪些相关变量名」列出来（只列名不列值）。
//    为什么：部署阶段最常见的失败就是环境变量没生效，而云函数里没法交互式排查。
//    只输出变量名不会泄露凭据，却能让下一次尝试直接对准问题。
function envHint() {
  var keys = Object.keys(process.env || {}).filter(function (k) {
    return /CLOUDBASE|TCB|APIKEY|API_KEY|POSTGRES|^PG/i.test(k);
  });
  return keys.sort().join(', ') || '(一个都没有)';
}

// ④ 统一信封。形状由 api-contract.md 定死，换后端实现也不许改。
function ok(data) {
  return { ok: true, data: data };
}
function fail(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

// ⑤ HTTP 访问服务的「集成响应」包装：自己给状态码和响应头。
//    X-Version 是部署探针 —— 改完云函数没生效时，先看它变没变。
//    这样诊断信息不用污染 data 的形状，契约里 data 就纯粹是数组。
function withHttp(statusCode, payload) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Service': 'habit-checkin',
      'X-Version': VERSION
    },
    body: JSON.stringify(payload)
  };
}

// ⑥ 取查询参数。CloudBase 的 HTTP 云函数在不同版本里给的字段不一样：
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

// ⑦ 调 CloudBase PG 的自动 REST 层（PostgREST）。
//    GET https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/<table>?<filters>
//    用 API Key 鉴权 → 网关把它解成 service_role，绕过 RLS。
//    为什么用 service_role：本环境还没做用户体系，表上也没有 RLS 策略，
//    走「转发调用方 token」那条路会查不到任何行（RLS 零策略 = 全拒）。
function pgRest(table, query) {
  return new Promise(function (resolve, reject) {
    var req = https.request(
      {
        hostname: envId() + '.api.tcloudbasegateway.com',
        path: '/v1/rdb/rest/' + table + (query ? '?' + query : ''),
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + apiKey(),
          Accept: 'application/json'
        },
        timeout: TIMEOUT_MS
      },
      function (res) {
        var chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end', function () {
          var text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error('PG REST 返回 ' + res.statusCode + '：' + text.slice(0, 300)));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e2) {
            reject(new Error('PG REST 返回的不是 JSON：' + text.slice(0, 300)));
          }
        });
      }
    );
    req.on('timeout', function () { req.destroy(new Error('PG REST 超时（' + TIMEOUT_MS + 'ms）')); });
    req.on('error', reject);
    req.end();
  });
}

// ⑧ 校验 limit。
//    为什么设上限：不设的话 ?limit=99999999 会把整表拉回来，读接口被打成全表扫描。
function toLimit(raw) {
  var s = raw == null ? String(DEFAULT_LIMIT) : String(raw);
  if (!/^\d+$/.test(s)) return { error: 'limit 必须是正整数，收到 "' + s + '"' };
  var n = Number(s);
  if (n < 1 || n > MAX_LIMIT) return { error: 'limit 必须在 1–' + MAX_LIMIT + ' 之间，收到 ' + s };
  return { value: n };
}

// ⑨ 入口。
exports.main = async function (event) {
  var method = (event && event.httpMethod) || 'GET';
  // 只读接口显式挡掉其它方法：契约要可预测，POST /api/items 返回 200 会误导调用方。
  if (method !== 'GET') {
    return withHttp(405, fail('BAD_REQUEST', '只用 GET，收到 ' + method));
  }

  try {
    // ⑩ 先查凭据，缺了就直接说缺哪个 —— 别等到 fetch 报 401 才猜。
    if (!apiKey()) {
      return withHttp(500, fail('CONFIG_MISSING',
        '云函数拿不到 API Key。请在函数配置里开启 API Key，或手动加环境变量 ' +
        API_KEY_VARS.join(' / ') + '。当前可见的相关变量名：' + envHint()));
    }

    var q = parseQuery(event);

    // ⑪ date 过滤（YYYY-MM-DD）。库里 plan_date 就是 CHAR(10)，格式对不上直接 400，
    //    别把非法值拼进 URL 让数据库去报语法错 —— 那样的错误信息前端没法看。
    var date = q.date == null ? '' : String(q.date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return withHttp(400, fail('BAD_REQUEST', 'date 必须是 YYYY-MM-DD，收到 "' + date + '"'));
    }

    var lim = toLimit(q.limit);
    if (lim.error) return withHttp(400, fail('BAD_REQUEST', lim.error));

    // ⑫ 拼 PostgREST 查询串。顺序固定，方便对着 URL 一眼核对。
    var parts = ['select=*'];
    if (date) parts.push('plan_date=eq.' + encodeURIComponent(date));
    parts.push('order=' + encodeURIComponent('plan_date.asc,created_at.asc'));
    parts.push('limit=' + lim.value);

    var rows = await pgRest(TABLE, parts.join('&'));

    // ⑬ 直接返回数据库列名，不做前端字段映射。
    //    映射（items.date ↔ plan_date 等）是 Day 18 前端接入时的事，
    //    今天先保证「库里有什么，接口就吐什么」，避免两处同时改、出错时分不清哪边的锅。
    return withHttp(200, ok(rows));
  } catch (e) {
    return withHttp(500, fail('UPSTREAM', String((e && e.message) || e)));
  }
};
