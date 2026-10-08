// cloudfunctions/items/itemsRepository.js · 数据访问层（Day 19 拆出）
// ---------------------------------------------------------------------------
// 【这一层只管一件事：怎么跟 items 表打交道】
//
// 搬到这里的东西：凭据读取、发https 请求、拼 PostgREST 查询串、判断上游状态码。
// Day 22 追加：update（改一行）/ remove（删一行）/ exists（这行在不在）。
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
// preferReturn：要不要带 `Prefer: return=representation`（让 PostgREST 回读改动后的行）。
//
// Day 22踩过的坑：**不能靠「有没有 body」推断要不要带这个头。**
// DELETE 不带 body（没东西可送），但它恰恰最需要回读 ——
// 「删掉的那行长什么样」是唯一能证明删对了的东西。
// 所以这里必须是一个显式参数，由调用方按method 决定。
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
      // ★ 关键：return=representation = 改动后把新行返回来，
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

  // Day 22：加了按 id 查单条（GET /api/items/:id）。
  //
  // 【为什么这是今天补的，不是当时就该有的】
  // PATCH/DELETE 上线后，「改完立刻回读这一条」成了刚需 —— 但handleGet
  // 压根不读 path 里的 id，所以 GET /api/items/xxx 返回的是**全部 9 条**。
  // 那个 bug 被藏了很久，因为 Day 17~21 一直是用 ?date= / ?limit= 查列表，
  // 没人走过单条这条路。**没被走过的分支不会被发现。**
  //
  // 用 limit=1 而不是另一个查询：同一张表、同一个凭据，只是多一个过滤条件。
  // 单开一个 getById() 会多一份要维护的路径。
  if (opts && opts.id) parts.push('id=eq.' + encodeURIComponent(opts.id));

  if (opts && opts.date) parts.push('plan_date=eq.' + encodeURIComponent(opts.date));
  parts.push('order=' + encodeURIComponent('plan_date.asc,created_at.asc'));

  // 按 id 查时强制 limit=1：id 是主键，本来就只可能命中一行，
  // 但显式写上限能保证「万一」将来schema 变了也不会静默返回一堆。
  parts.push('limit=' + (opts && opts.id ? 1 : ((opts && opts.limit) || 100)));
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
  return pg('POST', null, row, true).then(readResult);
}

// 回读解析：PostgREST 带 return=representation 时返回数组，第一项就是那一行。
// 抽出来是因为 update / remove 也要用同一套解析，逻辑完全一样。
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

// ============ Day 22：改一行 ============
//
// 【为什么 PATCH 的 body 只放要改的列，不放整行】
// PostgREST 的 PATCH 是「局部更新」：body 里没出现的列保持原值。
// 如果我像 POST 那样把整行拼上去，就得先把当前值读出来再拼回去 ——
// 多一次往返，还多一个「读到的和写入的瞬间之间被人改过」的竞态窗口。
// 只送要改的列，天然没有这类问题。
//
// 【id 为什么要单独放进查询串】
// ?id=eq.<id> —— 「只改 id 等于这一行的行」。
// id 是主键，PostgREST 上 eq. 主键最多命中一行；真出现两行（不该发生，
// 因为 id 就是主键）时 return=representation 会把两行都返回来，
// 接口层会拿数组长度 > 1 判成500 并说明原因，而不是默默取第一行。
function update(id, patch) {
  var q = 'id=eq.' + encodeURIComponent(id);
  return pg('PATCH', q, patch, true).then(readResult);
}

// ============ Day 22：删一行 ============
//
// 【今天要回答的问题：删除为什么比新增更容易出事】
//
//   新增：写错了，**再改一次就行**。数据还在，只是内容不对。
//   删除：**数据没了**。没有「原样恢复」这个操作 —— 只有「重新打一遍」。
//
// 具体到这份代码，删除多踩了三类坑，而新增一个都不踩：
//
//   ① **没有「删错」这个状态可以挽救。** 新增错了会多一行，很少会「少一行」。
//      所以删之前必须有确认 —— 今天在接口层加了 id 不存在时报404 而不是当成功，
//      前端也已经有撤销条（pendingUndo）。**接口层不能替前端做这个决定，
//      只能在删之前把「你确定要删的是哪一行」这件事摆清楚。**
//
//   ② **级联范围容易失控。** items 表的 reminders 用 item_id 外键 +
//      ON DELETE CASCADE。删一条清单，它挂着的提醒**跟着一起没了**。
//      那个提醒是用户自己独立建的（「牙医预约」不挂任何清单，同理
//      「复习第三章 截止」是挂在清单上的）—— 删清单不该顺带删掉提醒。
//      → 今天用返回被删行的方式，让调用方**看得见**连带删掉了什么；
//      真要「删清单但留提醒」，需要另一个接口（那是余力加练的软删除）。
//
//   ③ **重试的语义完全不同。** POST 重复提交会撞主键 → 409，两次发送自动分开。
//      DELETE 重复执行**第二次会「成功地什么都不做」** ——
//      如果接口在找不到行时返回 200，调用方会以为「我删成功了」，
//      实际上第一���请求可能根本没生效。**所以删除找不到行必须报 404，不能报成功。**
//
// remove() 返回 { status, text, parsed }：parsed 是被删掉的那一行。
// 为什么一定要回读：**「删掉了」是没法凭空断言的，得有东西证明。**
function remove(id) {
  var q = 'id=eq.' + encodeURIComponent(id);
  return pg('DELETE', q, null, true).then(readResult);
}

// ============ Day 22：这行在不在 ============
//
// 为什么要单独一个「查在不在」而不是靠 update 的返回判断：
// update 找不到行时PostgREST 返回 **204 No Content**（没有 body 可回读），
// 和「成功改了但要改的值跟原来一样」的 200 分不开。
// 不预查的话，就得靠 204 判「没找到」—— 而 204 在 PostgREST 里语义含糊。
// 先查一次再动手，判据干净得多。
function exists(id) {
  var q = 'id=eq.' + encodeURIComponent(id) + '&select=id&limit=1';
  return pgRead(q).then(function (j) {
    return Array.isArray(j) ? j.length > 0 : !!j;
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
  update: update,      // Day 22
  remove: remove,      // Day 22
  exists: exists,      // Day 22
  hasCredential: hasCredential,
  credentialHint: credentialHint
};
