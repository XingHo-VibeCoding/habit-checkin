// Day 24 核心链路基线探测 —— 修复前证据
//
// 目的：为「核心流程测试清单」提供**实测基线**，不是照文档抄的预期。
// 每一步都打「实际 HTTP 状态 + 响应体」，出问题时可以直接跟这份对。
//
// 跑法：node probe_day24_core_chain.js
'use strict';
const https = require('https');

const BASE = 'https://habit-checkin-d9giln6ke6594e88b-1499597872.ap-shanghai.app.tcloudbase.com/api';
const TODAY = new Date().toISOString().slice(0, 10);

function call(method, path, body) {
  return new Promise(function (resolve) {
    const u = new URL(BASE + path);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': payload.length } : {})
    }, function (r) {
      const chunks = [];
      r.on('data', function (c) { chunks.push(c); });
      r.on('end', function () {
        const raw = Buffer.concat(chunks).toString('utf8');
        let j = null; try { j = JSON.parse(raw); } catch (e) {}
        resolve({ status: r.statusCode, xver: r.headers['x-version'], json: j, raw: raw });
      });
    });
    req.on('error', function (e) { resolve({ status: 0, err: e.name + ': ' + e.message }); });
    if (payload) req.write(payload);
    req.end();
  });
}

function show(n, r) {
  console.log('\n【' + n + '】');
  console.log('   HTTP ' + r.status + (r.xver ? '   x-version: ' + r.xver : ''));
  const b = r.json ? JSON.stringify(r.json).slice(0, 400) : (r.raw || r.err || '(空)');
  console.log('   ' + b);
}

(async function () {
  // 时间戳做 id —— 演示/测试工具用固定 id 是错的，第二次跑必然 409
  const stamp = Date.now().toString(36);
  const idA = 'probe-' + stamp + '-a';
  const idB = 'probe-' + stamp + '-b';
  const iso = new Date().toISOString();

  console.log('===== Day 24 核心链路基线探测=====');
  console.log('日期: ' + TODAY + '   探测 id: ' + idA + ' / ' + idB);
  console.log('（id 带时间戳：固定 id 第二次跑必然 409，害你重做一遍）');

  // 步骤1打开检查台
  show('步骤1 GET /api/health（打开检查台）', await call('GET', '/health'));

  // 步骤2 读取
  show('步骤 2 GET /api/items?date=' + TODAY + '（读今天，空）', await call('GET', '/items?date=' + TODAY));

  // 步骤3 写入一条
  show('步骤 3 POST /api/items（写入第一条）', await call('POST', '/items', {
    id: idA, title: '基线探测A', plan_date: TODAY, done: 0, created_at: iso, done_at: null
  }));
  show('步骤 3 POST /api/items（写入第二条）', await call('POST', '/items', {
    id: idB, title: '基线探测B', plan_date: TODAY, done: 0, created_at: iso, done_at: null
  }));

  // 步骤4 刷新确认
  show('步骤 4 GET /api/items?date=' + TODAY + '（刷新确认）', await call('GET', '/items?date=' + TODAY));

  // 步骤5 修改
  show('步骤 5 PATCH /api/items/{id}（改标题）', await call('PATCH', '/items/' + idA, { title: '基线探测A改过了' }));
  show('步骤 5 PATCH /api/items/{id}（勾完成 done=1）', await call('PATCH', '/items/' + idA, { done: 1, done_at: iso }));

  // 步骤6 删除
  show('步骤 6 DELETE /api/items/{id}', await call('DELETE', '/items/' + idA));
  show('步骤 6 DELETE 同一条再来一次（幂等性检查）', await call('DELETE', '/items/' + idA));
  show('步骤 6 DELETE 带 ?force=1（显式幂等）', await call('DELETE', '/items/' + idB + '?force=1'));

  // 清理：把B 也删掉，别留垃圾在库里
  await call('DELETE', '/items/' + idB + '?force=1');
  show('收尾 GET /api/items?date=' + TODAY + '（应该又空了）', await call('GET', '/items?date=' + TODAY));

  console.log('\n探测结束，库里已清干净（不残留测试数据）。');
})();