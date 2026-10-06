// cloudfunctions/reminders/remindersRepository.js · 数据访问层（Day 19 拆出）
// ---------------------------------------------------------------------------
// 【这一层只管一件事：怎么跟 reminders 表打交道】
//
// 搬到这里的东西：凭据读取、发 https 请求、拼 PostgREST 查询串。
// 不搬的：item_id 长度限制、limit 范围 —— 那些是接口层的入参校验。
//         **这个文件里不该出现任何「reminders 表有哪些字段」的业务知识。**
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

// 调 CloudBase PG 的自动 REST 层（PostgREST）。
// 用 API Key 鉴权 → 网关把它解成 service_role，绕过 RLS。
// 为什么用 service_role：本环境还没做用户体系，表上也没有 RLS 策略，
// 走「转发调用方 token」那条路会查不到任何行（RLS 零策略 = 全拒）。
//
// 为什么用内置 https 而不是全局 fetch：云函数运行时可能是 Node 16，那时没有 fetch；
// https 模块从 Node 8 就有，不赌运行时版本。
function pg(query) {
  return new Promise(function (resolve, reject) {
    var req = https.request(
      {
        hostname: envId() + '.api.tcloudbasegateway.com',
        path: '/v1/rdb/rest/' + TABLE + (query ? '?' + query : ''),
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
  return pg(parts.join('&'));
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
  hasCredential: hasCredential,
  credentialHint: credentialHint
};
