/* Cofre — service worker.
   Deja la app instalable y funcionando sin señal. La API nunca se cachea:
   los números siempre se piden al servidor. */
const CACHE = "cofre-v2";
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

  /* Se guarda sin la barra de consulta: /?v=123 y /?v=456 son la misma página.
     Si no, la caché acabaría con una copia idéntica por cada visita, y al
     buscar sin señal no coincidiría nada. */
  const llave = url.origin + url.pathname;

  /* red primero (para recibir mejoras al instante) y caché cuando no hay señal.
     Nunca se resuelve a undefined: eso sería una respuesta inválida y el
     navegador lo reporta como fallo de red. */
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const resp = await fetch(pet);
      if (resp && resp.ok && resp.type === "basic") c.put(llave, resp.clone()).catch(() => {});
      return resp;
    } catch {
      return (await c.match(llave)) || (await c.match("/")) || Response.error();
    }
  })());
});
