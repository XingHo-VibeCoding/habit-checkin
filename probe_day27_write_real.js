// 真 fetch 端到端测试：抓 index.html 里的真实写入代码，不打桩，
// 直接发到云端，验证「前端构造的请求」能不能成功。
// 背景：试用反馈「刷新后加/删都变回原样」——云端 curl 验证是通的，
// 所以怀疑前端构造的请求体/路径有问题，而打桩测试护住了它。
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const js = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];

function grab(name) {
  // 抓一个 function/var 声明到下一个顶层声明之前
  const start = js.indexOf('function ' + name);
  if (start < 0) throw new Error('抓不到 ' + name);
  // 找下一个同层声明的起点作为结束（apiSend 后面依次是 toDbItem 等）
  const end = js.indexOf('\n    // 前端字段', start);   // apiSend 之后紧跟着的注释块
  return js.slice(start, end > 0 ? end : undefined);
}

const code = [
  "var API_BASE = 'https://habit-checkin-d9giln6ke6594e88b-1499597872.ap-shanghai.app.tcloudbase.com/api';",
  js.slice(js.indexOf('function apiSend'), js.indexOf('function fetchState'))
].join('\n\n');

// Node 22 有原生 fetch —— 不打桩（fetch 是真的）
// 只给 document 打最小桩：片段里有 getElementById('syncRetryBtn') 的绑定代码，
// 桩让代码能加载；fetch/网络/云端全是真的。
const els = {};
function mkEl() {
  return {
    listeners: {},
    addEventListener: function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    classList: { add(){}, remove(){} },
    setAttribute(){}, disabled: false, textContent: '', style: {}
  };
}
global.document = { getElementById: (id) => (els[id] = els[id] || mkEl()) };

const factory = new Function(code + `\nreturn { apiSend, toDbItem, syncJobs, toDb: toDbItem };`);
const mod = factory();

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '  | ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  | ' + detail); }
}

async function main() {
  console.log('== 真 fetch 端到端：前端代码 → 云端 ==');

  // 1. 模拟真实添加：构造一个跟前端 UI 生成的 item 形状一致的对象
  const it = {
    id: 'diag-real-' + Date.now(),
    title: '真fetch诊断',
    date: '2026-10-17',
    done: false,
    createdAt: new Date().toISOString(),
    doneAt: null
  };
  let body;
  try {
    body = mod.toDb(it);
    check('toDbItem 构造请求体', !!body && typeof body === 'object', JSON.stringify(body));
  } catch (e) {
    check('toDbItem 构造请求体', false, '同步抛错: ' + e.message);
    finish(); return;
  }

  // 2. 真发 POST
  let r1;
  try {
    r1 = await mod.apiSend('POST', '/items', body);
    check('apiSend POST /items', r1.ok === true, r1.ok ? 'ok' : r1.code + ': ' + r1.msg);
  } catch (e) {
    check('apiSend POST /items', false, '同步抛错: ' + e.message);
    finish(); return;
  }

  // 3. 真发 PATCH（勾选）
  try {
    const r2 = await mod.syncJobs.toggle(it.id, true, new Date().toISOString())();
    check('apiSend PATCH 勾选', r2.ok === true, r2.ok ? 'ok' : r2.code + ': ' + r2.msg);
  } catch (e) {
    check('apiSend PATCH 勾选', false, '同步抛错: ' + e.message);
  }

  // 4. GET 回读：验证真的进库了
  try {
    const r3 = await mod.apiSend('GET', '/items/' + encodeURIComponent(it.id));
    const found = r3.ok && Array.isArray(r3.data) && r3.data.some(x => x.id === it.id);
    check('GET 回读（进库确认）', found, found ? '库里有了' : JSON.stringify(r3).slice(0, 120));
  } catch (e) {
    check('GET 回读', false, e.message);
  }

  // 5. 真发 DELETE 清理
  try {
    const r4 = await mod.syncJobs.remove(it.id)();
    check('apiSend DELETE 清理', r4.ok === true, r4.ok ? 'ok' : r4.code + ': ' + r4.msg);
  } catch (e) {
    check('apiSend DELETE 清理', false, '同步抛错: ' + e.message);
  }

  finish();
}

function finish() {
  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail > 0) console.log('结论：前端代码构造的请求在真网络下失败 —— 这就是「刷新后变回原样」的根因方向');
  else console.log('结论：前端代码在真网络下完全正常 —— 问题不在写入代码本身，继续查设备端');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('测试崩溃:', e); process.exit(1); });