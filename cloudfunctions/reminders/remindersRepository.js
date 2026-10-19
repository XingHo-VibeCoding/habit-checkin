// cloudfunctions/reminders/remindersRepository.js · 数据访问层（Day 19 拆出，Day 27 加写入）
// ---------------------------------------------------------------------------
// 【这一层只管一件事：怎么跟 reminders 表打交道】
//
// 搬到这里的东西：凭据读取、发 https 请求、拼 PostgREST 查询串。
// 不搬的：字段校验（title 长度、remind_at 格式）—— 那些是接口层的入参校验。
//
// 【Day 27：从只读升级为可写】
//   Day 19 时提醒只做了读取（GET），前端提醒的增删只写 localStorage ——
//   换设备/app 后提醒不同步、删除也无法撤销。Day 27 试用反馈直接命中这个缺口。
//   本次的 insert/remove/exists **完全照抄 itemsRepository.js 的成熟模式**
//   （包括 Prefer: return=representation 回读、409 不静默、删除必回读），
//   理由同文件末尾那条：「重复是有意的」—— 两处一致比一套耦合便宜。
//
// 【为什么每个函数目录各放一份，而不是抽到 cloudfunctions/db.js】
// CloudBase 按函数打包：上传的 zip 里有什么，运行时才有什么。
// 放根目录的话 require('../db') 在云端找不到（zip 里没有父目录），
// 要让 require('./db') 生效就得把 db.js 塞进每个函数的 zip ——
// 那部署时就多一步、多一个能出错的环节。
// 代价是凭据读取那几行在两个 repository 里各存一份。这是 Day 17 就记下的取舍。
//
// ⚠️ 本文件与 itemsRepository.js 有重复代码，是**故意的**，不是漏了。
//    等函数数量到四个以上、或 CloudBase 支持共享层了，再考虑合并。
'use strict';

var https = require('https');

// 表名。repository 层知道表叫什么，这是它该知道的。
var TABLE = 'reminders';
var TIMEOUT_MS = 8000;

// 环境 ID 不是秘密，写死兜底值，省一个环境变量。
var DEFAULT_ENV_ID = 'habit-checkin-d9giln6ke6594e88b';

// API Key 是服务端凭据：只读环境变量，绝不写进代码、绝不返回给前端。
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

// 出错时把「当前能看见哪些相关变量名」列出来（只列名不列值）。
function envHint() {
  var keys = Object.keys(process.env || {}).filter(function (k) {
    return /CLOUDBASE|TCB|APIKEY|API_KEY|POSTGRES|^PG/i.test(k);
  });
  return keys.sort().join(', ') || '(一个都没有)';
}

