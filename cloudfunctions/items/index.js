// CloudBase 云函数 /api/items（Day 19 重构：数据库代码已拆到 itemsRepository.js）
// ---------------------------------------------------------------------------
// 作用：读 items 表（GET）、新增一条（POST）、改一条（PATCH）、删一条（DELETE）。
//                                     └── 以上四类 Day 22 补齐，CRUD 闭环完成
//
// 【这一层现在只管三件事】
//   ① 接请求（解析 method / query / body）
//   ② 调函数（校验字段 → 调 repository）
//   ③ 返响应（套契约信封 { ok, data }）
//
// 「怎么读数据库」「怎么拼查询串」「凭据从哪来」全在 itemsRepository.js 里。
// Day 19 重构的判据：**换掉数据库，这段代码要不要改？** 要改 → repository；不用改 → 这里。
//
// 部署方式（控制台）：
//   1. 云函数 → items → 更新代码 → **传 zip，不是粘贴代码**
//      （Day 19 起有两个文件了：index.js + itemsRepository.js，一起打包）
//   2. 函数配置 → 开启「API Key」（或手动加环境变量 CLOUDBASE_APIKEY）
//   3. HTTP 访问服务 → /api/items 路由要同时勾 GET / POST / PATCH / DELETE
//Day 22：每天多勾一个方法，漏勾的表现是「代码上线了但方法不通」
'use strict';

// ★ 唯一一处 require。数据访问层——只经它，不直接碰 https。
var repo = require('./itemsRepository');

var VERSION = 'day23';
var DEFAULT_LIMIT = 100;
var MAX_LIMIT = 200;

// ---------- CORS 白名单（Day 20）----------
//
// 为什么不用通配符 '*'：
// '*' 的意思是「任何网站都能用我账号的权限调这个接口」。自己是单人自用，
// 风险看起来小，但通配符一旦漏到别的站点，别人就能随便读写你的清单。
// 所以改成白名单：只认 ALLOWED_ORIGINS 里列出来的域名。
//
// ⚠️ 关键设计：**读不到白名单时不发这个头，而不是退回 '*'。**
// 「配置漏了」和「配置错了」要表现成同一种失败（浏览器报 CORS 错），
// 这样漏配是显性的、静默降级是隐性的 —— 后者才危险。
//
// 同源请求和 curl 都不带 Origin 头，本来就不需要这个头，照常工作。
var ALLOWED_ORIGINS = (function () {
  var raw = process.env.ALLOWED_ORIGINS || '';
  return raw.split(',').map(function (s) { return s.trim(); })
            .filter(function (s) { return s !== ''; });
})();

// 返回该回的那个 Origin，或 null（本域请求 / 不在白名单里）
function resolveOrigin(origin) {
  if (!origin) return null;              // curl、同源 —— 不需要 CORS 头
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return origin;
  return null;
}

// 字段长度上限。跟 db/schema.sql 里的 VARCHAR(n) 对齐 ——
// 两边数字不一样的话，就会出现「校验过了但数据库截断」或「数据库报错但说不清」。
var MAX_TITLE = 200;
var MAX_ID = 36;
var MAX_TS = 32;

// 允许写入的列。多一个字段都不认（理由见 validateBody）。
var WRITABLE = ['id', 'title', 'plan_date', 'done', 'created_at', 'done_at'];

// Day 22：PATCH 允许改的列。
//
// 【为什么 id 不在里面】—— id 是主键，是这行的身份。
// 改 id 等于「把A 这条改成B 那条」—— 在有外键指向它的时候（reminders.item_id），
// 这会留下指向不存在行的孤儿引用。所以 id 要改只能「删了重建」，不能改。
//
// 【为什么 created_at 也不在里面】—— 它是「这行什么时候被创建的」。
// 改它会让记录失真（比如一条三天前建的任务突然显示成今天建的）。
var PATCHABLE = ['title', 'plan_date', 'done', 'done_at'];

