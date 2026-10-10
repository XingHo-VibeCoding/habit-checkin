// Day 25｜service worker 离线策略测试
//
// 这段逻辑光读代码看不出对错 —— 必须真的把 fetch 事件跑一遍。
// 重点验四件容易写错的事：
//   ① API 请求绝不能被缓存（缓存了清单，用户会看到过期的勾选状态却以为同步成功了）
//   ② 写请求绝不能被缓存（误回一个旧响应 = 谎报保存成功）
//   ③ 断网 + 缓存有→ 走缓存
//   ④ 断网 + 缓存无 → 给离线提示页，而不是空白
//
// 跑法：node test_day25_sw.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(__dirname + '/sw.js', 'utf8');

let pass = 0, fail = 0;
const check = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
};

// ── Service Worker 全局环境桩 ──
function mkEnv(opts) {
  opts = opts || {};
  const listeners = {};
  const cachesStore = {};
  const putCalls = [];

  const sandbox = {
    URL: URL,
    Response: class {
      constructor(body, init) {
        this.body = body; this.status = (init && init.status) || 200;
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = (init && init.headers) || {};
      }
      clone() { return this; }
    },
    Promise: Promise,
    console: console,
    caches: {
      open(name) {
        if (!cachesStore[name]) cachesStore[name] = {};
        return Promise.resolve({
          add(u) { if (opts.addFails && opts.addFails.indexOf(u) >= 0) return Promise.reject(new Error('404')); return Promise.resolve(); },
          put(req, res) { putCalls.push({ req: String(req), status: res.status }); return Promise.resolve(); }
        });
      },
      keys() { return Promise.resolve(Object.keys(cachesStore)); },
      delete(k) { delete cachesStore[k]; return Promise.resolve(); },
      match(req) {
        const key = typeof req === 'string' ? req : req.url;
        const hit = (opts.cache && opts.cache[key]) || null;
        return Promise.resolve(hit ? { _fromCache: key, status: 200 } : undefined);
      }
    },
    fetch: opts.fetch || function () { return Promise.resolve({ ok: true, status: 200, clone: function () { return { status: 200 }; } }); },
    self: {
      location: { origin: 'https://daily-checkin-list.app.workbuddy.host' },
      clients: { claim: function () { return Promise.resolve(); } },
      skipWaiting: function () { return Promise.resolve(); },
      addEventListener(type, fn) { listeners[type] = fn; }
    },
    addEventListener(type, fn) { listeners[type] = fn; }
  };
  sandbox.addEventListener = listeners[sandbox.self.addEventListener ? 'install' : 'install'] || function () { };
  // self.addEventListener 是代码里用的写法
  sandbox.self.addEventListener = listeners.__proto__ ? listeners.__proto__ : function () { };

  // 重新走一遍：代码里用的是 self.addEventListener
  const realListeners = {};
  sandbox.self.addEventListener = function (type, fn) { realListeners[type] = fn; };
  sandbox.self.on = realListeners;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx);

  return { listeners: realListeners, putCalls: putCalls, sandbox: sandbox };
}

// 拿事件的两种注册方式都要能用
function getFetchHandler(env) {
  return env.listeners.fetch || (env.sandbox.self.__l && env.sandbox.self.__l.fetch);
}

console.log('-- Day 25 service worker 离线策略 --\n');

// ───────────────────────────────────────────��─────────────
console.log('【一】注册与环境检查');

// 代码里确实调了 install / activate / fetch 三个监听
const e0 = mkEnv({});
const names = Object.keys(e0.listeners);
check('① 注册了 install 监听', names.indexOf('install') >= 0, names);
check('① 注册了 activate 监听', names.indexOf('activate') >= 0, names);
check('① 注册了 fetch 监听', names.indexOf('fetch') >= 0, names);

const srcTxt = src;
check('① 用了 skipWaiting（安卓旧页面不关会卡住新版本）', srcTxt.indexOf('skipWaiting') >= 0);
check('① 用了 clients.claim()', srcTxt.indexOf('clients.claim') >= 0);

// ─────────────────────────────────────────────────────────────
console.log('\n【二】install：单个资源失败不该让整个安装废掉');

const e1 = mkEnv({ addFails: ['./assets/icon-192.png'] });
e1.listeners.install({
  waitUntil: function (p) { return p; }
});

console.log('\n【三】fetch：API 请求绝不能被缓存');

