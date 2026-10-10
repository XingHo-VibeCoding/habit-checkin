/* Service Worker —— 离线壳
 *
 * 【为什么需要它】manifest.json 只让安卓能「装」这个网页（有图标、独立窗口、
 *   从桌面点开而不是浏览器地址栏）。但**离线能力不来自 manifest，来自这个文件**。
 *   没有它，地铁里、白屏、断网一打开就只剩一个空页面。
 *   之前一直缺这一块，所以「弄成应用」其实只做完了一半。
 *
 * 【为什么缓存的东西这么少】
 *   这个应用是**单页 + localStorage**：清单数据全在本地，页面的 HTML/CSS/JS
 *   是一整个文件。所以「应用外壳」只有 4 个静态文件，不需要打包、不需要构建。
 *   —— 这正是当初选「纯静态网页」换来的好处，这里第一次真正兑现。
 *
 *   ⚠️ 不要往SHELL 里加 CDN 或第三方脚本。这个项目的硬约束是
 *      **代码中不得有任何指向外部域名的请求**（PRD 的 C2）。
 *
 * 【策略：缓存优先 + 后台更新】
 *   导航请求（打开页面）：先看缓存有没有，有就直接用、同时后台悄悄拉新版。
 *     为什么不用「网络优先」：网络优先在地铁里会先白屏几秒再失败，
 *     而用户要的恰恰是「一打开就在」。
 *   静态资源：同样缓存优先。
 *   其它（同源 API 请求）：**一律不缓存**。
 *     ⚠️ 清单数据必须每次都拿真的 —— 缓存了清单会看到过期的勾选状态，
 *        而用户已经以为同步成功了。宁可断网时报错，也不能假装成功。
 */

const VERSION = 'day24-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

// ---------- 安装：把外壳存下来 ----------
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      // addAll 是「全成功或全失败」：只要有一个文件拿不到，整个安装就废掉。
      // 这里改成逐个 add并吃掉单个失败 —— 图标 404 不该让整个应用装不上。
      return Promise.all(SHELL.map(function (u) {
        return c.add(u).catch(function () { });
      }));
    }).then(function () {
      // ⭐ 关键：activate 立刻接管，而不是等所有旧页面关掉。
      //   安卓上用户可能开着旧页面不放，不 waitUntil 的话新版本永远激活不了，
      //   用户就一直看着旧代码，还以为改了没生效。
      return self.skipWaiting();
    })
  );
});

// ---------- 激活：清掉旧版本缓存 ----------
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ---------- 拦截请求 ----------
self.addEventListener('fetch', function (e) {
  var req = e.request;

  // 只管 GET。POST/PATCH/DELETE 碰都不能碰 ——
  // 就算缓存里有同url 的旧响应，误回给写请求也会让用户以为保存成功了。
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 跨域请求一律不碰（本项目本来也不该有，但别假设）
  if (url.origin !== self.location.origin) return;

  // API 请求不缓存：清单数据必须每次都拿真的
  if (url.pathname.indexOf('/api/') >= 0) return;

  e.respondWith(
    caches.match(req).then(function (hit) {
      var fresh = fetch(req).then(function (res) {
        // 只有正常响应才更新缓存。206（partial）和不ok 的都别写进去 ——
        // 把一个错误页存进缓存，用户下次断网打开看到的就是它。
        if (res && res.ok && res.status === 200) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // 断网了，而且缓存里也没有 → 只能给一个离线提示页
        return hit || new Response(
          '<!doctype html><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<body style="font-family:system-ui;padding:2rem;text-align:center;line-height:1.8">' +
          '<h1 style="font-size:1.2rem">还没缓存好</h1>' +
          '<p style="color:#666;font-size:.9rem">请连着网打开一次，之后就能离线用了。</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      });
      // 有缓存就先返回缓存，同时上面那个 fetch 在后台更新下一次
      return hit || fresh;
    })
  );
});