// ① 统一信封。形状由 api-contract.md 定死，换后端实现也不许改。
function ok(data) {
  return { ok: true, data: data };
}
function fail(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

// ============ Day 23：三类错误的人话层（已抽到共享文件） ============
//
// 改前：`fail('UPSTREAM', String(e.message))` —— 页面上的用户看到的是
//      `request to https://... failed, reason: getaddrinfo ENOTFOUND`
// 改后：说人话，并说清「这不是你操作的问题」。
//
// 为什么两个云函数共用一个文件：Day 17~20 每次改 items 都要记得改 reminders，
// 已经漏过一次。两处措辞漂移的话，同一件事就有两种说法，排查更费劲。
//
// 完整说明见 cloudfunctions/errors-human.js。
//
// ⚠️ 为什么这里的 require 要试**两个**路径（Day 23 部署时踩的坑）：
//   仓库里这个文件跟items/ 是兄弟目录，所以路径是 '../errors-human.js'；
//   但**部署时整个函数包会被解压成一个独立的根目录**，父目录根本不存在，
//   只写 '../errors-human.js' 的话，控制台点部署不会报错，
//   一调用就 `Cannot find module '../errors-human.js'` —— 500，而且日志里很难看出是路径问题。
//   （这两个路径我都真跑过：包内自检确实FAIL，报的就是上面那句。）
// → 两个都试：先试包内的 './'（部署后能走这条），再退回 '../'（本地仓库里能走那条）。
var human = (function () {
  try {
    return require('./errors-human.js');
  } catch (e1) {
    return require('../errors-human.js');
  }
})();
var humanValidation = human.humanValidation;
var humanConfig = human.humanConfig;
// 传 log 进去，让原文进日志而不是进响应。
var humanUpstream = function (e) { return human.humanUpstream(e, log); };

// ⚠️ 但有一个例外要小心】上游约束报错（23505 主键冲突那类）
//   **必须**把上游原文带出来 —— 那里面有「id 重复了」这类用户能理解、
//   而且必须知道的细节。所以它不进 catch，走 handlePost / handlePatch
//   自己的 400 分支（见 guessDbReason）。别为了「统一」把有用的信息也抹掉。

// ② HTTP 访问服务的「集成响应」包装：自己给状态码和响应头。
//    X-Version 是部署探针 —— 改完云函数没生效时，先看它变没变。
function withHttp(statusCode, payload, req) {
  var headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // 告诉浏览器「这几个自定义头你随便读」—— 不加这行，fetch 读 X-Version 会得到 null。
    'Access-Control-Expose-Headers': 'X-Version, X-Service, Date',
    'Cache-Control': 'no-store',
    'X-Service': 'habit-checkin',
    'X-Version': VERSION
  };
  // 只在白名单命中时才发 —— 见上面 resolveOrigin 的注释
  var origin = resolveOrigin(req && (req.headers || {})['origin']);
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    // 白名单是精确匹配，不带 Vary: Origin；命中与否两种响应都可能出现，
    // 告诉 CDN 别缓存死。
    headers['Vary'] = 'Origin';
  }
  return {
    statusCode: statusCode,
    headers: headers,
    body: JSON.stringify(payload)
  };
}

// ③ 服务端日志（Day 18 余力加练加的）。一行 key=value，字段固定，方便以后 grep。
//    只记 id 不记 title —— title 是用户自己写的私人内容，日志不该留全文。
//    云函数 stdout 会被平台收进日志中心，报障时先来这里看。
function log(fields) {
  var parts = ['ts=' + new Date().toISOString()];
  for (var k in fields) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) parts.push(k + '=' + fields[k]);
  }
  console.log('[items] ' + parts.join(' '));
}

// ④ 取查询参数。CloudBase 的 HTTP 云函数在不同版本里给的字段不一样：
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

// ⑤ 取并解析请求体。
//     两个坑：① body 可能是 Buffer（网关按二进制传的时候）；
//             ② 可能是 base64 编码的字符串，isBase64Encoded 为 true。
//     只处理 String(body) 的话，这两种都会变成一段乱码 JSON 解析错误，
//     报出来是「请求体不是 JSON」—— 指向错的排查方向。
function parseBody(event) {
  var raw = (event || {}).body;
  if (raw === undefined || raw === null || raw === '') {
    return { error: '请求体是空的。要新增一条请用 POST，并在 body 里传一个 JSON 对象。' };
  }
  // 网关已经解析好的对象，直接用。
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) return { value: raw };
  var text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if ((event || {}).isBase64Encoded) {
    try {
      text = Buffer.from(text, 'base64').toString('utf8');
    } catch (e) {
      return { error: '请求体是 base64 编码的，但解不开。' };
    }
  }
  try {
    return { value: JSON.parse(text) };
  } catch (e2) {
    return { error: '请求体不是合法的 JSON。检查一下有没有多逗号、单引号，或中文引号「」。' };
  }
}

// ⑥ 校验 limit。
//    为什么设上限：不设的话 ?limit=99999999 会把整表拉回来，读接口被打成全表扫描。
function toLimit(raw) {
  var s = raw == null ? String(DEFAULT_LIMIT) : String(raw);
  if (!/^\d+$/.test(s)) return { error: 'limit 必须是正整数，收到 "' + s + '"' };
  var n = Number(s);
  if (n < 1 || n > MAX_LIMIT) return { error: 'limit 必须在 1–' + MAX_LIMIT + ' 之间，收到 ' + s };
  return { value: n };
}

// ⑦ 「格式对」不等于「这个日子存在」。'2026-02-31' 能过 /^\d{4}-\d{2}-\d{2}$/，
//     但 2 月没有 31 号。数据库的 CHECK 只查格式，会放它过关；
//     所以这里多查一层真实存在性 ——
//     宁可现在告诉用户「这天不存在」，也别写进去之后排序时才发现。
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var y = Number(s.slice(0, 4));
  var m = Number(s.slice(5, 7));
  var d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  var dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[m - 1];
}

function isIsoString(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_TS) return false;
  return !isNaN(Date.parse(s));
}