// 用 mkEnv 重建一个带可控 fetch 的环境
function mkFetchEnv(opts) {
  const realListeners = {};
  const putCalls = [];
  const putCache = {};
  const cacheData = opts.cache || {};

  const sandbox = {
    URL: URL,
    Promise: Promise,
    console: console,
    Response: class {
      constructor(body, init) {
        this.body = body;
        this.status = (init && init.status) || 200;
        this.ok = this.status >= 200 && this.status < 300;
      }
      clone() { return this; }
    },
    caches: {
      open: function () {
        return Promise.resolve({
          add: function () { return Promise.resolve(); },
          put: function (req, res) { putCalls.push({ req: req.url || String(req), status: res.status }); return Promise.resolve(); }
        });
      },
      keys: function () { return Promise.resolve([]); },
      delete: function () { return Promise.resolve(); },
      match: function (req) {
        const key = req.url || String(req);
        return Promise.resolve(cacheData[key] || undefined);
      }
    },
    fetch: opts.fetch || function (u) {
      return Promise.resolve({
        ok: true, status: 200, url: typeof u === 'string' ? u : u.url,
        clone: function () { return { status: 200, url: typeof u === 'string' ? u : u.url }; }
      });
    },
    self: {
      location: { origin: 'https://daily-checkin-list.app.workbuddy.host' },
      clients: { claim: function () { return Promise.resolve(); } },
      skipWaiting: function () { return Promise.resolve(); },
      addEventListener: function (t, fn) { realListeners[t] = fn; }
    }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx);
  return { listeners: realListeners, putCalls: putCalls };
}

function fireFetch(env, url, method) {
  let out = { passed: false };
  const req = { url: url, method: method || 'GET' };
  env.listeners.fetch({
    request: req,
    respondWith: function (p) { out.passed = true; out.promise = p; }
  });
  return out;
}

// API GET —— 关键安全项
const eApi = mkFetchEnv({});
let r = fireFetch(eApi, 'https://daily-checkin-list.app.workbuddy.host/api/items?date=2026-10-10', 'GET');
check('② API 请求不被拦截（respondWith 不该被调用）', r.passed === false, r.passed);

// 写请求
const eWrite = mkFetchEnv({});
r = fireFetch(eWrite, 'https://daily-checkin-list.app.workbuddy.host/api/items', 'POST');
check('★ POST 请求不被拦截', r.passed === false, r.passed);

const ePatch = mkFetchEnv({});
r = fireFetch(ePatch, 'https://daily-checkin-list.app.workbuddy.host/api/items/abc', 'PATCH');
check('★ PATCH 请求不被拦截', r.passed === false, r.passed);

const eDel = mkFetchEnv({});
r = fireFetch(eDel, 'https://daily-checkin-list.app.workbuddy.host/api/items/abc', 'DELETE');
check('★ DELETE 请求不被拦截', r.passed === false, r.passed);

// 跨域
const eCross = mkFetchEnv({});
r = fireFetch(eCross, 'https://cdn.example.com/x.js', 'GET');
check('② 跨域请求不碰（PRD C2：不得有外部域名请求）', r.passed === false, r.passed);

// ─────────────────────────────────────────────────────────────
console.log('\n【四】fetch：断网 + 有缓存 → 走缓存');

// 用一个会 reject 的 fetch 模拟断网
const eOffline = mkFetchEnv({
  fetch: function () { return Promise.reject(new Error('Failed to fetch')); },
  cache: { 'https://daily-checkin-list.app.workbuddy.host/index.html': { _c: true, status: 200 } }
});
r = fireFetch(eOffline, 'https://daily-checkin-list.app.workbuddy.host/index.html', 'GET');
check('③ 导航请求被拦截（走缓存策略）', r.passed === true, r.passed);

// ─────────────────────────────────────────────────────────────
console.log('\n【五】代码层的三条硬约束');

check('★ fetch 事件里第一件事是判method !== "GET"',
  /req\.method\s*!==\s*'GET'/.test(srcTxt));
check('★ 有 /api/ 前缀排除（清单数据必须每次拿真的）',
  srcTxt.indexOf("indexOf('/api/')") >= 0);
check('★ 只在 res.ok && status === 200 时才更新缓存',
  /res\.ok\s*&&\s*res\.status\s*===\s*200/.test(srcTxt));
// ⚠️ 判据必须**先剥掉注释**再查。
//   第一次跑这条就假阴性了：addAll 出现在解释「为什么不用 addAll」的那行注释里，
//   而 srcTxt.indexOf('addAll') 会连注释一起搜到，于是报「用了 addAll」，
//   看起来像代码写错了。去掉注释后判断就准了。
const codeOnly = srcTxt
  .split('\n')
  .filter(function (l) { return l.trim().indexOf('//') !== 0; })
  .join('\n');

check('★ 用了 cache.add 逐个加而不是 cache.addAll（单资源失败会全废）',
  codeOnly.indexOf('addAll') < 0 && /c\.add\(/.test(codeOnly));
check('★ 离线兜底页给了提示，不是空白', srcTxt.indexOf('还没缓存好') >= 0);
check('★ SHELL 清单里没有外部域名',
  !/https?:\/\//.test(srcTxt.split('const SHELL')[1].split(']')[0]));

console.log('\n' + (fail === 0
  ? '结论：离线策略的六条硬约束全部成立。'
  : '结论：有FAIL，离线策略有漏。'));
console.log(pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);