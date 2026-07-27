// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EdgeSonic Service Worker — App Shell + navigation fallback.
// Strategy:
//   - Precache core shell (index.html, manifest, logo, icons).
//   - Navigation requests: network-first, fall back to cached index.html.
//   - Same-origin static GET (hashed Vite assets): stale-while-revalidate.
//   - API paths (/rest/* /edgesonic/* /storage/* /tag/*) and
//     /edgesonic/version: network-only (never cached).
//   - Cross-origin (fonts, covers, etc.): opaque CORS, cache 1h, no revalidate.
//   - Media / Range / streaming: never intercepted (see fetch handler).

const SW_VERSION = "4";
const PRECACHE = `edgesonic-shell-v${SW_VERSION}`;
const RUNTIME = `edgesonic-runtime-v${SW_VERSION}`;
const OPAQUE = `edgesonic-opaque-v${SW_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./logo.svg",
  "./favicon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];

const NEVER_CACHE_PATH_PREFIXES = [
  "/rest/",
  "/edgesonic/",
  "/storage/",
  "/tag/",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => ![PRECACHE, RUNTIME, OPAQUE].includes(k))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim())
      // Version marker so the controlling SW generation is visible in the
      // page console at a glance when debugging request hangs.
      .then(() => console.info(`[SW] v${SW_VERSION} active`)),
  );
});

function shouldNeverCache(url) {
  for (const p of NEVER_CACHE_PATH_PREFIXES) {
    if (url.pathname.startsWith(p)) return true;
  }
  return false;
}

// Media and range requests must never touch the cache layer. /rest/stream
// 302-redirects to a cross-origin R2 presign / WebDAV URL; the <audio> element
// follows that redirect and issues Range requests against it. Wrapping any of
// this in no-cors caching yields opaque, un-seekable responses (playback
// stalls), pulls whole audio files into the cache, and saturates the
// connection pool so JS chunks and navigations hang behind it. Detect by
// request.destination (survives the redirect) and by the Range header.
function isMediaRequest(req) {
  const d = req.destination;
  if (d === "audio" || d === "video" || d === "track") return true;
  return req.headers.has("range");
}

// Cross-origin object-storage hosts serve large presigned blobs that must
// never be cached opaquely, even for non-media (download) requests.
function isStorageHost(hostname) {
  return hostname.endsWith(".r2.cloudflarestorage.com");
}

// Content-hashed Vite assets are immutable — a new build ships new filenames —
// so they can be served cache-first with no background revalidation, avoiding
// a redundant network fetch for every asset on every load.
function isImmutableAsset(url) {
  return url.pathname.startsWith("/assets/");
}

const NAV_TIMEOUT_MS = 4000;

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(req).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Let the browser handle all media/streaming natively (default fetch).
  if (isMediaRequest(req)) return;

  const url = new URL(req.url);

  // Server-rendered public pages (/share/:id landing + its ?stream audio)
  // live outside the SPA shell. Falling back to the cached shell for them
  // would hand an anonymous share visitor the SPA login screen; let the
  // browser talk to the network directly, no SW involvement at all.
  if (url.origin === self.location.origin && url.pathname.startsWith("/share/")) return;

  // Navigation: network-first, but fall back to the cached shell when the
  // network is merely slow (not only on error) so a saturated connection can
  // never hang a reload. The SPA uses hash routing, so every genuine shell
  // navigation lands on "/" — any other pathname is NOT the SPA (share pages,
  // future server-rendered pages) and must not be answered with (or cached
  // as) the shell.
  if (req.mode === "navigate") {
    if (url.pathname !== "/" && url.pathname !== "/index.html") return; // default fetch
    event.respondWith(
      (async () => {
        const cache = await caches.open(PRECACHE);
        try {
          const fresh = await fetchWithTimeout(req, NAV_TIMEOUT_MS);
          cache.put("./index.html", fresh.clone()).catch(() => {});
          return fresh;
        } catch (err) {
          console.warn(
            `[SW] navigation fell back to cached shell (network ${err && err.message === "timeout" ? "slow >" + NAV_TIMEOUT_MS + "ms" : "failed"}):`,
            req.url,
          );
          let cached;
          try {
            cached = (await cache.match("./index.html")) || (await cache.match("./"));
          } catch { /* storage errors must still produce a Response below */ }
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  if (url.origin !== self.location.origin) {
    // Only genuine no-cors subresources may be answered from the opaque
    // cache. Re-issuing a CORS request as no-cors returns an opaque response
    // the browser rejects ("opaque response used for a request whose type is
    // not no-cors") — that killed @font-face woff2 loads from fonts.gstatic.
    // CORS requests (fonts, api.github.com, analytics beacons) go straight
    // to the network; the HTTP cache covers repeat loads.
    if (req.mode !== "no-cors") return; // default fetch
    // Object storage: large presigned blobs, never cache. Default fetch.
    if (isStorageHost(url.hostname)) return;
    // Analytics: let failures (adblock, offline) surface natively.
    if (url.hostname === "static.cloudflareinsights.com") return;
    // Cross-origin no-cors: cache opaque responses briefly (images etc.).
    event.respondWith(
      (async () => {
        const cache = await caches.open(OPAQUE);
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res.type === "opaque" || res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        } catch {
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  if (shouldNeverCache(url)) return; // default fetch

  // Immutable hashed assets: cache-first, no background revalidation.
  if (isImmutableAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME);
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      })(),
    );
    return;
  }

  // Other same-origin static GET: stale-while-revalidate. The failure path
  // must still resolve to a Response — resolving undefined makes respondWith
  // throw "Failed to convert value to 'Response'" and the request dies.
  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => cached || Response.error());
      return cached || network;
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "edgesonic:skip-waiting") self.skipWaiting();
  if (event.data === "edgesonic:claim-clients") self.clients.claim();
});