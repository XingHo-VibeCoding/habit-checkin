// cloudfunctions/items/itemsRepository.js · 数据访问层（Day 19 拆出）
// ---------------------------------------------------------------------------
// 【这一层只管一件事：怎么跟 items 表打交道】
//
// 搬到这里的东西：凭据读取、发https 请求、拼 PostgREST 查询串、判断上游状态码。
// 不搬的：字段规则（title 限 200 字、id 只能字母数字…）—— 那些是业务约束，
//         归接口层。**这个文件里不该出现任何「items 表有哪些字段」的知识。**
//
// 为什么判断标准是「换掉数据库这段代码要不要改」：
//   要改 → 属于这层；不用改 → 属于接口层。
//
// 【为什么每个函数目录各放一份，而不是抽到 cloudfunctions/db.js】
// CloudBase 按函数打包：上传的 zip 里有什么，运行时才有什么。
// 放根目录的话 require('../db') 在云端找不到（zip 里没有父目录），
// 要让 require('./db') 生效就得把 db.js 塞进每个函数的 zip ——
// 那部署时就多一步、多一个能出错的环节。
// 代价是凭据读取那几行在两个 repository 里各存一份。
// 这是Day 17 就记下的取舍：函数数量到四个以上再考虑公共层。
'use strict';

var https = require('https');

// 表名。repository 层知道表叫什么，这是它该知道的。
var TABLE = 'items';
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
// 为什么：部署阶段最常见的失败就是环境变量没生效，而云函数里没法交互式排查。
// 只输出变量名不会泄露凭据，却能让下一次尝试直接对准问题。
function envHint() {
  var keys = Object.keys(process.env || {}).filter(function (k) {
    return /CLOUDBASE|TCB|APIKEY|API_KEY|POSTGRES|^PG/i.test(k);
  });
  return keys.sort().join(', ') || '(一个都没有)';
}

// 调 CloudBase PG 的自动 REST 层（PostgREST）。
// GET  https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/items?<filters>
// POST 同 URL，body 是 JSON 对象
// 用 API Key 鉴权 → 网关把它解成 service_role，绕过 RLS。
// 为什么用 service_role：本环境还没做用户体系，表上也没有 RLS 策略，
// 走「转发调用方 token」那条路会查不到任何行（RLS 零策略 = 全拒）。
//
// 不像 Day 17 那样「非 2xx 就抛错」：POST 需要分辨 409（重复提交）
// 和 400（字段不满足约束），两者的排查动作完全不同 —— 一个去看幂等键，
// 一个去看字段。所以这里把状态码和原文都交回去，让调用方决定。
function pg(method, query, payload) {
  return new Promise(function (resolve, reject) {
    var headers = {
      Authorization: 'Bearer ' + apiKey(),
      Accept: 'application/json'
    };
    var bodyText = null;
    if (payload !== null && payload !== undefined) {
      bodyText = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
      // ★ 关键：return=representation = 插入后把新行返回来，
      //   这样响应里的 data 是数据库真正存进去的东西，而不是我们以为存进去的东西。
      //
      //   故意**不**加 resolution=merge-duplicates —— 那个头会把主键冲突
      //   从「报错」变成「静默 upsert」：重复提交不但不报错，
      //   还会把老那一行覆盖掉。比不防还糟。要让重复提交响亮地失败。
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

// 读：非 2xx 抛错，由接口层统一包成 UPSTREAM（Day 17 的行为，一字未改）。
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

// 读一批。opts = { date, limit }，两个都已经由接口层校验过格式。
// 查询串的拼法顺序固定，方便对着 URL 一眼核对。
function list(opts) {
  var parts = ['select=*'];
  if (opts && opts.date) parts.push('plan_date=eq.' + encodeURIComponent(opts.date));
  parts.push('order=' + encodeURIComponent('plan_date.asc,created_at.asc'));
  parts.push('limit=' + ((opts && opts.limit) || 100));
  return pgRead(parts.join('&'));
}

// 写入一行。row 的字段名和取值范围由接口层校验过了，这里不重复检查 ——
// 重复检查会变成两套规则各自演化，那是分层最容易出bug 的地方。
//
// 返回 { status, text, parsed }：
//   status —— 上游 HTTP 状态码，接口层靠它分 409 / 400 / 5xx
//   text   —— 上游原文，排查时要看
//   parsed —— PostgREST 回读的那一行（数组第一项）；拿不到时是 null
function insert(row) {
  return pg('POST', null, row).then(function (r) {
    var parsed = null;
    try {
      var j = JSON.parse(r.text);
      parsed = Array.isArray(j) ? (j.length ? j[0] : null) : j;
      if (parsed && typeof parsed !== 'object') parsed = null;
    } catch (e) {
      parsed = null;
    }
    return { status: r.status, text: r.text, parsed: parsed };
  });
}

// 有没有凭据。**不抛错也不返回密钥本身**，只回答「有没有」——
// 接口层拿它去决定是报 CONFIG_MISSING 还是继续。
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
  hasCredential: hasCredential,
  credentialHint: credentialHint
};
