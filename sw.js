/* Feeding Log — offline service worker, v2.

   v1 was cache-first for everything, which meant the app always launched on
   the previous version, and its background refresh could be answered from
   Safari's own HTTP cache, so it never actually went stale-free.

   v2 is network-first for the page itself with a short timeout, so you get
   the current version whenever there is a connection and the cached copy
   the instant there isn't. */

const CACHE = "feeding-log-v2";
const SHELL = ["./", "./index.html"];
const NET_TIMEOUT = 2500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
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

/* Lets the page ask for an immediate handover instead of waiting a launch. */
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

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

  const isPage = req.mode === "navigate" || (req.destination === "" && url.pathname.endsWith(".html"));

  if (isPage) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);

        /* cache: "reload" skips the browser's own HTTP cache, which is the
           bit that kept Safari stuck on an old build. */
        const fromNetwork = fetch(new Request(url.href, { cache: "reload" }))
          .then((res) => {
            if (res && res.ok) cache.put("./index.html", res.clone());
            return res;
          })
          .catch(() => null);

        const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NET_TIMEOUT));
        const fresh = await Promise.race([fromNetwork, timeout]);
        if (fresh) return fresh;

        const cached = (await cache.match("./index.html")) || (await cache.match("./"));
        if (cached) {
          event.waitUntil(fromNetwork);
          return cached;
        }

        const late = await fromNetwork;
        return late || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      })()
    );
    return;
  }

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
      return fresh || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
    })()
  );
});
