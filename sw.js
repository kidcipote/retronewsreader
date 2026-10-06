// Service worker for the reader: makes it installable and lets the shell load with no connection.
// Network first, always: a reachable server wins, so neither home (the Mac or the Worker) ever shows a stale page. The cache is only the fallback.
const CACHE = "reader-v3";
const SHELL = ["/", "/app.js", "/chat.js", "/paper.js", "/taxonomy.json", "/manifest.webmanifest", "/icon-192.png", "/fonts/fonts.css", "/fonts/inter-tight-latin.woff2", "/fonts/jetbrains-mono-latin.woff2"];
const LIVE = ["/api/", "/status", "/picture", "/publications", "/refresh", "/probe"];   // accounts, chat and admin calls are never cached
const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No connection</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#34332f;font:14px/1.5 Helvetica,Arial,sans-serif;color:#171614">
<div style="background:#d8d4cc;padding:3px;max-width:320px;margin:16px"><div style="background:#171614;color:#f6f3ed;padding:4px 8px;font-size:12px">retronewsreader</div>
<div style="padding:16px 14px"><b>No connection.</b><br>The reader could not reach its server, and this device has no saved copy yet. Reconnect and reload.</div></div>`;

self.addEventListener("install", e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || LIVE.some(p => url.pathname.startsWith(p))) return;
  // the saved copy answers when the network fails or the server itself is failing (5xx)
  const saved = async () => (await caches.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? (await caches.match("/")) || new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } }) : null);
  e.respondWith((async () => {
    try {
      const r = await fetch(req);
      // one saved copy per address, the newest: older ones (kept apart by the Vary header) are removed first, or a failed load could bring back a stale page
      if (r.ok && !r.redirected) { const copy = r.clone(); caches.open(CACHE).then(async c => { await c.delete(req, { ignoreVary: true }); await c.put(req, copy); }); }
      return r.status < 500 ? r : (await saved()) || r;
    } catch { return (await saved()) || Response.error(); }
  })());
});
