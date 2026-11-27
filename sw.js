// Service worker dell'app Clienti (v6.32): serve SOLO per le notifiche (nuovi prodotti Marchi).
// Non salva niente in cache: l'app si aggiorna come prima, a ogni apertura.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

// arriva una notifica dal servizio (strumenti/worker-calendario.js, mandaPush): { titolo, testo, url, tag }
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch(err){ d = { testo: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.titolo || "Clienti", {
    body: d.testo || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: d.tag || undefined,
    data: { url: d.url || "./" }
  }));
});

// tocco sulla notifica: apre l'app (o la porta davanti) sulle Novità Marchi
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const finestre = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for(const c of finestre){
      if(c.url.startsWith(self.registration.scope)){
        c.postMessage({ tipo: "novita" });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