// ⑧ 校验并组装要插入的一行。返回 { row } 或 { error }（中文，直接给用户看）。
//
//     【为什么 id 必填、而且由客户端生成】—— 这就是防重复提交的全部机制：
//     id 是幂等键。同一条内容提交两次，两次带的是同一个 id，第二次撞主键 → 409。
//     于是「重复提交被拒」和「内容不同的两条都正常入库」自动分开了，
//     不需要额外的查重逻辑。
//     反过来，如果 id 由服务端每次现生成，手快点两下就是两条不同 id 的记录，
//     幂等键形同虚设。**发请求的一方必须持有 id**。
//
//     【为什么不靠「标题查重」】：那会把合法内容也挡掉
//     （今天读两本书，第二本不叫重复），而且查重和插入之间有时间差，是竞态。
function validateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是一个 JSON 对象，形如 {"id":"...","title":"...","plan_date":"2026-10-06"}。' };
  }

  // 拒绝未知字段。前端字段名是 date / createdAt / doneAt（见 api-contract 的映射表），
  // 如果哪天真忘了转换就发过来，静默忽略会得到一个 plan_date 为空的请求，
  // 数据库只回一句 NOT NULL violation —— 指向错误的排查方向。
  // 明确报出「不认识的字段名」，一看就知道是拼错了还是没做映射。
  var extra = [];
  for (var k in body) {
    if (Object.prototype.hasOwnProperty.call(body, k) && WRITABLE.indexOf(k) < 0) extra.push(k);
  }
  if (extra.length) {
    return { error: '不认识的字段：' + extra.join('、') + '。可写字段只有：' + WRITABLE.join('、') + '。' };
  }

  // id（幂等键）
  var id = body.id;
  if (id === undefined || id === null || id === '') {
    return { error: '缺 id。id 是防重复提交的幂等键，必须由你（调用方）生成并带上，重试时用同一个 id。' };
  }
  if (typeof id !== 'string') return { error: 'id 必须是字符串，收到 ' + typeof id + '。' };
  if (id.length > MAX_ID) return { error: 'id 太长了（' + id.length + ' 字），最多 ' + MAX_ID + ' 字。' };
  // 字符集收窄到「字母数字 - _」。id 会拼进 PostgREST 的 URL 查询串，
  // 放过 & ? / # 这类字符就是在给自己造注入面和URL 解析坑。
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return { error: 'id 只能含字母、数字、下划线和连字符，收到 "' + id + '"。' };
  }

  // title
  var title = body.title;
  if (title === undefined || title === null || title === '') {
    return { error: '缺 title（要做的事情）。' };
  }
  if (typeof title !== 'string') return { error: 'title 必须是字符串，收到 ' + typeof title + '。' };
  var t = title.trim();
  if (!t) return { error: 'title 不能是空字符串或只有空格。' };
  if (t.length > MAX_TITLE) {
    return { error: 'title 太长了（' + t.length + ' 字），最多 ' + MAX_TITLE + ' 字 —— 手机上一行显示不完，请改短。' };
  }

  // plan_date
  var planDate = body.plan_date;
  if (planDate === undefined || planDate === null || planDate === '') {
    return { error: '缺 plan_date（计划做哪一天），格式 "YYYY-MM-DD"，例如 "2026-10-06"。' };
  }
  if (typeof planDate !== 'string') return { error: 'plan_date 必须是字符串，收到 ' + typeof planDate + '。' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) {
    return { error: 'plan_date 必须是 YYYY-MM-DD，收到 "' + planDate + '"。' };
  }
  if (!isRealDate(planDate)) {
    return { error: 'plan_date "' + planDate + '" 不是个真实存在的日子（比如 2 月没有 31 号）。' };
  }

  // done：可选，默认 0；只收 0 或 1。
  var done = (body.done === undefined || body.done === null) ? 0 : body.done;
  if (done !== 0 && done !== 1) {
    return { error: 'done 只能是 0（没做）或 1（做完了），收到 ' + JSON.stringify(done) + '。' };
  }

  // created_at：可选，省略就用服务器当前时间（UTC ISO 串）。
  var createdAt = body.created_at;
  if (createdAt === undefined || createdAt === null || createdAt === '') {
    createdAt = new Date().toISOString();
  } else if (!isIsoString(createdAt)) {
    return { error: 'created_at 要么省略，要么是能解析的时间串（ISO 8601），收到 ' + JSON.stringify(createdAt) + '。' };
  }

  // done_at：可空。没做完就是 null —— 不用 '' 或 0 当哨兵值，
  // 哨兵值的代价是将来一定有人忘了判断它。
  var doneAt = (body.done_at === undefined) ? null : body.done_at;
  if (doneAt !== null && !isIsoString(doneAt)) {
    return { error: 'done_at 要么省略，要么是 null，要么是能解析的时间串，收到 ' + JSON.stringify(doneAt) + '。' };
  }
  if (doneAt !== null && done !== 1) {
    return { error: 'done 是 0（还没做），却又给了 done_at —— 这两件事矛盾了。' };
  }

  return { row: { id: id, title: t, plan_date: planDate, done: done, created_at: createdAt, done_at: doneAt } };
}

