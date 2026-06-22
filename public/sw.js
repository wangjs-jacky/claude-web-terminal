/* claude-web-terminal Service Worker：让应用可安装（PWA）+ 离线兜底 */
const CACHE = 'cwt-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  '/vendor/xterm/lib/xterm.js',
  '/vendor/xterm/css/xterm.css',
  '/vendor/addon-fit/lib/addon-fit.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => {}),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 只处理 GET：POST /upload、WebSocket 等一律放行
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return;

  // network-first：始终优先拿最新代码，离线时回退缓存
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((m) => m || caches.match('./index.html')),
      ),
  );
});
