const CACHE = 'livelingo-v1.8.0';
const REMOTE_RUNTIME = 'https://ggml.ai/whisper.cpp/stream.wasm/stream.js';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './whisper-engine.js',
  './audio-worklet.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

function isolatedResponse(response) {
  if (!response || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response?.ok) await cache.put('./index.html', response.clone());
    return isolatedResponse(response);
  } catch (_) {
    const cached = await cache.match('./index.html');
    return cached ? isolatedResponse(cached) : Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const network = fetch(request).then(async (response) => {
    if (response?.ok) await cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  if (cached) {
    network.catch(() => {});
    return isolatedResponse(cached);
  }

  const response = await network;
  return response ? isolatedResponse(response) : Response.error();
}

async function cacheFirstRuntime(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(async (cache) => {
        await cache.addAll(APP_SHELL);
        await cache.add(REMOTE_RUNTIME).catch(() => {});
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isRuntime = event.request.url === REMOTE_RUNTIME;
  const isSameOrigin = url.origin === self.location.origin;

  if (!isSameOrigin && !isRuntime) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event.request));
    return;
  }

  if (isRuntime) {
    event.respondWith(cacheFirstRuntime(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});
