// 最小構成のキャッシュ戦略
//   - HTML/manifest（更新される可能性があるもの）: network-first
//       → まずネットワークから最新を取りに行き、成功したらキャッシュも更新。
//         オフライン時など失敗した場合だけキャッシュのものを表示する。
//   - アイコン画像（ほぼ変化しないもの）: cache-first
const CACHE_NAME = 'mytools-shell-v2';
const NETWORK_FIRST_FILES = ['menu.html', 'manifest.json'];
const CACHE_FIRST_FILES = ['icon-192.png', 'icon-512.png'];
const ALL_SHELL_FILES = [...NETWORK_FIRST_FILES, ...CACHE_FIRST_FILES];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ALL_SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // menu.html / manifest.json: 常に最新を優先して取得
  if (NETWORK_FIRST_FILES.some((f) => url.pathname.endsWith(f))) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // アイコン類: キャッシュ優先（ネットワーク不要で高速表示）
  if (CACHE_FIRST_FILES.some((f) => url.pathname.endsWith(f))) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }

  // それ以外（各ツールへのリンク先など）は素通し
});
