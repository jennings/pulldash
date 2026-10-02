// Replaced at build time with the real hashed asset URLs, so the app can boot
// with no network. Falls back to just the shell if the placeholder survives,
// e.g. when the source file is served directly.
const PRECACHE = self.__PULLDASH_PRECACHE__ ?? ["/"];
const CACHE = "pulldash-v2";

const precached = new Set(PRECACHE);

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually, so one 404 cannot fail the whole install: the previous
      // list used addAll, and a single miss rejects the promise, leaving the
      // worker stuck in "installing" forever.
      await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      // Drop the previous cache, which held no usable assets.
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

async function shell() {
  const cache = await caches.open(CACHE);
  return (
    (await cache.match("/")) ??
    new Response("<h1>Offline</h1>", {
      status: 503,
      headers: { "Content-Type": "text/html" },
    })
  );
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (!req.url.startsWith(self.location.origin)) return;

  // Navigations: try the network so a deploy is picked up, fall back to the
  // cached shell so a dropped connection still opens the app. A non-ok response
  // counts as unusable - it is usually the SPA fallback returning HTML for a
  // route that no longer exists.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => (res.ok ? res : shell()))
        .catch(() => shell())
    );
    return;
  }

  // Hashed assets never change under a given name, so serve them from the
  // cache and never touch the network. The old handler was network-first with
  // a cache fallback for every request, which meant a request that failed
  // because it was *absent* got an empty 503 body rather than a real asset.
  if (precached.has(new URL(req.url).pathname)) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
  }
});
