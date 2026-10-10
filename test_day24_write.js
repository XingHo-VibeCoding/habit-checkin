// Day 24 写入层验证：不依赖浏览器，直接抓 toDbItem / syncJobs 的输出
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');

// 把要测的片段抠出来跑
const grab = (name) => {
  // syncJobs 是 var 声明的，不是 function —— 两种前缀都得试
  let i = html.indexOf('function ' + name);
  let prefix = 'function ';
  if (i < 0) { i = html.indexOf('var ' + name); prefix = 'var '; }
  if (i < 0) throw new Error('找不到 ' + name);
  let depth = 0, started = false;
  for (let j = i; j < html.length; j++) {
    if (html[j] === '{') { depth++; started = true; }
    else if (html[j] === '}') { depth--; if (started && depth === 0) return html.slice(i, j + 1); }
  }
};

const code = [grab('toDbItem'), grab('syncJobs')].join('\n');
eval(code);

let pass = 0, fail = 0;
const check = (n, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

console.log('-- Day 24 写入层验证 --');

// ★ done 必须是 0/1，这是契约第 4 条
const doneTrue = toDbItem({ id:'a', title:'t', date:'2026-10-09', done:true, createdAt:'2026-10-09T01:00:00.000Z', doneAt:'2026-10-09T02:00:00.000Z' });
const doneFalse = toDbItem({ id:'b', title:'t', date:'2026-10-09', done:false, createdAt:'2026-10-09T01:00:00.000Z', doneAt:null });

check('done:true → 1（不是 boolean）', doneTrue.done === 1, doneTrue.done);
check('done:false → 0（不是 boolean）', doneFalse.done === 0, doneFalse.done);
check('★ 库里 done 是 SMALLINT，boolean 会被类型约束拒掉', typeof doneTrue.done === 'number', typeof doneTrue.done);

check('date → plan_date', doneTrue.plan_date === '2026-10-09', doneTrue);
check('createdAt → created_at', doneTrue.created_at === '2026-10-09T01:00:00.000Z', doneTrue);
check('doneAt → done_at', doneTrue.done_at === '2026-10-09T02:00:00.000Z', doneTrue);
check('未完成时 done_at 是 null（不是空串/undefined）', doneFalse.done_at === null, doneFalse.done_at);

// ★ POST 必须带 id（幂等键）
check('★ POST 带 id', doneTrue.id === 'a', doneTrue);
check('★ createdAt 缺失时不发 undefined（会变成 JSON 里没有该字段）', (function(){
  const x = toDbItem({ id:'c', title:'t', date:'2026-10-09', done:false, createdAt:null, doneAt:null });
  return typeof x.created_at === 'string' && x.created_at.length > 0;
})());

// 三个 job 的请求形状
const captured = [];
global.apiSend = (method, path, body) => { captured.push({method, path, body}); return Promise.resolve({ok:true}); };

syncJobs.add(doneTrue)();
syncJobs.toggle('a', true, '2026-10-09T02:00:00.000Z')();
syncJobs.toggle('a', false, null)();
syncJobs.remove('a')();

check('★ 新增用 POST', captured[0].method === 'POST', captured[0]);
check('★ 勾选用 PATCH', captured[1].method === 'PATCH', captured[1]);
check('★ 删除用 DELETE', captured[3].method === 'DELETE', captured[3]);
check('★ 路径带 /items/{id}', captured[1].path === '/items/a', captured[1].path);
check('★ DELETE 不带 ?force=1（要能报出「删不掉」）', captured[3].path === '/items/a', captured[3].path);
check('★ PATCH body 的 done 是 1', captured[1].body.done === 1, captured[1].body);
check('★ 取消勾选时 done_at 置 null', captured[2].body.done_at === null, captured[2].body);
check('★ PATCH 只发改的字段（不带 title/plan_date）', captured[1].body.title === undefined, Object.keys(captured[1].body));

// ★ id 要 encodeURIComponent，否则带斜杠的 id 会打乱路径
captured.length = 0;
syncJobs.remove('a/b c')();
check('★ id 特殊字符被 URL 编码', captured[0].path === '/items/a%2Fb%20c', captured[0].path);

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + '：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
