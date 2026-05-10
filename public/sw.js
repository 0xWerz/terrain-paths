const CACHE_VERSION = '2026-05-10-ux-auto-update'
const SHELL_CACHE = `terrain-shell-${CACHE_VERSION}`
const ASSET_CACHE = `terrain-assets-${CACHE_VERSION}`
const PRECACHE_URLS = ['/', '/manifest.webmanifest', '/favicon.svg']

async function deleteOldCaches() {
  const cacheNames = await caches.keys()
  const oldTerrainCaches = cacheNames.filter(
    (name) => name.startsWith('terrain-') && name !== SHELL_CACHE && name !== ASSET_CACHE,
  )
  await Promise.all(
    oldTerrainCaches.map((name) => caches.delete(name)),
  )
  return oldTerrainCaches.length > 0
}

async function cacheShell() {
  const cache = await caches.open(SHELL_CACHE)
  await cache.addAll(PRECACHE_URLS)
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  } catch {
    return (await cache.match(request)) ?? (await cache.match('/'))
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(ASSET_CACHE)
    await cache.put(request, response.clone())
  }
  return response
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheShell())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    deleteOldCaches().then((isUpdate) =>
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'TERRAIN_SW_ACTIVATED', version: CACHE_VERSION })
          if (isUpdate && 'navigate' in client) {
            client.navigate(client.url)
          }
        }
        return self.clients.claim()
      }),
    ),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'TERRAIN_SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return

  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request))
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(event.request))
    return
  }

  event.respondWith(networkFirst(event.request))
})
