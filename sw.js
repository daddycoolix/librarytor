const CACHE = 'librarytor-v44.37';
const ASSETS = ['./', '/index.html', '/manifest.json', '/libraries_data.js', '/books_data.js'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.allSettled(ASSETS.map(url =>
        c.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err.message))
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // אל תcache בקשות POST או קריאות API חיצוניות
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('workers.dev') ||
      e.request.url.includes('googleapis.com') ||
      e.request.url.includes('firebase') ||
      e.request.url.includes('ocr.space')) return;

  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r && r.status === 200) {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