// 调 CloudBase PG 的自动 REST 层（PostgREST）。Day 27：升级为 items 同款四参数版。
// GET    https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/reminders?<filters>
// POST   同 URL，body 是 JSON 对象
// DELETE 同 URL?id=eq.<id>
// 用 API Key 鉴权 → 网关把它解成 service_role，绕过 RLS。
//
// 为什么用内置 https 而不是全局 fetch：云函数运行时可能是 Node 16，那时没有 fetch；
// https 模块从 Node 8 就有，不赌运行时版本。
//
// 不像「非 2xx 就抛错」：POST 需要分辨 409（重复提交）和 400（字段不满足约束），
// 两者的排查动作完全不同 —— 一个去看幂等键，一个去看字段。
// 所以这里把状态码和原文都交回去，让调用方决定。
// preferReturn：要不要带 `Prefer: return=representation`（让 PostgREST 回读改动后的行）。
// （Day 22 踩过的坑：DELETE 不带 body 但最需要回读 —— 「删掉的那行长什么样」
//   是唯一能证明删对了的东西。所以必须是显式参数，由调用方按 method 决定。）
function pg(method, query, payload, preferReturn) {
  return new Promise(function (resolve, reject) {
    var headers = {
      Authorization: 'Bearer ' + apiKey(),
      Accept: 'application/json'
    };
    var bodyText = null;
    if (payload !== null && payload !== undefined) {
      bodyText = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
    }
    if (preferReturn) {
      // ★ 关键：return=representation = 改动后把新行返回来。
      //   故意**不**加 resolution=merge-duplicates —— 那会把主键冲突从「报错」
      //   变成「静默 upsert」：重复提交不但不报错，还会把老那一行覆盖掉。
      //   要让重复提交响亮地失败。
      headers.Prefer = 'return=representation';
    }

    var req = https.request(
      {
        hostname: envId() + '.api.tcloudbasegateway.com',
        path: '/v1/rdb/rest/' + TABLE + (query ? '?' + query : ''),
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

// PostgREST 带 return=representation 时返回数组，第一项就是那一行。
// 抽出来是因为 insert / remove 用同一套解析，逻辑完全一样。
function readResult(r) {
  var parsed = null;
  try {
    var j = JSON.parse(r.text);
    parsed = Array.isArray(j) ? (j.length ? j[0] : null) : j;
    if (parsed && typeof parsed !== 'object') parsed = null;
  } catch (e) {
    parsed = null;
  }
  return { status: r.status, text: r.text, parsed: parsed };
}

// 读：非 2xx 抛错，由接口层统一包成 UPSTREAM（Day 19 的行为，一字未改）。
function pgRead(query) {
  return pg('GET', query, null).then(function (r) {
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

// 读一批。opts = { itemId, limit }，两个都已经由接口层校验过。
//
// ⚠️ 不传 itemId 时**不过滤** —— 独立提醒（item_id 为 NULL）也会一起返回。
//    这是刻意的：前端要画的是「今天所有会响的提醒」，不是「某条清单的附属品」。
function list(opts) {
  var parts = ['select=*'];
  if (opts && opts.itemId) parts.push('item_id=eq.' + encodeURIComponent(opts.itemId));
  // 按提醒时间升序：前端拿到就是能直接按时间画的顺序，不用再排一遍。
  parts.push('order=' + encodeURIComponent('remind_at.asc'));
  parts.push('limit=' + ((opts && opts.limit) || 100));
  return pgRead(parts.join('&'));
}

// ============ Day 27：写入一行 ============
//
// row 的字段名和取值范围由接口层校验过了，这里不重复检查 ——
// 重复检查会变成两套规则各自演化，那是分层最容易出 bug 的地方。
//
// 返回 { status, text, parsed }：
//   status —— 上游 HTTP 状态码，接口层靠它分 409 / 400 / 5xx
//   text   —— 上游原文，排查时要看
//   parsed —— PostgREST 回读的那一行（数组第一项）；拿不到时是 null
function insert(row) {
  return pg('POST', null, row, true).then(readResult);
}

// ============ Day 27：删一行 ============
//
// 删除找不到行必须报 404，不能报成功 ——
// 否则 DELETE 重复执行第二次会「成功地什么都不做」，
// 调用方以为删成功了，实际第一次可能根本没生效。
//
// remove() 返回 { status, text, parsed }：parsed 是被删掉的那一行。
// 为什么一定要回读：**「删掉了」是没法凭空断言的，得有东西证明。**
function remove(id) {
  var q = 'id=eq.' + encodeURIComponent(id);
  return pg('DELETE', q, null, true).then(readResult);
}

// ============ Day 27：这行在不在 ============
//
// 删除前预查一次，判据干净：PostgREST 的 204 语义含糊，
// 靠删除的返回判断「存不存在」会混淆「没找到」和「删了但没回读」。
function exists(id) {
  var q = 'id=eq.' + encodeURIComponent(id) + '&select=id&limit=1';
  return pgRead(q).then(function (j) {
    return Array.isArray(j) ? j.length > 0 : !!j;
  });
}

// 有没有凭据。**不抛错也不返回密钥本身**，只回答「有没有」。
function hasCredential() {
  return !!apiKey();
}

// 凭据缺失时给接口层拼提示用的材料（只含变量名，不含值）。
function credentialHint() {
  return {
    vars: API_KEY_VARS,
    visible: envHint()
  };
}

module.exports = {
  list: list,
  insert: insert,      // Day 27
  remove: remove,      // Day 27
  exists: exists,      // Day 27
  hasCredential: hasCredential,
  credentialHint: credentialHint
};