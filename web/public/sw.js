// tautan's service worker: push notifications plus a one-shell offline cache.
// Plain JS, copied to dist/web as-is. `pnpm build` prepends `self.__VERSION` and
// `self.__PRECACHE` (see the `tautan-sw-precache` plugin in vite.config.ts).
// ponytail: hand-written instead of workbox; tautan caches one shell and three route rules.

const VERSION = self.__VERSION || 'dev';
const CACHE = `tautan-${VERSION}`;
const PRECACHE = self.__PRECACHE || []; // empty in dev (`?sw`), where the build never ran

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// ---- push ----

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch { /* a payload we cannot read still deserves a notification */ }
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title || 'tautan', {
        body: data.body,
        tag: data.tag,
        data: { url: data.url || '/' },
        renotify: Boolean(data.tag), // renotify without a tag throws
      });
      // ponytail: no count — the app writes the exact number from SSE state while it is open.
      if (self.navigator.setAppBadge) await self.navigator.setAppBadge().catch(() => {});
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const [client] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (!client) return self.clients.openWindow(url);
      await client.focus();
      // `navigate()` is missing on iOS and rejects for an uncontrolled client; the app
      // listens for the message and sets the hash itself.
      const fallback = () => client.postMessage({ type: 'navigate', url });
      if (client.navigate) await client.navigate(url).catch(fallback);
      else fallback();
    })(),
  );
});

// ---- cache ----

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === '/api/events') return; // SSE: buffering it through the worker kills the stream
  if (/^\/api\/panes\/[^/]+\/file$/.test(url.pathname)) return;
  if (url.pathname.startsWith('/api/')) event.respondWith(networkFirst(request));
  else if (url.pathname.startsWith('/assets/')) event.respondWith(cacheFirst(request));
  else if (request.mode === 'navigate') event.respondWith(networkFirst(request, '/index.html'));
});

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
  return response;
}

async function networkFirst(request, key) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(key || request, response.clone());
    return response;
  } catch (error) {
    const hit = await caches.match(key || request);
    if (hit) return hit;
    throw error;
  }
}
