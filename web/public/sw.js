// SPDX-License-Identifier: AGPL-3.0-or-later

const SW_VERSION = "5";
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
      .then(() => console.info(`[SW] v${SW_VERSION} active`)),
  );
});

function shouldNeverCache(url) {
  for (const p of NEVER_CACHE_PATH_PREFIXES) {
    if (url.pathname.startsWith(p)) return true;
  }
  return false;
}

// Opaque caching would prevent seeking and consume entire media responses.
function isMediaRequest(req) {
  const d = req.destination;
  if (d === "audio" || d === "video" || d === "track") return true;
  return req.headers.has("range");
}

// Presigned downloads must not be copied into the opaque cache.
function isStorageHost(hostname) {
  return hostname.endsWith(".r2.cloudflarestorage.com");
}

// Hashed assets already change URL on every content change.
function isImmutableAsset(url) {
  return url.pathname.startsWith("/assets/");
}

const NAV_TIMEOUT_MS = 4000;

async function fetchShell(req) {
  const controller = new AbortController();
  const startedAt = performance.now();
  const path = new URL(req.url).pathname;
  let phase = "headers";
  const abort = () => controller.abort(req.signal.reason);
  if (req.signal.aborted) abort();
  else req.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Navigation timed out", "TimeoutError"));
  }, NAV_TIMEOUT_MS);
  try {
    const response = await fetch(req, { signal: controller.signal });
    phase = "body";
    console.info("[NetDiag] navigation headers", { path, status: response.status, elapsedMs: Math.round(performance.now() - startedAt) });
    // A complete shell must be available before committing the navigation.
    const body = response.body ? await response.arrayBuffer() : null;
    const headers = new Headers(response.headers);
    headers.delete("Content-Encoding");
    headers.delete("Content-Length");
    console.info("[NetDiag] navigation complete", { path, bytes: body?.byteLength ?? 0, elapsedMs: Math.round(performance.now() - startedAt) });
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    console.warn("[NetDiag] navigation failed", {
      path,
      phase,
      reason: controller.signal.aborted ? (req.signal.aborted ? "canceled" : "timeout") : "network",
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", abort);
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  if (isMediaRequest(req)) return;

  const url = new URL(req.url);

  // Public share pages must not receive the authenticated application shell.
  if (url.origin === self.location.origin && url.pathname.startsWith("/share/")) return;

  // Hash routing confines application-shell navigations to these two paths.
  if (req.mode === "navigate") {
    if (url.pathname !== "/" && url.pathname !== "/index.html") return; // default fetch
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetchShell(req);
          if (fresh.ok && fresh.headers.get("Content-Type")?.includes("text/html")) {
            const cached = fresh.clone();
            event.waitUntil(caches.open(PRECACHE).then((cache) => cache.put("./index.html", cached)).catch(() => {}));
          }
          return fresh;
        } catch {
          if (req.signal.aborted) return Response.error();
          let cached;
          try {
            const cache = await caches.open(PRECACHE);
            cached = (await cache.match("./index.html")) || (await cache.match("./"));
          } catch { /* storage errors must still produce a Response below */ }
          console.info("[NetDiag] navigation cached shell", { path: url.pathname, available: !!cached });
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  if (url.origin !== self.location.origin) {
    // An opaque response is invalid for a CORS request.
    if (req.mode !== "no-cors") return; // default fetch
    if (isStorageHost(url.hostname)) return;
    if (url.hostname === "static.cloudflareinsights.com") return;
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

  // Revalidation may fail while an existing cached resource remains usable.
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
