// Минимальный service worker — нужен только для того, чтобы браузер посчитал
// страницу устанавливаемым PWA. Офлайн-режим админке не нужен (без сети всё
// равно нечего показывать), поэтому просто пропускаем все запросы в сеть.
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
