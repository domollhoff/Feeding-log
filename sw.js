/* Feeding Log — offline service worker.
   The whole app is one self-contained HTML file, so caching the shell
   is enough to make it work with no connection at all. */

const CACHE = "feeding-log-v1";
const SHELL = ["./", "./index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Serve from cache straight away, then quietly refresh it in the background,
   so a re-upload is picked up on the next launch instead of never. */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });

      const fetching = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(fetching);
        return cached;
      }

      const fresh = await fetching;
      if (fresh) return fresh;

      if (req.mode === "navigate") {
        const shell = (await cache.match("./index.html")) || (await cache.match("./"));
        if (shell) return shell;
      }

      return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
    })()
  );
});