// ⑨ POST 分支。校验 → 插入 → 把数据库真正存进去的那一行原样返回。
async function handlePost(event, startedAt) {
  var parsed = parseBody(event);
  if (parsed.error) {
    log({ m: 'POST', st: 'bad_body', ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST', parsed.error), event);
  }

  var v = validateBody(parsed.value);
  if (v.error) {
    log({ m: 'POST', st: 'invalid', ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST', v.error), event);
  }

  var row = v.row;
  var r = await repo.insert(row);

  // ★ 主键撞了 = 重复提交。同一个 id 第二次进来，就走到这里。
  //   200/201 之外一律按失败处理，绝不「假装成功」——
  //   前端拿到 ok:true 就会把这条从待办里划掉，而库里其实根本没这一行。
  if (r.status === 409 || /23505|duplicate key/i.test(r.text)) {
    log({ m: 'POST', id: row.id, st: 'duplicate', ms: Date.now() - startedAt });
    return withHttp(409, fail('DUPLICATE',
      '这个 id 已经在清单里了（重复提交）。id 是防重复提交的幂等键 —— 如果你确实想加两条不同的内容，请换一个 id。'), event);
  }

  // 字段没满足数据库约束（比如漏了 NOT NULL、CHECK 没过）。
  // 我们的校验已经挡了大部分，漏到这里的说明两边规则不一致。
  //
  // Day 23：**原文不再直接拼给用户**。PostgREST 的英文原文长这样：
  //   `null value in column "title" violates not-null constraint`
  // 用户看到它只会懵 —— 哪个title？什么 not-null？
  // 改成先猜一个**可能的**中文说法，并且**明说是推测**（不要假装确定）。
  //
  // ⚠️ 原文仍要留（去日志），因为「两边规则不一致」这种问题只有对照原文才查得出来。
  if (r.status === 400 || r.status === 422) {
    log({ m: 'POST', id: row.id, st: 'rejected_detail', up: r.status, raw: String(r.text).slice(0, 300) });
    return withHttp(400, fail('BAD_REQUEST',
      '这一条没能存进数据库：' + guessDbReason(r.text) +
      '如果反复出现，说明页面和数据库的字段对不上，请联系开发。'), event);
  }


  if (r.status < 200 || r.status >= 300) {
    log({ m: 'POST', id: row.id, st: 'upstream', up: r.status, ms: Date.now() - startedAt });
    // Day 23：**改前** 'PG REST 返回 ' + r.status + '：' + r.text.slice(0, 300)
    //   → 用户看到 `PG REST 返回 503：upstream connect error...`
    //   状态码和 PostgREST 原文都是给排查看的，不该直接拼给人。
    //   原文留进日志（上面那行log 里补raw），人话走 humanUpstream。
    log({ m: 'POST', id: row.id, st: 'upstream_detail', up: r.status, raw: String(r.text).slice(0, 300) });
    return withHttp(502, fail('UPSTREAM', humanUpstream(new Error('PG REST 返回 ' + r.status + '：' + r.text))), event);
  }

  // 201/200 + return=representation → repository 已把回读的那一行解析好。
  // 原样返回：前端看到的和库里存的是同一份，不存在「以为存进去了」。
  // 万一网关把 Prefer 头吃掉了（parsed 为 null），退回发过去的这一行——
  // 至少形状对，而且日志里 st=inserted_noread 就是这个信号。
  if (!r.parsed) {
    log({ m: 'POST', id: row.id, st: 'inserted_noread', ms: Date.now() - startedAt });
    return withHttp(201, ok(row), event);
  }
  log({ m: 'POST', id: row.id, st: 'inserted', ms: Date.now() - startedAt });
  return withHttp(201, ok(r.parsed), event);
}

//把数据库的英文约束错误翻成「能看懂但不死咬」的中文。
//
//刻意做成**推测**而不是断言：约束错误种类很多，我不可能全cover，
//猜错比不给更糟 —— 会让人去查一个不存在的问题。
//所以每句都带「可能」，并统一给出「不对就联系开发」的出口。
function guessDbReason(text) {
  var t = String(text || '').toLowerCase();

  if (t.indexOf('not-null') >= 0 || t.indexOf('null value') >= 0) {
    var col = String(text).match(/column "([^"]+)"/);
    return '可能有必填项是空的' + (col ? '（字段 ' + col[1] + '）' : '') + '。';
  }
  if (t.indexOf('too long') >= 0 || t.indexOf('character varying') >= 0 ||
      t.indexOf('value too long') >= 0) {
    var col2 = String(text).match(/column "([^"]+)"/);
    return '某一项太长了' + (col2 ? '（字段 ' + col2[1] + '）' : '') + '，请缩短一点。';
  }
  if (t.indexOf('check') >= 0 || t.indexOf('chk_') >= 0) {
    return '某一项的值不符合要求（比如日期格式、勾选只能是 0 或 1）。';
  }
  if (t.indexOf('duplicate') >= 0 || t.indexOf('unique') >= 0 || t.indexOf('23505') >= 0) {
    return '有一条内容跟现有的重了。';
  }
  // 认不出来就实说认不出来 —— 这比编一个像模像样的原因诚实。
  return '数据库给出的原因无法理解（这本身就是个需要排查的问题）。';
}

// ⑩ GET 分支。Day 17 的逻辑，一字未改。
async function handleGet(event, startedAt) {
  var q = parseQuery(event);

  // Day 22：读路径里的 id，支持「查单条」。
  //
  // 之前这里完全不读 id，所以 GET /api/items/seed-item-01 会返回**全部 9 条** ——
  // 传了 id 却当没传。发现它是因为 PATCH/DELETE 上线后需要「改完回读这一条」。
  //
  // ⚠️ 这跟路由没配有关，但**不是同一个问题**：就算网关把 id 传进来，
  // 这里不读也还是返回全部。两个都得修，缺一个都走不通。
  var id = pathId(event);

  // Day 23 审计补的：GET 的 id 也要校验格式。
  //   PATCH / DELETE 分支一直有这道校验（Day 22 加的），唯独 GET 没有——
  //   于是 `GET /api/items/任意一串垃圾` 会直接拼进 URL 发给数据库。
  //   现在三处口径一致了：**id 一律先查格式，再拿去查库**。
  //   长度上限 36 是跟数据库 CHAR(36) 对齐。
  if (id.length > 36) {
    return withHttp(400, fail('BAD_REQUEST', 'id 太长了（' + id.length + ' 字），最多 36 字。'), event);
  }
  if (id && !/^[A-Za-z0-9_-]+$/.test(id)) {
    return withHttp(400, fail('BAD_REQUEST',
      'id 只能含字母、数字、下划线和连字符，收到 "' + id + '"。'), event);
  }

  // date 过滤（YYYY-MM-DD）。库里 plan_date 就是 CHAR(10)，格式对不上直接 400，
  // 别把非法值拼进 URL 让数据库去报语法错 —— 那样的错误信息前端没法看。
  //
  // Day 23 审计补的一条：**只查格式不够，还得查这日子存不存在**。
  //   '2026-02-31' 能过 /^\d{4}-\d{2}-\d{2}$/，但 2 月没有 31 号。
  // 改之前它被拼进 URL 发给数据库，数据库 CHAR(10) 照单全收，
  // 于是「查一个不存在的日子」返回 200 + 空数组 —— 跟「这天真的没待办」长得一模一样。
  // 那是最难查的一类错：数据没丢，前端也不报错，只是某天清单永远是空的。
  // 现在跟 POST/PATCH 一样走 isRealDate，挡在发请求之前。
  var date = (q.date == null) ? '' : String(q.date);
  var dateStr = String(date);
  if (date && !isRealDate(dateStr)) {
    // 格式不对和「日子不存在」分开说：前者是打错了，后者是打对了但不存在，
    // 用户改的方式不一样（改格式 vs 换一个真实存在的日子）。
    var fmtBad = !/^\d{4}-\d{2}-\d{2}$/.test(dateStr);
    return withHttp(400, fail('BAD_REQUEST',
      fmtBad
        ? 'date 必须是 YYYY-MM-DD，收到 "' + date + '"'
        : 'date 格式对，但不是个真实存在的日子，收到 "' + date + '"（2026 年 2 月没有 31 号这样的日期）。'),
      event);
  }

  var lim = toLimit(q.limit);
  if (lim.error) return withHttp(400, fail('BAD_REQUEST', lim.error), event);

  // Day 23：跟 reminders 侧同一条改动 —— 不认识的查询参数要说出来，不能当没看见。
  //   `?titel=xxx`（拼错了）以前会被静默忽略，调用方拿到 200 + 全量数据，
  //   以为筛过了其实没筛。这类错不产生任何错误信号，最难查。
  //   只在**只传了一个陌生键**时报错（多键混传时放行，避免网关塞的参数把正常请求打死）。
  //
  //   `id` 在白名单里：它是 Day 22 特意留的兜底通道 —— 路径 /api/items/{id}
  //   依赖网关的「路径透传」开关，万一哪天开关被关了，还有 ?id= 这条路能通。
  //   容错通道不能被安全检查误伤。
  var KNOWN_Q = ['date', 'limit', 'id'];
  var qkeys = Object.keys(q);
  if (qkeys.length === 1 && KNOWN_Q.indexOf(qkeys[0]) < 0) {
    return withHttp(400, fail('BAD_REQUEST',
      '不认识的查询参数 "' + qkeys[0] + '"。这个接口只认：date、limit、id（都可以不传）；要按某一条查请用路径 /api/items/{id}。'),
      event);
  }

  // ★ 只调 repository —— 查询串怎么拼、凭据从哪来，它自己知道。
  var rows = await repo.list({ id: id, date: dateStr, limit: lim.value });
  log({ m: 'GET', st: 'ok', n: Array.isArray(rows) ? rows.length : -1, ms: Date.now() - startedAt });

  // 按 id 查却没查到 → 404，不要返回空数组。
  //
  // 为什么：查单条时的语义是「我要这一条」，返回 [] 会让调用方以为
  // 「拿到了，只是没有」—— 于是它可能接着当成「已删除」或「不存在」去处理，
  // 而真相是 id 写错了。404 才说得出「你找的那条不存在」。
  // （不带 id 时返回 [] 是正常的，那是「今天没有待办」，不是错误。）
  if (id && (!Array.isArray(rows) || rows.length === 0)) {
    return withHttp(404, fail('NOT_FOUND', '清单里没有 id 为 "' + id + '" 的这一条。'), event);
  }

  // 直接返回数据库列名，不做前端字段映射。
  // 映射（items.date ↔ plan_date 等）是前端接入时的事，
  // 今天先保证「库里有什么，接口就吐什么」，避免两处同时改、出错时分不清哪边的锅。
  return withHttp(200, ok(rows), event);
}

// ⑪ Day 22：取出路径里的 id。
//
//     为什么用 pathParameters 而不是 query：
//     契约写的是 `/api/items/:id`（RESTful 惯例），网关会把它放进 pathParameters。
//     但 CloudBase 不同控制台版本给的字段不一样（有的给 rawPath），
//     所以 query 里也认一下—— 同一个 id 从哪来都能跑，别赌一个。
//
//     ⚠️ 收窄字符集跟 POST 的 id 一样（字母数字 - _）。
//     这个值会直接拼进 PostgREST 的 URL 查询串，放过 & ? / # 就是给自己造注入面。
function pathId(event) {
  var e = event || {};
  var raw = '';
  var pp = e.pathParameters || {};
  if (pp && pp.id !== undefined && pp.id !== null) raw = String(pp.id);
  if (!raw && e.path) {
    // path 可能形如 /api/items/abc123，也可能是完整 URL
    var m = String(e.path).match(/\/api\/items\/([^/?#]+)/);
    if (m) raw = m[1];
  }
  if (!raw) {
    var q = parseQuery(e);
    if (q.id !== undefined && q.id !== null && String(q.id) !== '') raw = String(q.id);
  }
  return decodeURIComponent(raw);
}

// ⑫ Day 22：校验 PATCH 的 body，返回要改的列。
//
//     【与 POST 校验的三个区别，都是有原因的】
//
//     ① **id 不再必填。** POST 的 id 是幂等键（新建时必须给），
//        PATCH 的 id 在 URL 上 —— body 里再带一份反而可能出现
//        「URL 说改A、body 说改B」，那时该信哪个？一律只认 URL。
//
//     ② **没有任何一个字段是必填的。** `{}`（空对象）虽然合法但没意义，
//        直接拒—— 静默成功的请求最难查。
//
//     ③ **字段间的矛盾检查要看「合并后」的状态，不能只看 body。**
//        最典型的：把 done 改成 1 但不给 done_at，应该自动补上当前时间；
//        而把 done 改成 0 却留着 done_at，就是矛盾。
//        只看 body 会漏掉「body 里的 done_at 和库里的 done 打架」这种情况。
function validatePatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是一个 JSON 对象，形如 {"done":1} 或 {"title":"新标题","plan_date":"2026-10-08"}。' };
  }

  var keys = Object.keys(body);
  if (!keys.length) {
    return { error: 'body 是空的 —— 没有任何要改的字段。PATCH 至少要改一样东西。' };
  }

  var extra = [];
  for (var i = 0; i < keys.length; i++) {
    if (PATCHABLE.indexOf(keys[i]) < 0) extra.push(keys[i]);
  }
  if (extra.length) {
    return {
      error: '这些字段不能改：' + extra.join('、') + '。' +
             '可改的只有：' + PATCHABLE.join('、') + '。' +
             '（id 是身份、created_at 是创建时间，都不该被改；想换 id 请删了重建）'
    };
  }

  var patch = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string') return { error: 'title 必须是字符串，收到 ' + typeof body.title + '。' };
    var t = body.title.trim();
    if (!t) return { error: 'title 不能是空字符串或只有空格（要改空，那就删掉这条）。' };
    if (t.length > MAX_TITLE) {
      return { error: 'title 太长了（' + t.length + ' 字），最多 ' + MAX_TITLE + ' 字 —— 手机上一行显示不完，请改短。' };
    }
    patch.title = t;
  }

  if (body.plan_date !== undefined) {
    if (typeof body.plan_date !== 'string') return { error: 'plan_date 必须是字符串，收到 ' + typeof body.plan_date + '。' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.plan_date)) {
      return { error: 'plan_date 必须是 YYYY-MM-DD，收到 "' + body.plan_date + '"。' };
    }
    if (!isRealDate(body.plan_date)) {
      return { error: 'plan_date "' + body.plan_date + '" 不是个真实存在的日子（比如 2 月没有 31 号）。' };
    }
    patch.plan_date = body.plan_date;
  }

  if (body.done !== undefined) {
    // done 在库里是 SMALLINT 0/1，**不是boolean**。
    // 收 JSON 的 true 会被 PostgreSQL 拒（invalid input syntax for type smallint），
    // 所以这里只认 0 和 1 —— 跟 POST 完全一致，不给「方便」开后门。
    if (body.done !== 0 && body.done !== 1) {
      return { error: 'done 只能是 0（没做）或 1（做完了），收到 ' + JSON.stringify(body.done) + '。' };
    }
    patch.done = body.done;
  }

  if (body.done_at !== undefined && body.done_at !== null) {
    if (!isIsoString(body.done_at)) {
      return { error: 'done_at 要么省略，要么是 null，要么是能解析的时间串，收到 ' + JSON.stringify(body.done_at) + '。' };
    }
    patch.done_at = body.done_at;
  }

  // 合并后的矛盾检查。理由见函数头③。
  //注意：**done_at 显式给了就尊重它**（可能是在补录历史完成时间），
  // 不强制改成「现在」。但 done=0 却带 done_at 必须拒。
  var mergedDone = (patch.done !== undefined) ? patch.done : null;
  if (mergedDone === 0 && patch.done_at !== undefined && patch.done_at !== null) {
    return { error: 'done 是 0（还没做），却又给了 done_at —— 这两件事矛盾了。' };
  }

  return { patch: patch };
}

// ⑬ Day 22：PATCH 分支。
//     流程：校验 body → 确认这行存在（404）→ 改 → 回读数据库真正那行。
//
//     【顺序为什么是「先查存在再改」】
//     PostgREST 的 PATCH 在找不到行时返回 **204 No Content**（没有 body），
//     和「成功改了，但改成的值恰好跟原来一样」的 200 分不开。
//     不预查的话就只能靠 204 判「没找到」，判据含糊。
//     预查一次多一个RTT，换来一个干净的 404，值得。
async function handlePatch(event, startedAt) {
  var id = pathId(event);
  if (!id) {
    return withHttp(400, fail('BAD_REQUEST',
      'URL 里没有 id。改一条要写成 /api/items/<id>，例如 /api/items/' +
      '（注意 CloudBase 网关的路由要配成 /api/items/{id} 或 /api/items/*，才能把 id 传进来）。'), event);
  }
  if (id.length > MAX_ID) return withHttp(400, fail('BAD_REQUEST', 'id 太长了（' + id.length + ' 字）。'), event);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return withHttp(400, fail('BAD_REQUEST', 'id 只能含字母、数字、下划线和连字符，收到 "' + id + '"。'), event);
  }

  var parsed = parseBody(event);
  if (parsed.error) {
    log({ m: 'PATCH', id: id, st: 'bad_body', ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST', parsed.error), event);
  }

  var v = validatePatch(parsed.value);
  if (v.error) {
    log({ m: 'PATCH', id: id, st: 'invalid', ms: Date.now() - startedAt });
    return withHttp(400, fail('BAD_REQUEST', v.error), event);
  }

  // 这行在不在
  var found = await repo.exists(id);
  if (!found) {
    log({ m: 'PATCH', id: id, st: 'not_found', ms: Date.now() - startedAt });
    return withHttp(404, fail('NOT_FOUND', '清单里没有 id 为 "' + id + '" 的这一条 —— 可能已经被删了。'), event);
  }

  // done: 0 → 1 且没给 done_at 时，自动补当前时间。
  // 这是「打卡」动作的完整语义：勾上的那一刻就是完成的那一刻。
  // 反过来（done: 1 → 0）要把 done_at 置 null，否则会留下
  // 「未完成却有一个完成时间」的脏数据。
  var patch = v.patch;
  if (patch.done === 1 && patch.done_at === undefined) {
    patch.done_at = new Date().toISOString();
  }
  if (patch.done === 0) {
    patch.done_at = null;
  }

  var r = await repo.update(id, patch);

  if (r.status === 404) {
    log({ m: 'PATCH', id: id, st: 'gone', ms: Date.now() - startedAt });
    return withHttp(404, fail('NOT_FOUND', '这一条在改动过程中被删掉了。'), event);
  }
  if (r.status < 200 || r.status >= 300) {
    log({ m: 'PATCH', id: id, st: 'upstream', up: r.status, ms: Date.now() - startedAt });
    // Day 23：原文不再拼给人（改前是 'PG REST 返回 ' + r.status + '：' + r.text）。
    // 原文留进日志，人话走 humanUpstream。
    log({ m: 'PATCH', id: id, st: 'upstream_detail', up: r.status, raw: String(r.text).slice(0, 300) });
    return withHttp(502, fail('UPSTREAM', humanUpstream(new Error('PG REST 返回 ' + r.status + '：' + r.text))), event);
  }

  if (!r.parsed) {
    // PATCH 走到这里还没 body：多半是 Prefer 头被网关吃了。
    // 不猜，直接报—— 报「不确定有没有改成」比报「改成了」诚实。
    log({ m: 'PATCH', id: id, st: 'updated_noread', ms: Date.now() - startedAt });
    return withHttp(200, ok({
      id: id,
      changed: patch,
      reread: null,
      note: '改动已发出，但没能回读数据库确认。请重新 GET 一次核对。'
    }), event);
  }

  log({ m: 'PATCH', id: id, st: 'updated', f: Object.keys(patch).join('+'), ms: Date.now() - startedAt });
  // 返回数据库里真正那行（不是我们发过去的 patch）——
  // 这样前端拿到的 title/plan_date/done 一定跟库里一致。
  return withHttp(200, ok(r.parsed), event);
}

// ⑭ Day 22：DELETE 分支。
//
//【今天最重要的一条：删除找不到行，必须报 404，不能报成功】
//
//     为什么？这是新增和删除**最不对称的地方**：
//
//       POST  重复发 → 撞主键 → 409。两发请求天然分开，不会静默。
//       DELETE 重复发 → 第二次「成功地什么都没做」。
//
//     如果这里返回 200，调用方（前端、同伴、以后任何一个脚本）会以为
//     「我删成功了」，而真实情况可能是第一���请求压根没生效 ——
//     数据还在，但调用方以为已经清掉了。这种谎报比报错危险得多：
//     报错会让人去查，谎报只会让人接着往下走。
//
//     → 所以：**0 行被删 = 404 NOT_FOUND。**
//     要幂等重试的场景（比如「确保这条不在了」），让调用方显式带?force=1。
async function handleDelete(event, startedAt) {
  var id = pathId(event);
  if (!id) {
    return withHttp(400, fail('BAD_REQUEST',
      'URL 里没有 id。删一条要写成 /api/items/<id>。'), event);
  }
  if (id.length > MAX_ID) return withHttp(400, fail('BAD_REQUEST', 'id 太长了（' + id.length + ' 字）。'), event);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return withHttp(400, fail('BAD_REQUEST', 'id 只能含字母、数字、下划线和连字符，收到 "' + id + '"。'), event);
  }

  var q = parseQuery(event);
  var force = q.force === '1' || q.force === 'true';

  var found = await repo.exists(id);
  if (!found && !force) {
    log({ m: 'DELETE', id: id, st: 'not_found', ms: Date.now() - startedAt });
    return withHttp(404, fail('NOT_FOUND',
      '清单里没有 id 为 "' + id + '" 的这一条 —— 也许已经被删过了。' +
      '如果你要的是「确保它不在」（幂等删除），加 ?force=1。'), event);
  }

  var r = await repo.remove(id);

  if (r.status === 404) {
    log({ m: 'DELETE', id: id, st: 'gone', ms: Date.now() - startedAt });
    return withHttp(404, fail('NOT_FOUND', '这一条在删除过程中消失了。'), event);
  }
  if (r.status < 200 || r.status >= 300) {
    log({ m: 'DELETE', id: id, st: 'upstream', up: r.status, ms: Date.now() - startedAt });
    // Day 23：同上，DELETE 分支的原文也不进响应。
    log({ m: 'DELETE', id: id, st: 'upstream_detail', up: r.status, raw: String(r.text).slice(0, 300) });
    return withHttp(502, fail('UPSTREAM', humanUpstream(new Error('PG REST 返回 ' + r.status + '：' + r.text))), event);
  }

  // PostgREST 带 return=representation 时 DELETE 也回读被删掉的那行。
  // parsed === null 表示一行都没删到（不该发生，前面exists 已经挡过）。
  var deleted = r.parsed;
  log({
    m: 'DELETE', id: id,
    st: deleted ? 'deleted' : 'deleted_noread',
    cascaded: '见响应里的 reminders_would_cascade',
    ms: Date.now() - startedAt
  });

  return withHttp(200, ok({
    deleted: !!deleted,
    row: deleted,
    // 把被删掉的那行原样还回去 —— 唯一的证据。
    // 前端要用它做撤销条（「已删除「xxx」」+ 撤销），
    // 没有回读的话前端只能靠自己那份内存，刷新就没了。
    note: deleted ? '已删除。row 是从数据库回读的那一行，可用于撤销。'
                  : '删除已执行，但没能回读确认（Prefer 头可能没生效）。'
  }), event);
}

// ⑮ 入口。
exports.main = async function (event) {
  //Day 23 审计改的一行。之前是 `var method = (event && event.httpMethod) || 'GET'`，
  // 也就是**event整个是 null、或者 event 存在但没有 httpMethod 字段，都默默按 GET 处理**。
  //
  // 为什么这比看起来严重：默认成 GET 意味着「连请求方法都没有」这种彻底坏掉的调用，
  // 会拿到一份 200 + 数据。看起来像成功，实际是网关配置错了或者 event 结构变了。
  // 而这类错误的正确表现是**响亮地失败**—— 少了信息就报缺信息，别猜。
  //
  // 保留一个小口子：httpMethod 为空字符串 / null 时仍按 GET 处理。
  // 因为确实有网关在某些配置下不带这个字段（那是合法的「没说是啥方法」）；
  // 但 event 连对象都不是，那是上游出错了，不能装作没事。
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
  var startedAt = Date.now();

  // 浏览器跨域发 POST 之前会先发 OPTIONS 探路（问「这个方法、这个头允许吗」）。
  // 不回应的话，真正的 POST 根本发不出去 —— 浏览器报的是 CORS 错，
  // 跟函数逻辑毫无关系，很容易查错方向。
  if (method === 'OPTIONS') {
    return withHttp(204, ok(null), event);
  }

  // 方法守卫：只放行契约里有的四种。契约要可预测，
  // 返回 200 或凭空支持 PUT 都会误导调用方。
  //
  // 405 必须带 Allow 头（RFC 7231 要求）—— 不带的话有些客户端报的是
  // 「方法不支持」而不是「405」，排查时容易以为是网关拦的。
  var ALLOWED = ['GET', 'POST', 'PATCH', 'DELETE'];
  if (ALLOWED.indexOf(method) < 0) {
    var r405 = withHttp(405, fail('METHOD_NOT_ALLOWED',
      '这个接口只支持 ' + ALLOWED.join(' / ') + '，收到 ' + method + '。'), event);
    r405.headers.Allow = ALLOWED.join(', ');
    return r405;
  }

  try {
    // 先查凭据，缺了就直接说缺哪个 —— 别等到请求发出去报 401 才猜。
    if (!repo.hasCredential()) {
      var hint = repo.credentialHint();
      return withHttp(500, fail('CONFIG_MISSING', humanConfig(hint)), event);
    }

    if (method === 'POST') return await handlePost(event, startedAt);
    if (method === 'PATCH') return await handlePatch(event, startedAt);
    if (method === 'DELETE') return await handleDelete(event, startedAt);
    return await handleGet(event, startedAt);
  } catch (e) {
    log({ m: method, st: 'error', ms: Date.now() - startedAt });
    // Day 23：不再把 e.message 直接吐给用户（那是一句英文裸报错）。
    // 原文挪进 log({ err })，人话走 humanUpstream。
    return withHttp(500, fail('UPSTREAM', humanUpstream(e)), event);
  }
};
