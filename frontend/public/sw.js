/* PawaSave service worker — deliberately minimal and SAFE for a fintech.
 *
 * It exists to make the app installable (PWA / TWA), NOT to cache financial data.
 * Rules:
 *   • Never cache /api, auth, or any dynamic/authenticated response — always network.
 *   • Navigations are network-first; only fall back to a static offline page when
 *     the device is truly offline, so a user never sees a stale balance from cache.
 *   • Only a tiny static shell (offline page + icons) is precached.
 */
const CACHE = 'pawasave-shell-v3'
const SHELL = ['/offline.html', '/icon-192.png', '/icon-512.png', '/manifest.json']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Only handle same-origin GETs; everything else (POST, cross-origin, API) → network.
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return
  }

  // Navigations: network-first with an offline fallback (never a cached balance).
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')))
    return
  }

  // Static shell assets we precached: serve from cache, else network.
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((r) => r || fetch(request)))
  }
  // Everything else: default browser handling (no SW caching).
})

// ── Web Push ────────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { body: event.data && event.data.text() } }
  const title = data.title || 'PawaSave'
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',   // full-colour logo shown inside the notification
    badge: '/badge-96.png',  // monochrome B silhouette for the status bar / lockscreen
    tag: data.tag,
    data: { url: data.url || '/' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) { try { w.navigate(target) } catch (e) {} return w.focus() }
      }
      return self.clients.openWindow(target)
    }),
  )
})