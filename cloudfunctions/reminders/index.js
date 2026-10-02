// CloudBase 云函数 /api/reminders（Day 17）
// ---------------------------------------------------------------------------
// 作用：把 PostgreSQL 里的 reminders 表读出来，套上契约信封 { ok, data } 返回。
//
// 部署方式（控制台）：
//   1. 云函数 → 新建 → 函数名 reminders → 运行环境 Node.js → 粘贴本文件
//   2. 函数配置 → 开启「API Key」（或手动加环境变量 CLOUDBASE_APIKEY）
//   3. HTTP 访问服务 → 新建 → 路径 /api/reminders → 关联函数 reminders → 方法 GET
//
// 与 items/index.js 是两份独立部署的包（CloudBase 按函数打包），所以公共逻辑
// 在这边重复了一份 —— 这是刻意的：拆成共享文件就得改走 zip 上传，部署步骤变多、
// 出错面变大。等函数数量到四个以上再考虑抽公共层。
'use strict';

var https = require('https');

var VERSION = 'day17';
var TABLE = 'reminders';
var DEFAULT_LIMIT = 100;
var MAX_LIMIT = 200;
var TIMEOUT_MS = 8000;

var DEFAULT_ENV_ID = 'habit-checkin-d9giln6ke6594e88b';
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

function envHint() {
  var keys = Object.keys(process.env || {}).filter(function (k) {
    return /CLOUDBASE|TCB|APIKEY|API_KEY|POSTGRES|^PG/i.test(k);
  });
  return keys.sort().join(', ') || '(一个都没有)';
}

function ok(data) {
  return { ok: true, data: data };
}
function fail(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

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
  if (method !== 'GET') {
    return withHttp(405, fail('BAD_REQUEST', '只用 GET，收到 ' + method));
  }

  try {
    if (!apiKey()) {
      return withHttp(500, fail('CONFIG_MISSING',
        '云函数拿不到 API Key。请在函数配置里开启 API Key，或手动加环境变量 ' +
        API_KEY_VARS.join(' / ') + '。当前可见的相关变量名：' + envHint()));
    }

    var q = parseQuery(event);

    // ⑩ item_id 过滤：契约里写明「可带 ?item_id= 过滤挂在某条清单下的」。
    //    不传就是全量 —— 独立提醒（item_id 为 NULL）也会一起返回，
    //    这是刻意的：前端要画的是「今天所有要响的提醒」，不该默认被过滤掉。
    var itemId = q.item_id == null ? '' : String(q.item_id);
    if (itemId && itemId.length > 64) {
      return withHttp(400, fail('BAD_REQUEST', 'item_id 太长（>64），收到 ' + itemId.length + ' 个字符'));
    }

    var lim = toLimit(q.limit);
    if (lim.error) return withHttp(400, fail('BAD_REQUEST', lim.error));

    // ⑪ 按提醒时间升序：前端拿到就是能直接按时间画的顺序，不用再排一遍。
    var parts = ['select=*'];
    if (itemId) parts.push('item_id=eq.' + encodeURIComponent(itemId));
    parts.push('order=' + encodeURIComponent('remind_at.asc'));
    parts.push('limit=' + lim.value);

    var rows = await pgRest(TABLE, parts.join('&'));

    return withHttp(200, ok(rows));
  } catch (e) {
    return withHttp(500, fail('UPSTREAM', String((e && e.message) || e)));
  }
};
