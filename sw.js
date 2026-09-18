/* ==========================================================================
   Service Worker —— 让应用能在完全离线的情况下打开

   策略是 stale-while-revalidate：
   先从缓存里立刻返回（父母点开就能用，不等网络），
   同时在后台拉一份新的存进缓存，下次启动生效。

   之所以不用 cache-first：那会导致部署了新版本之后，
   父母的手机上永远停留在旧版本，而且没有办法从远端修。
   之所以不用 network-first：那离线时就打不开了，而离线可用是刚需。

   ⚠️ 每次改完代码重新部署时，必须把下面的 CACHE_VERSION 改一下
   （v1 → v2 → v3……），否则父母的手机上不会更新。
   ========================================================================== */

const CACHE_VERSION = 'v2';
const CACHE_NAME = `health-diary-${CACHE_VERSION}`;

// 需要预先缓存的全部文件。新增 js 文件时要记得加进来——
// 漏掉的话离线状态下会打不开。
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/ui.js',
  './js/forms.js',
  './js/charts.js',
  './js/history.js',
  './js/settings.js',
  './js/export.js',
  './js/record.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 逐个 add，避免一个文件 404 让整次预缓存全部失败
    await Promise.all(PRECACHE.map((url) =>
      cache.add(url).catch(() => console.warn('[sw] 预缓存失败：', url))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清掉旧版本的缓存
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('health-diary-') && n !== CACHE_NAME)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 只处理同源请求
  if (url.origin !== self.location.origin) return;

  // 快照是应用自己用 Cache Storage 直接写的，不经过 fetch。
  // 这里再挡一道，免得被当普通资源覆盖掉。
  if (url.pathname.includes('__snapshot__')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });

    const network = fetch(request)
      .then((res) => {
        // 只缓存成功的同源响应
        if (res && res.status === 200 && res.type === 'basic') {
          cache.put(request, res.clone()).catch(() => {});
        }
        return res;
      })
      .catch(() => null);

    if (cached) return cached;

    const fresh = await network;
    if (fresh) return fresh;

    // 离线且没缓存：导航请求退回首页，其余返回一个空响应而不是报错
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('', { status: 504, statusText: 'offline' });
  })());
});

// 允许页面主动要求新版本立即接管
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
