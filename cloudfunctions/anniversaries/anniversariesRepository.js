// cloudfunctions/anniversaries/anniversariesRepository.js · 数据访问层（Day 26）
// ---------------------------------------------------------------------------
// 【这一层只管一件事：怎么跟 anniversaries 表打交道】
//
// 结构照抄 itemsRepository.js —— 同一套分层判据（换掉数据库这段要不要改）。
// 不抄的是「业务字段」：title 限 200 字、happen_on 是不是真实日子、yearly 只能 0/1
// 那些是业务约束，归接口层。
//
// ⚠️ 为什么不抽成共享文件（跟 itemsRepository 同一条理由，Day 17 就定了）：
//   CloudBase 按函数打包，zip 里有什么运行时才有什么。放根目录的 require('../db')
//   在云端找不到父目录，要让 require('./db') 生效就得把 db.js 塞进每个函数的 zip ——
//   部署时多一步、多一个能出错的环节。代价是凭据读取那几行各存一份。
//   函数数量到四个以上再考虑公共层。
'use strict';

var https = require('https');

// 表名。repository 层知道表叫什么，这是它该知道的。
var TABLE = 'anniversaries';
var TIMEOUT_MS = 8000;

// 环境 ID 不是秘密，写死兜底值，省一个环境变量。
var DEFAULT_ENV_ID = 'habit-checkin-d9giln6ke6594e88b';

// API Key 是服务端凭据：只读环境变量，绝不写进代码、绝不返回给前端。
// 两个名字都试 —— 控制台「开启 API Key 设置」注入的是 CLOUDBASE_APIKEY，
// 另有文档写成 CLOUDBASE_API_KEY。谁先命中用谁，避免赌一个拼写。
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

// 调 CloudBase PG 的自动 REST 层（PostgREST）。
// GET  https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/anniversaries?<filters>
// 用 API Key 鉴权 → 网关把它解成 service_role，绕过 RLS。
//
// 不像 items 那样「非 2xx 就抛错」：POST 需要分辨 409（重复提交）和
// 400（字段不满足约束），两者的排查动作完全不同 —— 一个去看幂等键，一个去看字段。
// 所以这里把状态码和原文都交回去，让调用方决定。
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
      // ★ return=representation = 改动后把新行返回来，这样响应里的 data
      //   是数据库真正存进去的东西，而不是我们以为存进去的东西。
      //
      //   故意**不**加 resolution=merge-duplicates —— 那个头会把主键冲突
      //   从「报错」变成「静默 upsert」。要让重复提交响亮地失败。
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

// 读：非 2xx 抛错，由接口层统一包成 UPSTREAM。
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

// 读一批。opts = { id, limit }，都已经由接口层校验过格式。
//
// ⚠️ 纪念日表**没有日期筛选**（跟 items 最大的不同）：
//   每年重复的日子，下一次落在哪一天取决于「今天是哪天」，得在应用层算 ——
//   数据库里的 happen_on 是个**历史日期**，不是下一次发生的日子。
//   所以 ?happen_on=eq.xxx 这种筛选对倒数毫无意义，故不提供。
//   表也永远很小（个人自用，几十行），全量拉完全没压力。
function list(opts) {
  var parts = ['select=*'];
  if (opts && opts.id) parts.push('id=eq.' + encodeURIComponent(opts.id));
  // 排序用 created_at 而不是 happen_on：
  //   happen_on 排序看起来更贴近「按时间排」，但每年重复的纪念日里
  //   2026-05-20 和 1998-05-20 会被劈成两堆，顺序没有意义。
  //   真正能表达用户录入顺序的是 created_at。
  parts.push('order=' + encodeURIComponent('created_at.asc,id.asc'));
  parts.push('limit=' + (opts && opts.id ? 1 : ((opts && opts.limit) || 100)));
  return pgRead(parts.join('&'));
}

// 回读解析：PostgREST 带 return=representation 时返回数组，第一项就是那一行。
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

// 写入一行。row 的字段名和取值范围由接口层校验过了，这里不重复检查 ——
// 重复检查会变成两套规则各自演化，那是分层最容易出 bug 的地方。
function insert(row) {
  return pg('POST', null, row, true).then(readResult);
}

// 改一行。body 只放要改的列（PostgREST 的 PATCH 是局部更新）。
function update(id, patch) {
  var q = 'id=eq.' + encodeURIComponent(id);
  return pg('PATCH', q, patch, true).then(readResult);
}

// 删一行。parsed 是被删掉的那一行——
// 「删掉了」没法凭空断言，得有东西证明。前端撤销条要靠它。
function remove(id) {
  var q = 'id=eq.' + encodeURIComponent(id);
  return pg('DELETE', q, null, true).then(readResult);
}

// 这行在不在。为什么要单独一个而不是靠 update 的返回判断：
// update 找不到行时 PostgREST 返回 **204 No Content**（没有 body），
// 和「成功改了但值跟原来一样」的 200 分不开。204 在 PostgREST 里语义含糊。
function exists(id) {
  var q = 'id=eq.' + encodeURIComponent(id) + '&select=id&limit=1';
  return pgRead(q).then(function (j) {
    return Array.isArray(j) ? j.length > 0 : !!j;
  });
}

// 有没有凭据。**不抛错也不返回密钥本身**。
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
  insert: insert,
  update: update,
  remove: remove,
  exists: exists,
  hasCredential: hasCredential,
  credentialHint: credentialHint
};
