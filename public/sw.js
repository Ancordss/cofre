/* Cofre — service worker.
   Deja la app instalable y funcionando sin señal. La API nunca se cachea:
   los números siempre se piden al servidor. */
const CACHE = "cofre-v1";
const CASCARON = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(CASCARON.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((llaves) => Promise.all(llaves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const pet = e.request;
  if (pet.method !== "GET") return;
  const url = new URL(pet.url);
  if (url.origin !== self.location.origin) return;
  /* la API y el MCP siempre van a la red */
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mcp")) return;

  /* red primero (para recibir mejoras al instante) y caché cuando no hay señal */
  e.respondWith(
    fetch(pet)
      .then((resp) => {
        if (resp && resp.ok && resp.type === "basic") {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(pet, copia)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(pet).then((r) => r || caches.match("/")))
  );
});
