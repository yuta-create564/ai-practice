// オフラインでも開けるように、アプリの部品を端末に保存しておく。
// 学習データ(単語・センテンス)はここでは扱わない(ブラウザの保存領域と Supabase に保存)。
const VERSION = 'eigo-v1';
const FILES = [
  './', './index.html', './core.js', './app.js', './sync.js', './config.js',
  './vendor/supabase.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // 同期(Supabase)など、別のサーバーへの通信は保存しない
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // 新しい版があればそれを使い、つながらないときは保存しておいた部品で開く
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
