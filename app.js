// The reader. Loaded by index.html; kept in its own file so the page can forbid inline scripts (Content-Security-Policy in cloud/public/_headers).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});   // installable; the shell and the last stories load offline
// Every question the reader asks is drawn in its own window style. The browser's built-in prompt, confirm and alert boxes are never used:
// they cannot be styled and look like the phone's operating system, not like the reader.
// Resolves to the typed text (with `input`), true (without), or null if dismissed.
window.retroAsk = ({ title, text, input = false, secret = false, ok = "OK", cancel = "Cancel", placeholder = "" }) => new Promise(done => {
  const el = document.createElement("div"); el.className = "ask";
  el.innerHTML = `<div class="box raised" role="dialog" aria-modal="true"><div class="titlebar"><span class="ico"></span><span class="at"></span><span class="sp"></span><button class="wb x" aria-label="Close">×</button></div>
    <div class="abody"><p></p>${input ? `<input type="${secret ? "password" : "text"}" spellcheck="false" autocomplete="off">` : ""}</div>
    <div class="abtns">${cancel ? `<button class="no"></button>` : ""}<button class="default yes"></button></div></div>`;
  el.querySelector(".at").textContent = title; el.querySelector("p").textContent = text; el.querySelector(".yes").textContent = ok;
  if (cancel) el.querySelector(".no").textContent = cancel;
  const field = el.querySelector("input"); if (field) field.placeholder = placeholder;
  const finish = v => { document.removeEventListener("keydown", key, true); el.remove(); done(v); };
  const key = e => { if (e.key === "Escape") { e.stopPropagation(); finish(null); } if (e.key === "Enter" && (!field || e.target === field)) { e.preventDefault(); finish(field ? field.value : true); } };
  el.querySelector(".yes").onclick = () => finish(field ? field.value : true);
  el.querySelector(".x").onclick = () => finish(null); if (cancel) el.querySelector(".no").onclick = () => finish(null);
  el.addEventListener("pointerdown", e => { if (e.target === el) finish(null); });
  document.addEventListener("keydown", key, true);
  document.body.appendChild(el); (field || el.querySelector(".yes")).focus();
});

(async function () {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const data = await fetch("data.json", { cache: "no-store" }).then(r => r.json()).catch(() => null);
  if (!data) { $("#s1").textContent = "Could not load the stories."; $("#rows").innerHTML = `<tr><td colspan="3" class="empty">Could not load the stories. Check the connection, then reload.</td></tr>`; return; }
  if (!data.items.length) $("#s1").textContent = "No stories yet. They arrive on their own within half an hour.";

  // Whose list is this? Signed on: that person's. Signed off: the three-outlet front page. On the Mac, which has no accounts: everything in feeds.json.
  // The archive holds every publication anyone follows; the page shows only the reader's own. The last answer is kept for when the network is down.
  const FRONT_PAGE = ["gothamist", "thecity", "nyt"];
  const mine = await fetch("/api/pubs", { cache: "no-store" }).then(async r => r.ok ? await r.json().then(j => ({ cloud: true, on: true, ids: j.pubs, operator: !!j.operator })) : r.status === 401 ? { cloud: true, on: false, ids: FRONT_PAGE } : { cloud: false, on: false, ids: null })
    .then(m => { try { localStorage.setItem("rolodex.mine", JSON.stringify(m)); } catch {} return m; })
    .catch(() => { try { return JSON.parse(localStorage.getItem("rolodex.mine")) || { cloud: false, on: false, ids: null }; } catch { return { cloud: false, on: false, ids: null }; } });
  if (mine.ids) {
    const keep = new Set(mine.ids.length ? mine.ids : FRONT_PAGE); data.publications = data.publications.filter(p => keep.has(p.id));
    // a story that ran in two feeds is stored under the first; if only the other is on this list, show it under that one
    for (const i of data.items) if (!keep.has(i.pub) && i.also) { const other = i.also.find(x => keep.has(x)); if (other) i.pub = other; }
    // the server sends one piece per publication, so a story shared by two of them arrives twice: keep one
    const once = new Set(); data.items = data.items.filter(i => keep.has(i.pub) && !once.has(i.id) && once.add(i.id));
    // a publication just added to the list has not been fetched yet: show it in Sources as on its way
    const have = new Set(data.publications.map(p => p.id));
    if ([...keep].some(id => !have.has(id))) try { const reg = (await fetch("/publications", { cache: "no-store" }).then(r => r.json())).publications || []; for (const p of reg) if (keep.has(p.id) && !have.has(p.id)) data.publications.push({ ...p, status: "fetching now", count: 0, embeddable: false }); } catch {}
  }
  if (mine.cloud && !mine.on) {
    $("#strip").style.display = ""; $("#strip").innerHTML = `<span class="lg">This is the front page: three citywide outlets. </span><span class="sm">Front page · </span><a id="strip-go">Have an invite? Make your own list</a>`;
    $("#strip-go").onclick = () => document.dispatchEvent(new CustomEvent("reader:welcome"));
    // with sign-ups open to anyone the strip does not ask about an invite
    fetch("/api/door", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(r => r.json()).then(d => { if (d.invite_only === false) $("#strip-go").textContent = "Make your own list"; }).catch(() => {});
  }
  // the fixed topic list and the borough ▸ neighborhood tree that stories are tagged against (see fetch.py)
  const tax = await fetch("taxonomy.json", { cache: "no-store" }).then(r => r.json()).catch(() => ({ topics: {}, boroughs: {} }));
  const pubsMap = new Map(data.publications.map(p => [p.id, p]));
  if (!data.publications.some(p => p.tags)) { try { const cfg = await fetch("/publications", { cache: "no-store" }).then(r => r.json()); for (const c of cfg.publications || []) { const p = pubsMap.get(c.id); if (p) p.tags = c.tags || []; } } catch {} }
  const pubs = { get: id => pubsMap.get(id) || { id, name: id, short: id, color: "#888", ink: "#fff", status: "removed", embeddable: false, tags: [] } };
  // Stories stored before the fetchers were fixed can carry a lead-image address with its & still written as &amp; (it was lifted out of
  // HTML and not turned back). Outlets that sign their image addresses refuse those. Put right here, for everything already in the archive.
  const plainUrl = u => u ? String(u).replace(/&amp;/g, "&").replace(/&#0?38;/g, "&") : u;
  // ---- scrub: the catch-all for what a feed leaves in a story's text that is not the story ----
  // Feeds are written by many hands and break in many small ways. Rather than fix each as it is noticed, every title, summary and story text
  // goes through this one step, in both fetchers (scrub() in cloud/worker.js and in fetch.py) and here, for what is already stored and for saved copies.
  // It removes: CDATA marks, written out or escaped; XML declarations, doctypes and comments; control and zero-width characters;
  // WordPress shortcodes ([caption], [embed]); and stray marks left at the very start (]]>, -->, >). It repairs: text escaped twice
  // (&amp;amp;, or a whole story whose tags show as words) and the commonest mis-decoded characters ("â€™" for ’, "Ã©" for é).
  // It is deliberately cautious: each repair fires only on a pattern that is never right as written. To add a case, add a line here, in cloud/worker.js and in fetch.py.
  const MOJIBAKE = [["â€™", "’"], ["â€˜", "‘"], ["â€œ", "“"], ["â€\u009d", "”"], ["â€“", "–"], ["â€”", "—"], ["â€¦", "…"], ["Â ", " "]];
  function scrub(s) {
    s = String(s || ""); if (!s) return s;
    s = s.replace(/<!\[CDATA\[|\]\]>|&lt;!\[CDATA\[|\]\]&gt;/g, "")
      .replace(/<\?xml[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/gi, "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F﻿​⁠]/g, "");
    // escaped twice: an entity of an entity is put right wherever it is; a whole text with no real tag in it, only escaped ones, is unescaped once
    s = s.replace(/&amp;(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, "&$1;");
    if (!/<[a-z][^>]*>/i.test(s) && /&lt;\/?(p|a|br|div|img|strong|em|span|h[1-6]|ul|li|figure|blockquote)\b[^&]*&gt;/i.test(s))
      s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");
    s = s.replace(/\[\/?(caption|embed|gallery|video|audio|playlist|vc_\w+)[^\]]*\]/gi, "");
    for (const [bad, good] of MOJIBAKE) if (s.includes(bad)) s = s.split(bad).join(good);
    // UTF-8 that was read as Latin-1 ("Ã©" for "é"): put right only when it is plainly systematic (three or more in one text)
    if ((s.match(/[ÂÃ][\u0080-¿]/g) || []).length >= 3) s = s.replace(/[ÂÃ][\u0080-¿]/g, m => { try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(m, c => c.charCodeAt(0))); } catch { return m; } });
    return s.replace(/^(?:\s|<br\s*\/?>|&nbsp;|>|-->|\]|&gt;)+/i, "").trim();
  }
  const mend = it => { it.image = plainUrl(it.image); for (const k of ["title", "summary", "content", "author"]) if (typeof it[k] === "string") it[k] = scrub(it[k]);
    if (it.author) it.author = it.author.replace(/^\s*by\s+(?=\S)/i, "");   // some feeds (Politico) write "By Name" as the author; the page adds its own "By"
    return it; };
  for (const it of data.items) mend(it);
  const items = data.items.map(it => ({ ...it, d: new Date(it.date), size: new Blob([it.content || it.summary]).size, kind: (it.content || "").length > 1500 ? "Full text" : "Excerpt" }));
  const fmt = d => d.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");
  const fmtLong = d => d.toLocaleString([], { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  // ---- new since you were last here ----
  // Each story carries the moment the fetcher first saw it (first_seen). The newest such moment on the list when the reader was last open
  // is the baseline: anything first seen after it is new to this reader and its row is faintly tinted. The baseline is held for one sitting
  // (see below), so a reload, a pull, or stories arriving while the reader is open do not wipe the tints; coming back after a while
  // moves it up. Kept in this browser only. The very first time, nothing is tinted.
  const seenAt = it => Date.parse(it.first_seen || it.date) || 0, newestSeen = Math.max(0, ...items.filter(i => !i.archived).map(seenAt));
  // The tint lasts for one sitting: from when a story is first listed until the reader has done nothing here for five minutes or more
  // (no click, key, scroll or touch; a hidden tab counts as nothing). The next thing they do starts a new sitting: everything already
  // shown loses its tint, and only what arrives from then on is tinted. A sitting is not a browser session and not a tab's lifetime: a
  // phone keeps a session for days and a desktop tab may never be closed, and either left stories tinted long after they were first seen.
  // `shownMax` is the newest story listed so far; `rolodex.active` is when the reader last did something, kept so a quick reload continues the sitting.
  const SITTING = 5 * 60e3; let since = newestSeen, shownMax = newestSeen;
  try { const held = sessionStorage.getItem("rolodex.since"), active = Number(localStorage.getItem("rolodex.active")) || 0;
    since = held !== null && Date.now() - active < SITTING ? Number(held) : Number(localStorage.getItem("rolodex.seen") || newestSeen);
    sessionStorage.setItem("rolodex.since", String(since)); if (newestSeen) localStorage.setItem("rolodex.seen", String(newestSeen)); localStorage.setItem("rolodex.active", String(Date.now())); } catch {}
  const isNew = it => !it.archived && seenAt(it) > since;
  // a new sitting: what was already listed is no longer new. The rows are changed in place, not redrawn, so a click in progress keeps its target.
  const newSitting = () => { since = shownMax; try { sessionStorage.setItem("rolodex.since", String(since)); } catch {}
    for (const tr of $$("#rows tr.fresh")) { const it = items.find(i => i.id === tr.dataset.id); tr.classList.toggle("fresh", !!it && isNew(it)); } };
  let lastActive = Date.now(), wroteActive = Date.now();
  const here = () => { const now = Date.now(); if (now - lastActive >= SITTING) newSitting(); lastActive = now;
    if (now - wroteActive > 30e3) { wroteActive = now; try { localStorage.setItem("rolodex.active", String(now)); } catch {} } };
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) addEventListener(ev, here, { capture: true, passive: true });
  const kb = n => n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB";
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const fromYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

  let read = new Set(); try { read = new Set(JSON.parse(localStorage.getItem("rolodex.read") || "[]")); } catch {}
  const saveRead = () => { try { localStorage.setItem("rolodex.read", JSON.stringify([...read])); } catch {} };
  // saved stories keep a full snapshot so they outlive archive pruning; shared with index.html
  let saved = {}; try { saved = JSON.parse(localStorage.getItem("rolodex.saved") || "{}"); } catch {}
  const persistSaved = () => { try { localStorage.setItem("rolodex.saved", JSON.stringify(saved)); } catch (e) { $("#s1").textContent = "Could not save: browser storage is full or blocked."; } };
  // Signed on, saved and read stories belong to the account and are the same on every device; this browser's copy is a cache of that.
  // The first time an account meets a browser, whatever the browser had is uploaded and merged. Signed off, both lists live only here.
  const account = mine.cloud && mine.on;
  // (writes go one after another, and a refresh waits for the last of them before it reads the account back: see pullLatest)
  let pushing = Promise.resolve();
  const push = body => { if (account) pushing = pushing.then(() => fetch("/api/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {})); };
  const slim = snap => JSON.stringify(snap).length > 350000 ? { ...snap, content: "" } : snap;   // a very long story keeps its summary and link
  if (account) {
    const st = await fetch("/api/state", { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (st) {
      let owner = ""; try { owner = localStorage.getItem("rolodex.synced") || ""; } catch {}
      if (!owner) {   // this browser's lists have never been tied to an account: bring them along
        const mineOnly = Object.entries(saved).filter(([id]) => !st.saved[id]), have = new Set(st.read);
        push({ save: mineOnly.map(([id, snap]) => ({ id, snap: slim(snap) })), read: [...read].filter(id => !have.has(id)) });
        saved = { ...st.saved, ...saved }; read = new Set([...st.read, ...read]);
      } else { saved = st.saved; read = new Set(st.read); }
      // the Filter menu follows the account too: what was last chosen anywhere replaces what this browser remembered
      if (st.filters) try { for (const [k, f] of [["place", "places"], ["topic", "topics"], ["lang", "langs"], ["off", "off"]]) localStorage.setItem("rolodex." + k, JSON.stringify(st.filters[f] || [])); st.filters.days == null ? localStorage.removeItem("rolodex.days") : localStorage.setItem("rolodex.days", String(st.filters.days)); localStorage.setItem("rolodex.unread", st.filters.unread ? "1" : "0");
        // View's tastes follow the account too: paper, line spacing and the two tick boxes. Text size does not: it suits a screen, not a person.
        const v = st.filters.view; if (v) { localStorage.setItem("rolodex.paper", v.paper); localStorage.setItem("rolodex.lh", v.lh); localStorage.setItem("rolodex.tint", v.tint ? "1" : "0"); } } catch {}
      saveRead(); persistSaved(); try { localStorage.setItem("rolodex.synced", String(st.uid)); } catch {}
    }
  } else if (mine.cloud) {
    // signed off after having been signed on here: the account's lists do not stay behind on this browser
    try { if (localStorage.getItem("rolodex.synced")) { saved = {}; read = new Set(); saveRead(); persistSaved(); for (const k of ["synced", "place", "topic", "lang", "off", "days", "reads"]) localStorage.removeItem("rolodex." + k); } } catch {}
  }
  // snapshots of saved stories that have since left data.json come back as items
  for (const [id, snap] of Object.entries(saved)) if (!items.some(i => i.id === id)) { const { saved_at, ...it } = snap; mend(it); items.push({ ...it, d: new Date(it.date), size: new Blob([it.content || it.summary]).size, kind: (it.content || "").length > 1500 ? "Full text" : "Excerpt", archived: true }); }
  // With Unread only on, a story read while you are in the list stays where it is, shown as read: rows do not vanish under the reader.
  // The same in the Saved view: a story unsaved there stays, shown unsaved (no star), so it can be saved again.
  // `linger` holds those stories. They leave when the list is refreshed, or when the view, a filter or the dates change; saving, marking or
  // loading another day does not remove them.
  const linger = new Set();
  function toggleRead(id) {
    if (!id) return;
    if (read.has(id)) { read.delete(id); push({ unread: [id] }); } else { read.add(id); linger.add(id); push({ read: [id] }); }
    saveRead(); renderList(); renderStatus();
  }
  function setReadAll(ids, on) { for (const id of ids) on ? (read.add(id), linger.add(id)) : read.delete(id); push(on ? { read: ids } : { unread: ids }); saveRead(); renderList(); renderStatus(); }
  // The toolbar's envelope (and the U key) marks the selection when there is one, otherwise the story that is open. A selection with anything
  // unread in it is marked read; one that is all read is marked unread. Marking ends the selecting.
  function markNow() {
    const ids = [...picked];
    if (!ids.length) return toggleRead(sel);
    picked.clear(); anchor = null; setReadAll(ids, ids.some(id => !read.has(id)));
  }
  function toggleSave(id) {
    const it = items.find(i => i.id === id); if (!it) return;
    if (reading && reading.id === id) countReading();   // saving the story you have open (by button, key or swipe) shows you are reading it
    if (saved[id]) { delete saved[id]; if (savedOnly) linger.add(id); push({ unsave: [id] }); }   // in the Saved view the story stays in the list (see linger), so the open story is not pulled out from under the reader
    else { const { d, size, kind, archived, ...plain } = it; saved[id] = { ...plain, saved_at: new Date().toISOString() }; push({ save: [{ id, snap: slim(saved[id]) }] }); }
    persistSaved(); renderList(); if (sel === id) renderStatus();
  }

  // ---- state ----
  // Sources are remembered as the ones switched off, so an outlet added later starts switched on.
  let off = []; try { off = JSON.parse(localStorage.getItem("rolodex.off") || "[]"); if (!Array.isArray(off)) off = []; } catch {}
  const enabled = new Set(data.publications.filter(p => p.status === "ok" && !off.includes(p.id)).map(p => p.id));
  let mode = "chrono", sortKey = "date", sortDesc = true, hideRead = false, savedOnly = false, sel = null, rows = [];
  try { hideRead = localStorage.getItem("rolodex.unread") === "1"; } catch {}   // Unread only is a Filter choice like the others: it is kept
  // Writes (refresh, publications, probe) need a token on the public deployment. Asked for once, kept in this browser.
  let token = ""; try { token = localStorage.getItem("rolodex.token") || ""; } catch {}
  // On the web the operator is an account (the one marked in the database): sign on as it and the operator's rows appear. No token in the
  // browser. On the Mac, which is your own machine and has no accounts, Manage publications stays as the way to edit feeds.json.
  const operator = mine.cloud && mine.operator;
  $$(".menu .op").forEach(el => el.style.display = operator || !mine.cloud ? "" : "none");
  $("#m-manage").style.display = mine.cloud ? "none" : ""; $("#m-reports").style.display = operator ? "" : "none";
  // Help's last row: how to keep the reader as an app. Every system can, but each names it differently, so the row says it in this
  // browser's own words. It goes away where the reader is already running as one, or where the browser has no such thing (Firefox on a computer).
  (() => {
    const ua = navigator.userAgent, row = $("#h-install"), installed = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1), android = /Android/.test(ua);
    const words = ios ? "Share, then Add to Home Screen" : android ? "⋮ then Add to Home screen"
      : /Firefox\//.test(ua) ? "" : /Chrome\/|Edg\//.test(ua) ? "browser menu: Install as an app" : /Safari\//.test(ua) ? "File menu: Add to Dock" : "";
    if (installed || !words) row.style.display = "none"; else row.lastElementChild.textContent = words;
  })();
  $("#m-reports").onclick = () => { closeMenus(); document.dispatchEvent(new CustomEvent("reader:reports")); };
  // Who may make an account: by invitation (a friend's link) or anyone. The operator's switch; the row says which, and it takes effect at once.
  const door = async open => {
    const r = await fetch(open === undefined ? "/api/door" : "/api/op/signups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(open === undefined ? {} : { open }) }).then(r => r.json()).catch(() => null);
    if (r && "invite_only" in r) { $("#m-door").dataset.only = r.invite_only ? "1" : ""; $("#m-door").textContent = r.invite_only ? "Sign-ups: by invitation" : "Sign-ups: open to anyone"; }
  };
  if (operator) {
    $("#m-door").style.display = ""; door();
    // A link that got out: the operator ends one person's invite link. That person gets a new one the next time they press Invite a friend.
    $("#m-relink").style.display = "";
    $("#m-relink").onclick = async () => {
      closeMenus();
      const screen_name = await retroAsk({ title: "Reset an invite link", input: true, ok: "Next", placeholder: "screen name", text: "Whose link? It stops working at once. They get a new one the next time they press Invite a friend. Friends it already brought in stay." });
      if (!screen_name) return;
      const password = await retroAsk({ title: "Reset an invite link", input: true, secret: true, ok: "Reset the link", text: `Your password, to end ${screen_name}'s link.` });
      if (!password) return;
      const r = await fetch("/api/op/invite/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ screen_name, password }) }), d = await r.json().catch(() => ({}));
      retroAsk({ title: "Reset an invite link", cancel: "", text: r.ok ? `${d.screen_name}'s old link no longer works.` : d.error || `Error ${r.status}` });
    };
    $("#m-door").onclick = async () => {
      closeMenus(); const only = $("#m-door").dataset.only === "1";
      if (await retroAsk(only ? { title: "Sign-ups", ok: "Open to anyone", text: "Let anyone make an account?\n\nInvite links keep working, and still make the two people friends." }
        : { title: "Sign-ups", ok: "By invitation", text: "Go back to invitation only?\n\nA new account will need a friend's link. Nobody already here is affected." })) door(only);
    };
  }
  // Text size: "auto" scales the whole window with the viewport (1.0 at 1400px wide, up to 1.6x on big screens); phones stay at 1.0.
  let zoomMode = "auto"; try { zoomMode = localStorage.getItem("rolodex.zoom") || "auto"; } catch {}
  function applyZoom() {
    const w = innerWidth, auto = w <= 700 ? 1 : Math.min(1.6, Math.max(1, w / 1400));
    const z = zoomMode === "auto" ? auto : Number(zoomMode) || 1;
    document.documentElement.style.zoom = z === 1 ? "" : String(z);
    // one hundredth of the window's height as the scaled page measures it: sizes meant as "N% of the screen" use --vh and --vw, never vh, dvh or vw, so they stay inside the screen at any text size
    document.documentElement.style.setProperty("--vh", innerHeight / z / 100 + "px");
    document.documentElement.style.setProperty("--vw", innerWidth / z / 100 + "px");
    document.documentElement.style.setProperty("--unz", String(1 / z));   // undoes the scaling, for the phone's fixed bars (see index.html)
    document.dispatchEvent(new CustomEvent("reader:zoom"));   // chat.js keeps its own measure of the visible height in step
    $$("input[name=zoom]").forEach(r => r.checked = r.value === zoomMode);
  }
  $$("input[name=zoom]").forEach(r => r.onchange = () => { zoomMode = r.value; try { localStorage.setItem("rolodex.zoom", zoomMode); } catch {} applyZoom(); });
  applyZoom(); addEventListener("resize", applyZoom);
  // Line spacing (View): how far apart the lines of a story's text sit. Kept in this browser, like text size and paper.
  let lh = "1.25"; try { lh = localStorage.getItem("rolodex.lh") || "1.25"; } catch {}
  if (!["1.25", "1.45", "1.65"].includes(lh)) lh = "1.25";
  const applyLh = () => { document.documentElement.style.setProperty("--lh", lh); $$("input[name=lh]").forEach(r => r.checked = r.value === lh); document.dispatchEvent(new CustomEvent("reader:zoom")); };   // (the event: anything that measures the page measures again)
  $$("input[name=lh]").forEach(r => r.onchange = () => { lh = r.value; try { localStorage.setItem("rolodex.lh", lh); } catch {} applyLh(); keep(); });
  applyLh();
  let paper = "white"; try { paper = localStorage.getItem("rolodex.paper") || "white"; } catch {}
  if (!["white", "sepia", "night"].includes(paper)) paper = "white";   // Dusk was replaced by Night
  // paper.js has already set this before first paint; here the menu is kept in step and a change is stored. Night also blackens the phone's status bar.
  let syncBusy = false, holdSync = false;   // (sync, below: the operator's Saved view; these are read by renderStatus, so they are defined early)
  const syncOn = () => savedOnly && operator && !$(".window").classList.contains("gossip");
  let readView = "";   // My reading opens with nothing charted; the reader picks a view: "read" (what you read) or "vol" (Story volume: the last 72 hours of arrivals)
  const chartOpen = () => $("#readshade").classList.contains("on") && readView === "vol";
  function setPaper(v) { paper = v; document.documentElement.dataset.paper = v; document.querySelector('meta[name="theme-color"]').content = v === "night" ? "#000000" : "#171614"; if (chartOpen()) drawChart(); $$("input[name=paper]").forEach(r => r.checked = r.value === v); try { localStorage.setItem("rolodex.paper", v); } catch {} }
  setPaper(paper);
  $$("input[name=paper]").forEach(r => r.onchange = () => { setPaper(r.value); keep(); });   // a paper chosen by hand is kept on the account (after the variable has changed, or the account would be told the old one)
  let tint = false; try { tint = localStorage.getItem("rolodex.tint") === "1"; } catch {}
  const applyTint = () => { document.documentElement.dataset.tint = tint ? "1" : "0"; $("#m-tint").checked = tint; };
  applyTint(); $("#m-tint").onchange = e => { tint = e.target.checked; try { localStorage.setItem("rolodex.tint", tint ? "1" : "0"); } catch {} applyTint(); keep(); };
  // one companion window, reused for every story, so a site login made there persists
  function companion(url) { const w = Math.min(1000, screen.availWidth * .6); window.open(url, "rolodex-site", `popup=yes,width=${w},height=${screen.availHeight - 60},left=${screen.availWidth - w},top=30`); }
  function setSite(on) { const a = $("#article"), f = a.querySelector(".frame iframe"); if (!f) return; a.classList.toggle("site", on); if (on && !f.src) f.src = f.dataset.src; const b = $("#b-site"); if (b) { b.classList.toggle("on", on); b.textContent = on ? "Feed text" : "Site view"; }
    // on a phone Open is the globe in the running head (not a button of the bar, always on screen under it): there it shows the outlet's page in place
    readProgress();
    for (const o of $$("#article .pinopen[data-act=site]")) { o.classList.toggle("on", on); o.setAttribute("aria-pressed", on); say(o, on ? "Showing the outlet's page. Back to the feed's text" : "Open the outlet's page here"); } }
  // The reader's story starts at midnight on 1 October 2026 (local time). Feeds sometimes carry a stray older item, and those should not
  // drag the default range back by months. `earliest` is the true oldest story, still reachable by picking an earlier From date;
  // `oldest` is where the range starts by default and where "All dates" returns to.
  const START = new Date(2026, 9, 1);
  const earliest = items.length ? items.reduce((a, b) => a.d < b.d ? a : b).d : new Date();   // a brand-new list may have no stories yet
  const oldest = earliest < START ? START : earliest;
  $("#from").value = ymd(oldest); $("#from").min = ymd(oldest);
  $("#to").value = ymd(new Date()); $("#to").max = ymd(new Date());
  // A range picked from the menu's list (Today, Last 7 days…) is remembered as a rolling window: so many days back from whatever today is.
  // Dates picked on the calendar are a one-off look and are not remembered: a kept end date would hide tomorrow's stories.
  let days = null; try { const v = localStorage.getItem("rolodex.days"); if (v !== null && [0, 1, 3, 7, 30].includes(Number(v))) days = Number(v); } catch {}
  function setWindow() {
    const today = new Date(), f = new Date(today); if (days !== null) f.setDate(f.getDate() - days);
    $("#from").value = ymd(days === null || f < oldest ? oldest : f); $("#to").value = ymd(today);
  }
  setWindow();

  // ---- dropdowns ----
  // Each dropdown keeps a handle to its menu. A menu drops down from the bar its button is in, on a phone as on a desk. On a phone that is
  // done in CSS alone (`.menu.sheet` in index.html): the menu hangs under its bar, held to the bar's left edge, or to its right edge when the
  // button is in the right half (`fromright`). Nothing is measured in script, so a menu cannot be placed off the screen: an earlier version
  // computed left and top from rectangles, and on a real iPhone those came out wrong. `sheet` also gives the menu its phone sizes.
  const dds = $$(".dd").map(dd => ({ dd, menu: dd.querySelector(".menu"), btn: dd.querySelector("button") }));
  const isPhone = () => matchMedia("(max-width: 700px)").matches;
  function closeMenus(except) {
    for (const d of dds) {
      if (d.dd === except) continue;
      d.menu.classList.remove("on", "sheet", "fromright"); d.dd.classList.remove("open"); d.btn?.setAttribute("aria-expanded", "false");
    }
    $("#sheet-shade").classList.toggle("on", dds.some(d => d.menu.classList.contains("sheet")));
  }
  for (const d of dds) {
    (d.btn || d.dd).addEventListener("click", e => {
      if (e.target.closest(".menu")) return;
      const on = !d.menu.classList.contains("on");
      closeMenus(d.dd);
      // a button in the right half of the screen opens its menu leftward, at every width, so the menu cannot leave the window
      if (on) { const r = (d.btn || d.dd).getBoundingClientRect(); d.menu.classList.toggle("fromright", r.left + r.width / 2 > innerWidth / 2); }
      if (on && isPhone()) { d.menu.classList.add("sheet"); $("#sheet-shade").classList.add("on"); }
      else if (!on) { d.menu.classList.remove("sheet", "fromright"); $("#sheet-shade").classList.remove("on"); }
      d.menu.classList.toggle("on", on); d.dd.classList.toggle("open", on); d.btn?.setAttribute("aria-expanded", on);
      e.stopPropagation();
    });
  }
  document.addEventListener("click", e => { if (!e.target.closest(".dd, .menu")) closeMenus(); });
  $("#sheet-shade").addEventListener("click", () => closeMenus());

  // ---- sources menu ----
  // An outlet with several feeds on the list (NYT · New York, NYT · Politics) shows as one row that opens to its sections.
  // Ticking the outlet ticks all of them; "only" narrows the list to that one outlet or section in a tap.
  const groupOf = p => p.group || p.id;
  const openGroups = new Set(data.publications.filter(p => p.group).map(p => p.group));   // an outlet's sections start in view: they are what you came to Sources for
  function renderSources() {
    const groups = new Map(); for (const p of data.publications) (groups.get(groupOf(p)) || groups.set(groupOf(p), []).get(groupOf(p))).push(p);
    // a source's count is its stories inside the date range and the other filters (Topic, Place, Language): what ticking only it would list
    const cnt = {}; for (const i of items) if (inRange(i) && inPlaces(placesOf(i)) && inTopics(topicsOf(i)) && inLangs(langOf(i))) cnt[i.pub] = (cnt[i.pub] || 0) + 1;
    const count = id => cnt[id] || 0, total = ps => ps.reduce((n, p) => n + count(p.id), 0);
    const line = (p, label, depth) => { const off = p.status !== "ok";
      return `<div class="row ${off ? "off" : ""}" style="padding-left:${depth * 14}px"><span class="tw"></span><label><input type="checkbox" data-id="${p.id}" ${enabled.has(p.id) ? "checked" : ""} ${off ? "disabled" : ""}><span class="sw" style="background:${p.color}"></span>${esc(label)}</label><span class="c">${off ? p.status : count(p.id)}</span>${off ? "" : `<button class="only" data-only="${p.id}">only</button>`}</div>`; };
    const key = ps => ps[0].name.replace(/^the\s+/i, "");   // Sources reads most stories first, ties A to Z; sections the same inside their outlet
    $("#src-menu").innerHTML = [...groups].sort((a, b) => total(b[1]) - total(a[1]) || key(a[1]).localeCompare(key(b[1]), undefined, { sensitivity: "base" })).map(([g, ps]) => {
      ps.sort((a, b) => count(b.id) - count(a.id) || (a.section || "").localeCompare(b.section || ""));
      if (ps.length === 1) return line(ps[0], ps[0].name + (ps[0].section && ps[0].section !== ps[0].name ? " · " + ps[0].section : ""), 0);
      const live = ps.filter(p => p.status === "ok"), on = live.filter(p => enabled.has(p.id)).length, open = openGroups.has(g);
      return `<div class="row"><span class="tw" data-gtw="${esc(g)}">${open ? "▾" : "▸"}</span><label><input type="checkbox" data-group="${esc(g)}" ${on && on === live.length ? "checked" : ""} ${on && on < live.length ? "data-some" : ""} ${live.length ? "" : "disabled"}><span class="sw" style="background:${ps[0].color}"></span>${esc(ps[0].name)}</label><span class="c">${total(ps)}</span><button class="only" data-only-group="${esc(g)}">only</button></div>`
        + (open ? ps.map(p => line(p, p.section || p.name, 1)).join("") : "");
    }).join("") + `<hr><div class="btns"><button id="all">All</button><button id="none">None</button></div>` + (mine.cloud ? `<hr><div class="row act" id="src-add" tabindex="0" role="menuitem">Manage feed</div>` : "");
    $$("#src-menu input[data-some]").forEach(i => i.indeterminate = true);   // some of its sections are ticked
    $("#all").onclick = () => { data.publications.forEach(p => p.status === "ok" && enabled.add(p.id)); renderSources(); renderList(); keep(); };
    $("#none").onclick = () => { enabled.clear(); renderSources(); renderList(); keep(); };
    const ok = data.publications.filter(p => p.status === "ok").length;
    $("#src-n").textContent = enabled.size === ok ? "All" : `Custom · ${enabled.size} of ${ok}`;
    filterLabel();
  }
  // Filter is one menu with five parts, in this order: Dates, Sources, Topic, Place, Language, and a tick for unread only. Its button says,
  // in words beside the funnel, how many things are narrowing the list.
  const datesOn = () => !($("#from").value === ymd(oldest) && $("#to").value === ymd(new Date()));
  function filterLabel() {
    const n = (typeof topics === "undefined" ? 0 : topics.size + places.size + langs.size) + (enabled.size !== data.publications.filter(p => p.status === "ok").length ? 1 : 0) + (datesOn() ? 1 : 0) + (hideRead ? 1 : 0);
    $("#filter-n").textContent = n ? `${n} on` : ""; $("#b-filter").title = n ? `Filter the list: ${n} on` : "Filter the list"; $("#b-filter").setAttribute("aria-label", n ? `Filter, ${n} on` : "Filter");
    $("#f-clear").disabled = !n; $("#f-clear-n").textContent = n ? String(n) : ""; $("#f-clear").setAttribute("aria-label", n ? `Clear all filters: ${n} on` : "Clear all filters: none on");
    $("#f-unread").classList.toggle("on", hideRead); $("#f-unread").setAttribute("aria-pressed", hideRead);
  }
  // Dates, Sources, Topic, Place and Language are roll-ups built the same way: a heading that says what is on, opening to rows with a tick box,
  // a story count and an "only" button. They start folded so the whole menu is a few lines.
  $$("#filter-menu .sec").forEach(h => h.onclick = () => { const body = $(`#${h.dataset.sec}-menu`), open = body.style.display === "none"; body.style.display = open ? "" : "none"; h.querySelector(".tw").textContent = open ? "▾" : "▸"; });
  // Edit → Add to feed… and Manage feed… open the same window from two ends: the outlet lookup first, or your list first.
  // On the Mac, which has no accounts, both open Manage publications (its lookup box is at the foot).
  const openFeeds = add => { closeMenus(); mine.cloud ? document.dispatchEvent(new CustomEvent("reader:feeds", { detail: { add: add === true } })) : openManage(); };
  $("#m-feeds").onclick = () => openFeeds(false); $("#m-addfeed").onclick = () => openFeeds(true);
  const members = g => data.publications.filter(p => groupOf(p) === g && p.status === "ok").map(p => p.id);
  $("#src-menu").addEventListener("click", e => {
    e.stopPropagation();   // these redraw the list; do not let that read as an outside click
    const t = e.target, tw = t.closest("[data-gtw]"), only = t.closest(".only");
    if (t.closest("#src-add")) return openFeeds();
    if (tw) { openGroups.has(tw.dataset.gtw) ? openGroups.delete(tw.dataset.gtw) : openGroups.add(tw.dataset.gtw); return renderSources(); }
    if (only) { enabled.clear(); (only.dataset.only ? [only.dataset.only] : members(only.dataset.onlyGroup)).forEach(id => enabled.add(id)); renderSources(); renderList(); keep(); }
  });
  $("#src-menu").addEventListener("change", e => {
    const { id, group } = e.target.dataset; if (!id && !group) return;
    for (const x of id ? [id] : members(group)) e.target.checked ? enabled.add(x) : enabled.delete(x);
    renderSources(); renderList(); keep();
  });

  // ---- place and topic: filters on stories, not on publications ----
  // Place = the outlet's coverage area (its tags: NYC, a borough, a neighborhood, National) plus the places Jev found in the story.
  // Topic = Jev's article tags; a story with none files under Other. Sources stays as the manual override on top.
  const BOROS = Object.keys(tax.boroughs), hoodBoro = new Map(BOROS.flatMap(b => tax.boroughs[b].map(n => [n, b])));
  const TOPICS = [...Object.keys(tax.topics).filter(t => t !== "Other").sort((a, b) => a.localeCompare(b)), "Other"];   // A to Z, with Other last
  const isPlaceTag = t => BOROS.includes(t) || hoodBoro.has(t);
  const placeCache = new Map();
  // ---- countries: worked out here, like language ----
  // The tagger knows New York's boroughs and neighborhoods, not countries. A story's countries are the ones named in its headline and summary
  // (not the full text: a passing mention deep in a story is not what it is about); a story that names none takes its outlet's home country,
  // which is the United States for an outlet tagged NYC, a borough or National, or else the country of its web address (.br is Brazil).
  // Names are matched as written, capitals and all, so "US" is the country and "us" is not. Left out on purpose because they are more often
  // something else here: Georgia (the state), Jordan and Chad (names), Jamaica (the Queens neighborhood). Common Portuguese and Spanish
  // spellings are included. To add a country or a spelling, add it to the list: Name=Other spelling|Another.
  const US = "United States", COUNTRY_OF = new Map();
  for (const e of "United States=U.S.A.|U.S.|USA|US|Estados Unidos|EUA|EE.UU.;Afghanistan=Afeganistão|Afganistán;Albania;Algeria=Argélia|Argelia;Angola;Argentina;Armenia;Australia=Austrália;Austria=Áustria;Azerbaijan;Bahamas;Bahrain;Bangladesh;Barbados;Belarus;Belgium=Bélgica;Belize;Benin;Bhutan;Bolivia=Bolívia;Bosnia;Botswana;Brazil=Brasil;Bulgaria;Burkina Faso;Burundi;Cambodia;Cameroon;Canada=Canadá;Chile;China;Colombia=Colômbia;Congo;Costa Rica;Croatia;Cuba;Cyprus;Czech Republic=Czechia;Denmark=Dinamarca;Dominican Republic=República Dominicana;Ecuador=Equador;Egypt=Egito|Egipto;El Salvador;Eritrea;Estonia;Ethiopia=Etiópia|Etiopía;Fiji;Finland=Finlândia;France=França|Francia;Gabon;Gambia;Germany=Alemanha|Alemania;Ghana=Gana;Greece=Grécia|Grecia;Guatemala;Guinea;Guyana;Haiti=Haití;Honduras;Hungary=Hungria|Hungría;Iceland;India=Índia;Indonesia=Indonésia;Iran=Irã|Irán;Iraq=Iraque|Irak;Ireland=Irlanda;Israel;Italy=Itália|Italia;Ivory Coast=Côte d'Ivoire;Japan=Japão|Japón;Kazakhstan;Kenya=Quênia|Kenia;Kosovo;Kuwait;Kyrgyzstan;Laos;Latvia;Lebanon=Líbano;Liberia;Libya=Líbia|Libia;Lithuania;Luxembourg;Madagascar;Malawi;Malaysia;Mali;Malta;Mauritania;Mexico=México;Moldova;Mongolia;Montenegro;Morocco=Marrocos|Marruecos;Mozambique=Moçambique;Myanmar=Burma;Namibia;Nepal;Netherlands=Holanda|Países Baixos|Países Bajos;New Zealand=Nova Zelândia|Nueva Zelanda;Nicaragua=Nicarágua;Niger;Nigeria=Nigéria;North Korea=Coreia do Norte|Corea del Norte;North Macedonia;Norway=Noruega;Oman;Pakistan=Paquistão|Pakistán;Palestine=Palestina|Gaza|West Bank|Cisjordânia|Cisjordania;Panama=Panamá;Papua New Guinea;Paraguay=Paraguai;Peru=Perú;Philippines=Filipinas;Poland=Polônia|Polonia;Portugal;Qatar=Catar;Romania=Romênia|Rumanía;Russia=Rússia|Rusia;Rwanda=Ruanda;Saudi Arabia=Arábia Saudita|Arabia Saudita;Senegal;Serbia=Sérvia;Sierra Leone;Singapore=Singapura|Singapur;Slovakia;Slovenia;Somalia=Somália;South Africa=África do Sul|Sudáfrica;South Korea=Coreia do Sul|Corea del Sur;South Sudan=Sudão do Sul|Sudán del Sur;Spain=Espanha|España;Sri Lanka;Sudan=Sudão|Sudán;Suriname;Sweden=Suécia|Suecia;Switzerland=Suíça|Suiza;Syria=Síria|Siria;Taiwan;Tajikistan;Tanzania=Tanzânia;Thailand=Tailândia|Tailandia;Togo;Trinidad and Tobago;Tunisia=Tunísia|Túnez;Turkey=Türkiye|Turquia|Turquía;Turkmenistan;Uganda;Ukraine=Ucrânia|Ucrania;United Arab Emirates=UAE|Emirados Árabes|Emiratos Árabes;United Kingdom=U.K.|UK|Britain|Reino Unido|England|Scotland|Wales|Inglaterra;Uruguay=Uruguai;Uzbekistan;Venezuela;Vietnam=Vietnã;Yemen=Iêmen;Zambia=Zâmbia;Zimbabwe=Zimbábue".split(";")) { const [name, more] = e.split("="); COUNTRY_OF.set(name, name); for (const a of more ? more.split("|") : []) COUNTRY_OF.set(a, name); }
  const COUNTRY_RE = new RegExp(`(^|[^\\p{L}])(${[...COUNTRY_OF.keys()].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}])`, "gu");
  const TLD = { br: "Brazil", uk: "United Kingdom", mx: "Mexico", ar: "Argentina", pt: "Portugal", es: "Spain", fr: "France", de: "Germany", it: "Italy", ca: "Canada", au: "Australia", in: "India", jp: "Japan", ie: "Ireland", il: "Israel", cn: "China", ru: "Russia", kr: "South Korea", ht: "Haiti", do: "Dominican Republic", cl: "Chile", pe: "Peru", ec: "Ecuador", ve: "Venezuela", cu: "Cuba", pl: "Poland", gr: "Greece", nl: "Netherlands", za: "South Africa", ng: "Nigeria", bd: "Bangladesh", pk: "Pakistan", tr: "Turkey", ua: "Ukraine" };
  const homeCountry = p => (p.tags || []).some(t => t === "NYC" || t === "National" || isPlaceTag(t)) ? US : TLD[hostName(p.home || p.feed || "").split(".").pop()] || US;
  function countriesOf(it) {
    const text = it.title + " " + String(it.summary || "").replace(/<[^>]+>/g, " ").slice(0, 600), found = new Set();
    for (const m of text.matchAll(COUNTRY_RE)) { if (m[2] === "Mexico" && /New\s$/.test(text.slice(0, m.index + m[1].length))) continue; found.add(COUNTRY_OF.get(m[2])); }
    if (!found.size) found.add(homeCountry(pubs.get(it.pub)));
    return found;
  }
  function placesOf(it) {
    let s = placeCache.get(it.id); if (s) return s;
    const tags = pubs.get(it.pub).tags || [];
    s = new Set([...tags.filter(isPlaceTag), ...(it.places || []).map(p => p.name)]);
    for (const n of [...s]) if (hoodBoro.has(n)) s.add(hoodBoro.get(n));
    if (s.size || tags.includes("NYC")) s.add("NYC");
    if (tags.includes("NYC") && !tags.some(isPlaceTag)) s.add("Citywide");
    if (tags.includes("National")) s.add("National");
    for (const c of countriesOf(it)) s.add(c);
    if (s.has("NYC") || s.has("National")) s.add(US);   // New York and the national outlets sit inside the United States
    placeCache.set(it.id, s); return s;
  }
  // A topic that has been renamed keeps its old name on stories tagged before the change (and in saved copies and remembered filters);
  // taxonomy.json's `renamed` maps old to new, and it is applied here, once, as the page loads.
  const REN = tax.renamed || {};
  for (const it of items) for (const t of it.topics || []) if (REN[t.name]) t.name = REN[t.name];
  const topicsOf = it => it.topics?.length ? it.topics.map(t => t.name) : ["Other"];
  // ---- language: worked out here, from each story's own words ----
  // Neither fetcher records a language, and an outlet can publish in two (Documented and City Limits run Spanish pieces among English ones),
  // so it is decided per story, in the page: that covers the whole archive and saved copies with nothing to refetch or re-tag.
  // The script settles it where it can (Chinese, Korean, Cyrillic, Hebrew letters…). For the Latin alphabet, each language's small everyday
  // words are counted and a clear winner is taken. A story too short to call takes the language most of its outlet's sure stories are in.
  const SCRIPTS = [[/[぀-ヿ]/g, "Japanese"], [/[가-힯]/g, "Korean"], [/[一-鿿]/g, "Chinese"], [/[ঀ-৿]/g, "Bengali"], [/[ऀ-ॿ]/g, "Hindi"],
    [/[؀-ۿ]/g, "Arabic"], [/[Ͱ-Ͽ]/g, "Greek"], [/[֐-׿]/g, "Hebrew"], [/[Ѐ-ӿ]/g, "Russian"]];
  const WORDS = {
    English: "the and of to is for with that was are from at by has his her this will after its said who be have it not but they their were been an about more than",
    Spanish: "el la los las que y en un una por con para del se su es al como más pero sus fue tras entre sobre según años está han también desde",
    Portuguese: "o os em um uma do da dos das na nas nos com para não ao mais mas foi são após pelo pela à é também diz que por seu sua",
    French: "le la les des du et est un une dans pour que qui sur pas au aux avec par ce cette plus été sont ses leur mais",
    Italian: "il lo gli di che è un una per con non del della dei nel sono più anche dopo alla delle",
    German: "der die das und ist nicht mit von den dem ein eine für auf zu im sich auch nach wird des",
    Polish: "w z na się nie że jest po dla jak przez od oraz są tym jego",
    "Haitian Creole": "nan yon ak pou ki li yo se pa sa gen moun nou kote te ap",
  };
  const WORDSETS = Object.entries(WORDS).map(([name, list]) => [name, new Set(list.split(" "))]);
  function guessLang(it) {
    const text = (it.title + " " + String(it.summary || it.content || "").replace(/<[^>]+>/g, " ")).slice(0, 900).toLowerCase();
    const letters = (text.match(/\p{L}/gu) || []).length || 1;
    for (const [re, name] of SCRIPTS) {
      if ((text.match(re) || []).length / letters < 0.25) continue;
      if (name === "Russian" && /[іїєґ]/.test(text)) return { lang: "Ukrainian", sure: true };
      if (name === "Hebrew" && /[װ-ײ]|(^|\s)(און|די|פון|איז|אין)(\s|$)/.test(text)) return { lang: "Yiddish", sure: true };
      return { lang: name, sure: true };
    }
    const words = text.match(/\p{L}+/gu) || [], score = WORDSETS.map(([name, set]) => [name, words.reduce((n, w) => n + set.has(w), 0)]).sort((a, b) => b[1] - a[1]);
    return { lang: score[0][1] ? score[0][0] : null, sure: score[0][1] >= 4 && score[0][1] >= 1.6 * score[1][1] };
  }
  const langCache = new Map(), pubLang = new Map();
  { const tally = new Map();
    for (const it of items) { const g = guessLang(it); langCache.set(it.id, g); if (g.sure) { const t = tally.get(it.pub) || tally.set(it.pub, {}).get(it.pub); t[g.lang] = (t[g.lang] || 0) + 1; } }
    for (const [pub, t] of tally) pubLang.set(pub, Object.entries(t).sort((a, b) => b[1] - a[1])[0][0]);
    for (const it of items) { const g = langCache.get(it.id); langCache.set(it.id, g.sure ? g.lang : pubLang.get(it.pub) || g.lang || "English"); } }
  const langOf = it => langCache.get(it.id) || "English";
  const LANGS = [...new Set(langCache.values())].sort((a, b) => a.localeCompare(b));   // only the languages the list actually holds
  const validPlace = v => ["all", "NYC", "Citywide", "National"].includes(v) || isPlaceTag(v) || COUNTRY_OF.get(v) === v;
  // The menus are multi-select. Within a menu the ticks add up (Tech or Sports); across menus they narrow (Tech or Sports, in Brooklyn, in Spanish).
  // Nothing ticked means everything.
  const places = new Set(), topics = new Set(), langs = new Set();
  const stored = k => { try { const v = localStorage.getItem(k); if (!v || v === "all") return []; const j = v[0] === "[" ? JSON.parse(v) : [v]; return Array.isArray(j) ? j : []; } catch { return []; } };   // earlier versions kept one name, not a list
  stored("rolodex.place").filter(v => v !== "all" && validPlace(v)).forEach(v => places.add(v)); stored("rolodex.topic").map(v => REN[v] || v).filter(v => TOPICS.includes(v)).forEach(v => topics.add(v)); stored("rolodex.lang").filter(v => LANGS.includes(v)).forEach(v => langs.add(v));
  try { localStorage.removeItem("rolodex.view"); } catch {}
  const inPlaces = ps => !places.size || [...places].some(p => ps.has(p)), inTopics = ts => !topics.size || ts.some(t => topics.has(t)), inLangs = l => !langs.size || langs.has(l);
  // The place tree: United States first (open, showing New York City, Citywide outlets and National), then the other countries by story count.
  // New York City starts folded; a ticked borough or neighborhood opens the path to itself.
  const openNodes = new Set(["US"]);
  function revealPlace() { for (const p of places) { if (["NYC", "Citywide", "National"].includes(p) || isPlaceTag(p)) openNodes.add("US"); if (isPlaceTag(p)) { openNodes.add("NYC"); if (hoodBoro.has(p)) openNodes.add(hoodBoro.get(p)); } } }
  revealPlace();
  // View's paper, line spacing and two tick boxes ride along in the same record (not text size, which is per device).
  // Unread only, Topic, Place, Language, Sources and the rolling date window are kept in this browser and, signed on, on the account, so every device opens to the same Filter.
  let keepT = 0;
  function keep() {
    const f = { off: data.publications.filter(p => p.status === "ok" && !enabled.has(p.id)).map(p => p.id), places: [...places], topics: [...topics], langs: [...langs], days, unread: hideRead, view: { paper, lh, tint } };
    try { localStorage.setItem("rolodex.unread", hideRead ? "1" : "0"); days === null ? localStorage.removeItem("rolodex.days") : localStorage.setItem("rolodex.days", String(days)); localStorage.setItem("rolodex.place", JSON.stringify(f.places)); localStorage.setItem("rolodex.topic", JSON.stringify(f.topics)); localStorage.setItem("rolodex.lang", JSON.stringify(f.langs)); localStorage.setItem("rolodex.off", JSON.stringify(f.off)); } catch {}
    clearTimeout(keepT); keepT = setTimeout(() => push({ filters: f }), 400);   // several ticks in a row are one write
  }
  function changed() { keep(); revealPlace(); renderList(); }
  function renderFacets() {
    // counts follow Sources, Dates and the other menus, so a number is what ticking only that row would list
    const pc = {}, tc = {}, lc = {}; let allP = 0, allT = 0, allL = 0;
    for (const i of items) {
      if ((savedOnly ? !saved[i.id] : !enabled.has(i.pub)) || !inRange(i)) continue;   // while Saved is on, the counts are counts of saved stories
      const ps = placesOf(i), ts = topicsOf(i), lg = langOf(i), P = inPlaces(ps), T = inTopics(ts), L = inLangs(lg);
      if (T && L) { allP++; for (const p of ps) pc[p] = (pc[p] || 0) + 1; }
      if (P && L) { allT++; for (const t of ts) tc[t] = (tc[t] || 0) + 1; }
      if (P && T) { allL++; lc[lg] = (lc[lg] || 0) + 1; }
    }
    const row = (name, val, on, label, n, depth, tw) => `<div class="row${n ? "" : " zero"}" style="padding-left:${depth * 14}px"><span class="tw" ${tw ? `data-tw="${esc(tw)}"` : ""}>${tw ? (openNodes.has(tw) ? "▾" : "▸") : ""}</span><label><input type="checkbox" name="${name}" value="${esc(val)}" ${on ? "checked" : ""}>${esc(label)}</label><span class="c">${n || 0}</span>${val === "all" ? "" : `<button class="only" data-only-${name}="${esc(val)}">only</button>`}</div>`;
    let h = row("place", "all", !places.size, "All places", allP, 0) + "<hr>" + row("place", US, places.has(US), US, pc[US], 0, "US");
    if (openNodes.has("US")) {
      h += row("place", "NYC", places.has("NYC"), "New York City", pc.NYC, 1, "NYC");
      if (openNodes.has("NYC")) for (const b of BOROS) {
        const hoods = tax.boroughs[b].filter(n => pc[n] || places.has(n));
        h += row("place", b, places.has(b), b, pc[b], 2, hoods.length ? b : "");
        if (openNodes.has(b)) h += hoods.map(n => row("place", n, places.has(n), n, pc[n], 3)).join("");
      }
      h += row("place", "Citywide", places.has("Citywide"), "Citywide outlets", pc.Citywide, 1) + row("place", "National", places.has("National"), "National", pc.National, 1);
    }
    // every other country the list holds, the one with the most stories first (ties A to Z)
    h += [...new Set([...COUNTRY_OF.values()])].filter(c => c !== US && (pc[c] || places.has(c))).sort((a, b) => (pc[b] || 0) - (pc[a] || 0) || a.localeCompare(b)).map(c => row("place", c, places.has(c), c, pc[c], 0)).join("");
    $("#place-menu").innerHTML = h;
    $("#topic-n").textContent = topics.size ? `${topics.size} on` : "All"; $("#place-n").textContent = places.size ? `${places.size} on` : "All";
    $("#topic-menu").innerHTML = row("topic", "all", !topics.size, "All topics", allT, 0) + "<hr>" + [...TOPICS].sort((a, b) => (tc[b] || 0) - (tc[a] || 0) || (a === "Other") - (b === "Other") || a.localeCompare(b)).map(t => row("topic", t, topics.has(t), t, tc[t], 0)).join("");   // most stories first, ties A to Z
    $("#lang-n").textContent = langs.size ? `${langs.size} on` : "All";
    $("#lang-menu").innerHTML = row("lang", "all", !langs.size, "All languages", allL, 0) + "<hr>" + [...LANGS].sort((a, b) => (lc[b] || 0) - (lc[a] || 0) || a.localeCompare(b)).map(l => row("lang", l, langs.has(l), l, lc[l], 0)).join("");   // most stories first, ties A to Z
    filterLabel();
    $$("#article button.tag").forEach(b => b.classList.toggle("on", !!tagView && tagView.value === (b.dataset.place || b.dataset.topic)));
  }
  // "only" narrows to that one topic or place in a tap. These handlers redraw the rows, so the click is stopped here: otherwise the vanished
  // target would be taken for a tap outside the menu and close it.
  const only = (set, v) => { set.clear(); set.add(v); changed(); };
  $("#topic-menu").addEventListener("click", e => { e.stopPropagation(); const o = e.target.closest("[data-only-topic]"); if (o) only(topics, o.dataset.onlyTopic); });
  $("#lang-menu").addEventListener("click", e => { e.stopPropagation(); const o = e.target.closest("[data-only-lang]"); if (o) only(langs, o.dataset.onlyLang); });
  $("#place-menu").addEventListener("click", e => {
    e.stopPropagation();
    const o = e.target.closest("[data-only-place]"), tw = e.target.closest("[data-tw]");
    if (o) return only(places, o.dataset.onlyPlace);
    if (!tw) return;
    openNodes.has(tw.dataset.tw) ? openNodes.delete(tw.dataset.tw) : openNodes.add(tw.dataset.tw);
    renderFacets();
  });
  // ticking keeps the menu open so several can be chosen; "All" clears the rest
  const tick = set => e => { const v = e.target.value; if (v === "all") set.clear(); else e.target.checked ? set.add(v) : set.delete(v); changed(); };
  // one tap back to everything: all dates, no topics, no places, no languages, every source, read and unread
  $("#f-clear").onclick = e => { e.stopPropagation(); hideRead = false; days = null; setWindow(); calFor = null; drawCal(); topics.clear(); places.clear(); langs.clear(); data.publications.forEach(p => p.status === "ok" && enabled.add(p.id)); renderSources(); changed(); };
  $("#place-menu").addEventListener("change", tick(places));
  $("#topic-menu").addEventListener("change", tick(topics));
  $("#lang-menu").addEventListener("change", tick(langs));
  // Tapping a story's tag opens the tag view: the stories with that tag in the feed you came from (see visible()). It is a place you visit,
  // not a filter you set: the Place, Topic and Sources ticks are untouched. "‹ Your story" goes back to the story the tag was tapped on,
  // and from a story "‹ Feed" goes to the feed as it was.
  let tagView = null;
  // The same kind of visit works for an outlet: tapping its name above a headline lists everything from it, all of its sections together.
  const inTag = i => tagView.kind === "pub" ? groupOf(pubs.get(i.pub)) === tagView.key : tagView.kind === "place" ? placesOf(i).has(tagView.value) : topicsOf(i).includes(tagView.value);
  function openTag(kind, value, key) {
    document.dispatchEvent(new CustomEvent("reader:leavegossip"));   // a tag tapped on a story opened from a conversation leaves the Gossip Column for the feed
    tagView = { kind, value, key, from: sel }; closeMenus();   // remember the story the tag was tapped on: that is where "‹ Your story" returns
    $(".window").classList.add("tagview"); $(".window").classList.remove("reading");   // on a phone, back to the list screen, now showing the tag
    renderList(); $("#list").scrollTop = 0;
  }
  function closeTag() { tagView = null; $(".window").classList.remove("tagview"); renderList(); }
  $("#tag-back").onclick = () => { const from = tagView && tagView.from; closeTag(); if (from) show(from, true, true); };
  $("#article").addEventListener("click", e => {
    const b = e.target.closest("button.tag"), o = e.target.closest(".outlet");
    if (b) openTag(b.dataset.place ? "place" : "topic", b.dataset.place || b.dataset.topic);
    if (o) openTag("pub", o.textContent, o.dataset.key);
    const rp = e.target.closest(".report"); if (rp) document.dispatchEvent(new CustomEvent("reader:report", { detail: { pub: rp.dataset.pub, name: rp.dataset.name } }));
  });

  // ---- arrange / dates / view ----
  $$("input[name=mode]").forEach(r => r.onchange = () => { mode = r.value; renderList(); });
  $$("input[name=sort]").forEach(r => r.onchange = () => { sortKey = r.value; sortDesc = r.value === "date"; renderList(); });
  // ---- the date picker: a month drawn inside Filter's Dates part ----
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  let calFor = null, calMonth = null;
  function drawCal() {
    $$(".datebtn").forEach(b => b.classList.toggle("on", b.dataset.for === calFor));
    const box = $("#cal"); box.style.display = calFor ? "" : "none"; if (!calFor) return;
    const picked = $("#" + calFor).value, today = ymd(new Date()), min = ymd(earliest), y = calMonth.getFullYear(), m = calMonth.getMonth();
    let cells = "<span></span>".repeat(new Date(y, m, 1).getDay());
    for (let d = 1, n = new Date(y, m + 1, 0).getDate(); d <= n; d++) { const k = ymd(new Date(y, m, d));
      cells += `<button class="${k === picked ? "on" : ""} ${k === today ? "today" : ""}" data-day="${k}" ${k < min || k > today ? "disabled" : ""}>${d}</button>`; }   // only days the archive covers
    box.innerHTML = `<div class="calhead"><button data-nav="-1" aria-label="Earlier month" ${ymd(new Date(y, m, 1)) <= min ? "disabled" : ""}>◀</button><span>${MONTHS[m]} ${y}</span><button data-nav="1" aria-label="Later month" ${ymd(new Date(y, m + 1, 1)) > today ? "disabled" : ""}>▶</button></div>
      <div class="calgrid">${["S", "M", "T", "W", "T", "F", "S"].map(x => `<i>${x}</i>`).join("")}${cells}</div>`;
  }
  $$(".datebtn").forEach(b => b.onclick = e => {
    e.stopPropagation(); calFor = calFor === b.dataset.for ? null : b.dataset.for;
    if (calFor) { const d = fromYmd($("#" + calFor).value); calMonth = new Date(d.getFullYear(), d.getMonth(), 1); }
    drawCal();
  });
  $("#cal").addEventListener("click", e => {
    e.stopPropagation();   // the calendar redraws under the finger; do not let that read as a tap outside the menu
    const nav = e.target.closest("[data-nav]"), day = e.target.closest("[data-day]");
    if (nav && !nav.disabled) { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + Number(nav.dataset.nav), 1); return drawCal(); }
    if (!day || day.disabled) return;
    $("#" + calFor).value = day.dataset.day;
    if ($("#from").value > $("#to").value) $(calFor === "from" ? "#to" : "#from").value = day.dataset.day;   // a range never runs backwards
    days = null; keep(); calFor = null; drawCal(); renderList();
  });
  $$("#dates-menu .row[data-days]").forEach(r => r.onclick = () => {
    days = r.dataset.days === "all" ? null : Number(r.dataset.days); setWindow(); keep();
    calFor = null; drawCal(); closeMenus(); renderList();
  });
  function datesLabel() {
    const f = $("#from").value, t = $("#to").value, today = ymd(new Date());
    for (const b of $$(".datebtn")) b.textContent = fromYmd($("#" + b.dataset.for).value).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    const short = v => { const [y, m, d] = v.split("-"); return `${m}/${d}`; };
    let l = "All";
    if (f === today && t === today) l = "Today";
    else if (!(f === ymd(oldest) && t === today)) l = `${short(f)} – ${t === today ? "today" : short(t)}`;
    $("#dates-n").textContent = l;
  }
  $("#f-unread").onclick = e => { e.stopPropagation(); hideRead = !hideRead; keep(); renderList(); };


  // ---- list ----
  const cmp = { title: (a, b) => a.title.replace(/^[^\p{L}\p{N}]+/u, "").localeCompare(b.title.replace(/^[^\p{L}\p{N}]+/u, ""), undefined, { sensitivity: "base", numeric: true }), author: (a, b) => a.author.localeCompare(b.author), date: (a, b) => a.d - b.d, saved: (a, b) => (!!saved[a.id]) - (!!saved[b.id]) };
  function inRange(it) {
    const f = $("#from").value ? fromYmd($("#from").value) : null, t = $("#to").value ? fromYmd($("#to").value) : null;
    if (t) t.setHours(23, 59, 59, 999);
    return (!f || it.d >= f) && (!t || it.d <= t);
  }
  function visible() {
    // Saved is a place to find things again, so Topic, Place and Dates narrow it too. Sources does not: a saved story outlives its outlet being on the list.
    // A tag view is the feed you came from, narrowed to that tag: Dates, Sources, Unread, Saved and the other menu still apply. Only the
    // tag's own kind is set aside (a topic tag ignores the Topic ticks, a place tag the Place ticks, an outlet the Sources ticks).
    const k = tagView && tagView.kind;
    const v = tagView ? items.filter(i => inTag(i) && inRange(i) && (savedOnly ? (saved[i.id] || linger.has(i.id)) : (k === "pub" || enabled.has(i.pub)) && !(hideRead && read.has(i.id) && !linger.has(i.id))) && (k === "place" || inPlaces(placesOf(i))) && (k === "topic" || inTopics(topicsOf(i))) && inLangs(langOf(i))) : savedOnly ? items.filter(i => (saved[i.id] || linger.has(i.id)) && inRange(i) && inPlaces(placesOf(i)) && inTopics(topicsOf(i)) && inLangs(langOf(i))) : items.filter(i => enabled.has(i.pub) && inRange(i) && !(hideRead && read.has(i.id) && !linger.has(i.id)) && inPlaces(placesOf(i)) && inTopics(topicsOf(i)) && inLangs(langOf(i)));
    // The feed is chronological. The Date heading turns it round: newest first, or oldest first. The Story heading is only a heading.
    v.sort((a, b) => sortDesc ? b.d - a.d : a.d - b.d);
    if (mode === "pub") v.sort((a, b) => pubs.get(a.pub).name.localeCompare(pubs.get(b.pub).name));
    return v;
  }
  // ---- a day at a time ----
  // A list shows the last 24 hours of what matches, counted back from now, and its last row loads the 24 hours before that, and so on.
  // `all` is everything that matches (the counts, the chart and the tag bar read it); `rows` is what has been loaded: the stories newer than
  // `cutoff`. Empty days are skipped, so a list is never empty while something matches. The window goes back to the newest day when the view,
  // a filter or the dates change (`viewKey`), and stays put when a story is opened, saved or marked.
  const DAY = 864e5, at = it => +it.d || 0;
  let all = [], cutoff = null, dayNow = Date.now(), viewKey = "", more = null;
  const dayOf = it => Math.max(0, Math.floor((dayNow - at(it)) / DAY)), edge = k => dayNow - (k + 1) * DAY;
  const newestDay = list => list.reduce((k, i) => Math.min(k, dayOf(i)), Infinity);
  function loadMore() {
    if (!more) return false;
    const keys = document.activeElement?.closest?.("tr.more");   // pressed from the keyboard: focus stays on the row that takes its place
    cutoff = edge(more.k); renderList();
    if (keys) ($("#rows tr.more td") || $("#list")).focus();
    return true;
  }
  // ---- selecting in groups ----
  // `picked` holds the selected stories. A selected row shows a ticked box in the first column; a saved one a star; any other, nothing.
  const picked = new Set(); let anchor = null;
  const firstCell = id => picked.has(id) ? `<input type="checkbox" checked tabindex="-1" aria-label="Selected">` : saved[id] ? `<span role="img" aria-label="Saved">★</span>` : "";
  // (the rows are changed in place, not redrawn: a long press must leave the row under the finger where it is)
  function paintPicks() {
    for (const tr of $$("#rows tr[data-id]")) {
      const on = picked.has(tr.dataset.id); if (on === tr.classList.contains("pick")) continue;
      tr.classList.toggle("pick", on); on ? tr.setAttribute("aria-selected", "true") : tr.removeAttribute("aria-selected"); tr.firstElementChild.innerHTML = firstCell(tr.dataset.id);
    }
    $("#rows").classList.toggle("selecting", picked.size > 0);
    renderStatus();
  }
  function togglePick(id) { picked.has(id) ? picked.delete(id) : picked.add(id); anchor = id; paintPicks(); }
  $("#pick-all").onclick = () => { if (rows.length && picked.size === rows.length) picked.clear(); else for (const r of rows) picked.add(r.id); anchor = null; paintPicks(); };
  function renderList() {
    const key = JSON.stringify([tagView && [tagView.kind, tagView.value, tagView.key], savedOnly, hideRead, $("#from").value, $("#to").value, [...enabled].sort(), [...places], [...topics], [...langs]]);
    if (key !== viewKey) { viewKey = key; cutoff = null; dayNow = Date.now(); picked.clear(); anchor = null; linger.clear(); }
    all = visible();
    if (all.length && (cutoff === null || !all.some(i => at(i) > cutoff))) cutoff = edge(newestDay(cutoff === null ? all : all.filter(i => at(i) <= cutoff)));
    rows = all.filter(i => at(i) > cutoff);
    const older = all.filter(i => at(i) <= cutoff), k = newestDay(older);
    more = older.length ? { k, n: older.filter(i => dayOf(i) === k).length, next: edge(k - 1) === cutoff } : null;
    const listed = new Set(rows.map(r => r.id)); for (const id of [...picked]) if (!listed.has(id)) picked.delete(id);
    $("#tagbar").style.display = tagView ? "" : "none";
    if (tagView) { $("#tagbar .k").textContent = tagView.kind === "pub" ? "FROM" : "TAG"; $("#tag-name").textContent = `${tagView.value} · ${all.length} ${all.length === 1 ? "story" : "stories"}`; }   // the same number the status bar lists
    const out = []; let last = null;
    for (const it of rows) {
      if (mode === "pub" && it.pub !== last) { const p = pubs.get(it.pub); out.push(`<tr class="grp"><td colspan="3"><span class="sw" style="background:${p.color}"></span>${esc(p.name)} (${rows.filter(x => x.pub === it.pub).length})</td></tr>`); last = it.pub; }
      const pk = picked.has(it.id);
      out.push(`<tr data-id="${it.id}" style="--pc:${pubs.get(it.pub).color}" class="${sel === it.id ? "sel" : ""} ${read.has(it.id) ? "" : "unread"} ${isNew(it) ? "fresh" : ""} ${saved[it.id] ? "saved" : ""} ${pk ? "pick" : ""}"${pk ? ` aria-selected="true"` : ""}><td class="star" title="${saved[it.id] ? "Saved. Click to select" : "Select"}">${firstCell(it.id)}</td><td class="t ico" colspan="2" title="${esc(it.title)}"><span class="sv" role="button" aria-label="${saved[it.id] ? "Remove from saved" : "Save for later"}" title="${saved[it.id] ? "Remove from saved" : "Save for later"}">${saved[it.id] ? "★" : "☆"}</span><span class="hl">${esc(it.title)}</span><span class="sub"><span class="when">${fmt(it.d)}</span> · ${esc(pubs.get(it.pub).name)}${it.author ? " · " + esc(it.author) : ""}</span></td></tr>`);
    }
    // the last row: the next day that has stories, and how many a press brings
    if (more) out.push(`<tr class="more"><td colspan="3" tabindex="0" role="button">${more.next ? "Load the day before" : "Load earlier"} · ${more.n} ${more.n === 1 ? "story" : "stories"}</td></tr>`);
    if (!all.length) out.push(`<tr><td colspan="3" class="empty">${tagView ? "No stories with this tag." : savedOnly ? (Object.keys(saved).length ? "No saved stories match the current filter and dates." : "No saved stories yet. On a phone, swipe a story to the right. Or open one and press Save.") : hideRead ? "Nothing unread in this range. Turn off Unread only in Filter to see everything." : (items.length ? "No stories match the current sources, topic, place, language and date range." : "No stories yet. New feeds bring their first stories within half an hour.")}</td></tr>`);
    // the star's number is what its view will list: saved stories inside the dates and the Topic, Place and Language ticks (Saved sets Sources aside)
    const everSaved = Object.keys(saved).length, nSaved = items.filter(i => saved[i.id] && inRange(i) && inPlaces(placesOf(i)) && inTopics(topicsOf(i)) && inLangs(langOf(i))).length;
    $("#savedonly-n").textContent = String(nSaved); $("#t-saved").setAttribute("aria-label", `Saved stories only. ${nSaved === everSaved ? `${nSaved} saved` : `${nSaved} of ${everSaved} saved match the filter`}`);
    $("#t-saved").title = nSaved === everSaved ? "Show only saved stories" : `Show only saved stories: ${nSaved} of ${everSaved} match the filter`;
    datesLabel(); renderFacets(); renderSources();   // Sources is redrawn too: its counts and order follow the dates and the other filters
    $("#t-saved").classList.toggle("on", savedOnly); $("#t-saved").setAttribute("aria-pressed", savedOnly);
    $("#rows").innerHTML = out.join(""); $("#rows").classList.toggle("selecting", picked.size > 0);
    $$("thead th").forEach(th => { th.classList.toggle("sorted", !!th.dataset.k && th.dataset.k === sortKey); th.classList.toggle("desc", th.dataset.k === sortKey && sortDesc); });
    { const dt = $("#list thead th[data-k=date]"); dt.title = sortDesc ? "Newest first. Press for oldest first" : "Oldest first. Press for newest first"; dt.setAttribute("aria-label", "Date. " + dt.title); }
    // (a story opened from a conversation is on show whatever the feed's filters say: leave it be)
    if (sel && !all.some(r => r.id === sel) && !$(".window").classList.contains("gstory")) { sel = null; if (rows[0] && !isPhone() && !document.querySelector(".window").classList.contains("reading")) show(rows[0].id); else $("#article").innerHTML = `<div class="blank">Select a story</div>`; }
    renderStatus(); if (chartOpen()) drawChart();
  }
  function renderStatus() {
    // The count is about today, not the whole archive: a feed is a river, not an inbox, so there is no pile of unread to work down.
    // "Today" is what matches now (the feed with its filters, or a tag view) that was published on today's date. The counts are of
    // everything that matches, not only of the days loaded into the list.
    const day = ymd(new Date()), todays = all.filter(i => ymd(i.d) === day), done = todays.filter(i => read.has(i.id)).length;
    const pct = todays.length ? done / todays.length * 100 : 0;
    $("#read-bar").style.width = pct + "%"; $("#read-pct").textContent = pct.toFixed(0) + "%";
    const cur = items.find(i => i.id === sel);
    const line = (todays.length ? `Today · ${done} of ${todays.length} read` : "Nothing new today") + ` · ${all.length} listed`;
    // (`flash` is a refresh's answer, shown for a few seconds. In the one-cell status bar of the narrow layout it goes before the counts, never in place of them.)
    $("#s1").textContent = picked.size ? `${picked.size} selected` : isPhone() ? (flash ? `${flash} · ${line}` : line) : flash || (cur ? cur.title : "Ready");
    $("#s2").textContent = line;
    $("#s3").textContent = `${enabled.size} sources`;
    $("#s4").textContent = "Fetched " + fmt(new Date(data.generated));
    $("#source").disabled = !cur;
    $("#save").disabled = !cur;
    // the envelope: what it will do, in its mark (opened: mark read; sealed: mark unread) and in words
    const toRead = picked.size ? [...picked].some(id => !read.has(id)) : !cur || !read.has(cur.id), what = (toRead ? "Mark read" : "Mark unread") + (picked.size ? `: ${picked.size} selected` : "");
    $("#t-mark").disabled = !picked.size && !cur; $("#t-mark").classList.toggle("toread", toRead); $("#t-mark .w").textContent = toRead ? "Mark read" : "Mark unread"; $("#t-mark").title = what + " (U)"; $("#t-mark").setAttribute("aria-label", what);
    // the operator's Saved view: while the envelope is held it shows as Sync (see "sync" below); otherwise it is everyone's envelope
    $("#t-mark").classList.toggle("syncmode", holdSync); if (holdSync) $("#t-mark .w").textContent = "Sync"; if (syncBusy) $("#t-mark").disabled = true;
    $("#save").textContent = cur && saved[cur.id] ? "★ Saved" : "☆ Save"; $("#save").classList.toggle("on", !!(cur && saved[cur.id]));
    const i = rows.findIndex(x => x.id === sel); $("#prev").disabled = i <= 0; $("#next").disabled = i < 0 ? !rows.length : i >= rows.length - 1 && !more;
    const box = $("#pick-all-box"), allOn = !!rows.length && picked.size === rows.length;
    box.checked = allOn; box.indeterminate = !!picked.size && !allOn; $("#pick-all").disabled = !rows.length; $("#pick-all").setAttribute("aria-pressed", allOn);
    $("#pick-all").title = allOn ? "Clear the selection" : `Select every story listed (${rows.length})`; $("#pick-all").setAttribute("aria-label", $("#pick-all").title);
    syncActs();
  }

  // ---- article pane ----
  // A publisher's story arrives with its own site's layout baked in: fixed widths, floats, alignment classes, sizes in pixels. In the reader
  // those push pictures out of the column or off to one side. Everything that positions or sizes is taken off, so the reader's own rules
  // lay the story out: one column, pictures and captions on its left edge, nothing wider than it. Links open outside the reader.
  function tidy(html) {
    const t = document.createElement("template"); t.innerHTML = html;
    t.content.querySelectorAll("script, style, link, meta, form, input, button, select, textarea, object, embed, iframe, noscript").forEach(el => el.remove());
    for (const el of t.content.querySelectorAll("*")) {
      // srcset and sizes go too: they are written for the publisher's page widths, and here they make the browser pick a thumbnail
      for (const a of ["style", "class", "id", "width", "height", "align", "hspace", "vspace", "border", "bgcolor", "cellpadding", "cellspacing", "srcset", "sizes"]) el.removeAttribute(a);
      if (el.tagName === "A") { el.target = "_blank"; el.rel = "noopener noreferrer"; }
      if (el.tagName === "IMG") { el.loading = "lazy"; el.decoding = "async"; if (!el.getAttribute("src")) el.remove(); }
    }
    // an empty paragraph or a wrapper left with nothing in it only adds gaps
    t.content.querySelectorAll("p, div, figure, span").forEach(el => { if (!el.textContent.trim() && !el.querySelector("img, video, audio, picture")) el.remove(); });
    return t.innerHTML;
  }
  const hostName = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  // A story's tags, most useful first: the neighborhood (or borough), the main topic, then the rest. They sit under the byline, on one line; phones show the first three.
  // The topic and place labels under a headline are shown whole where they can be: if any is cut, the row's type steps down (to 8px) until none is.
  function fitTags() {
    const row = document.querySelector("#article .doc .tags"); if (!row) return; row.style.removeProperty("--tagfs");
    const chips = [...row.querySelectorAll(".tag")]; if (!chips.length || !row.offsetWidth) return;
    let fs = parseFloat(getComputedStyle(chips[0]).fontSize); const cut = () => chips.some(c => c.scrollWidth > c.clientWidth + 1);
    while (cut() && fs > 8) { fs -= .5; row.style.setProperty("--tagfs", fs + "px"); }
  }
  addEventListener("resize", () => fitTags()); document.addEventListener("reader:zoom", () => fitTags()); document.fonts?.ready.then(() => fitTags());
  function tagChips(it) {
    const pl = [...(it.places || [])].reverse().map(x => ["place", x.name]), tp = (it.topics || []).filter(x => x.name !== "Other").map(x => ["topic", x.name]);
    return [pl[0], tp[0], ...pl.slice(1), ...tp.slice(1)].filter(Boolean).map(([k, v]) => `<button class="tag ${tagView && tagView.value === v ? "on" : ""}" data-${k}="${esc(v)}" title="Show stories ${k === "place" ? "from or " : ""}about ${esc(v)}">${esc(v)}</button>`).join("");
  }
  // The pictographs of the story's own bar (phones): the same small pixel marks as the toolbar's, in ink.
  const pm = (d, cls = "") => `<svg class="pm ${cls}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${d}</svg>`;
  const STAR = "M7 1h2v2H7zM6 3h4v2H6zM1 5h14v1H1zM2 6h12v1H2zM3 7h10v1H3zM4 8h8v2H4zM3 10h10v1H3zM3 11h4v1H3zM9 11h4v1H9zM2 12h4v1H2zM10 12h4v1h-4zM2 13h2v1H2zM12 13h2v1h-2z";
  const MARK = {
    back: pm(`<path d="M2 7h1v2H2zM3 6h1v4H3zM4 5h1v6H4zM5 4h1v8H5zM6 3h1v10H6zM7 7h7v2H7z"/>`),
    prev: pm(`<path d="M4 7h1v2H4zM5 6h1v4H5zM6 5h1v6H6zM7 4h1v8H7zM8 3h2v10H8z"/>`), next: pm(`<path d="M11 7h1v2h-1zM10 6h1v4h-1zM9 5h1v6H9zM8 4h1v8H8zM6 3h2v10H6z"/>`),
    save: pm(`<path fill-rule="evenodd" d="${STAR}M7 3h2v2H7zM4 6h8v1H4zM5 7h6v1H5zM6 8h4v1H6z"/>`, "st-off") + pm(`<path d="${STAR}"/>`, "st-on"),
    unread: pm(`<path fill-rule="evenodd" d="M1 3h14v10H1zM2 4v8h12V4z"/><path d="M2 4h2v1H2zM3 5h2v1H3zM5 6h1v1H5zM6 7h1v1H6zM7 8h2v1H7zM9 7h1v1H9zM10 6h1v1h-1zM11 5h2v1h-2zM12 4h2v1h-2z"/>`, "env-shut")
      + pm(`<path fill-rule="evenodd" d="M1 7h14v8H1zM2 8v6h12V8z"/><path d="M2 6h1v1H2zM3 5h1v1H3zM4 4h1v1H4zM5 3h1v1H5zM6 2h1v1H6zM7 1h2v1H7zM9 2h1v1H9zM10 3h1v1h-1zM11 4h1v1h-1zM12 5h1v1h-1zM13 6h1v1h-1zM5 10h6v1H5zM5 12h4v1H5z"/>`, "env-open"),
    open: pm(`<path d="M5 1h6v1H5zM3 2h2v1H3zM11 2h2v1h-2zM2 3h1v2H2zM13 3h1v2h-1zM1 5h1v6H1zM14 5h1v6h-1zM2 11h1v2H2zM13 11h1v2h-1zM3 13h2v1H3zM11 13h2v1h-2zM5 14h6v1H5zM7 2h2v12H7zM2 7h12v2H2zM4 4h8v1H4zM4 11h8v1H4z"/>`),
    share: pm(`<path d="M3 3h4v4H3zM2 8h6v1H2zM1 9h8v6H1zM10 1h4v4h-4zM9 6h6v1H9zM8 7h8v1H8zM10 8h6v5h-6z"/>`),
  };
  const say = (b, words) => { b.title = words; b.setAttribute("aria-label", words); };
  // On phones the story's actions sit in the header's third row; they drive the toolbar's own buttons, so state and handlers stay in one place.
  function syncActs() {
    for (const b of $$("#article .h3 [data-act], #article .pinopen[data-act]")) {
      if (b.dataset.act === "unread") { const cur = items.find(i => i.id === sel), toRead = !!cur && !read.has(cur.id); b.disabled = !cur; b.classList.toggle("toread", toRead); say(b, toRead ? "Mark read" : "Mark unread"); continue; }   // the story's own bar marks the story, never a selection
      const o = $("#" + b.dataset.act); if (!o) continue;
      b.disabled = o.disabled;
      if (b.dataset.act === "save") { const on = o.classList.contains("on"); b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); say(b, on ? "Saved. Remove from saved" : "Save for later"); }
      if (b.dataset.act === "sendto") b.style.display = o.style.display === "none" ? "none" : "";
    }
  }
  $("#article").addEventListener("click", e => { const b = e.target.closest(".h3 [data-act], .pinopen[data-act]"); if (!b) return; if (b.dataset.act === "site") setSite(!$("#article").classList.contains("site")); else if (b.dataset.act === "unread") {
      // Marking a story unread from its own bar means "not now": it goes back to the list (or the conversation it was opened from), where the
      // story waits with its red dot. Marking it read leaves the reader where they are.
      const wasRead = read.has(sel); toggleRead(sel); if (wasRead && isPhone()) $("#back")?.click();
    } else $("#" + b.dataset.act).click(); });
  // `from`, when given, is where the story was opened from other than the list (a card in a conversation): { label, back } for its back button.
  // A story with no picture (its feed gave none and the fetch did not get to its page): ask the server to look on the story's page, once.
  // If it finds one, it goes above the text when the story is still showing, and a card shared from here carries it.
  function seekPicture(it) {
    if (!mine.cloud || it.image || it.archived || it.sought) return; it.sought = true;
    fetch(`/picture?pub=${encodeURIComponent(it.pub)}&id=${encodeURIComponent(it.id)}`).then(r => r.ok ? r.json() : null).then(j => {
      if (!j || !j.image) return; it.image = plainUrl(j.image);
      const tags = sel === it.id && $("#article .doc .tags"); if (!tags || $("#article .doc img.hero")) return;
      const img = document.createElement("img"); img.className = "hero"; img.alt = ""; img.src = it.image; tags.after(img);
    }).catch(() => {});
  }
  function show(id, scroll, opened, from) {
    const it = items.find(i => i.id === id); if (!it) return;
    sel = id; seekPicture(it);
    if (opened) document.querySelector(".window").classList.add("reading");
    const p = pubs.get(it.pub);
    const dup = it.image && (it.content || "").includes(it.image.split("?")[0]);
    $("#article").style.setProperty("--pc", p.color);
    $("#article").innerHTML = `
      <div class="top"><div class="hdr" style="--pc:${p.color}">
        <div class="h1"><button class="back slot" id="back" title="Back to ${esc(from ? from.label : tagView ? tagView.value : "the feed")}" aria-label="Back to ${esc(from ? from.label : tagView ? tagView.value : "the feed")}">${MARK.back}<span class="w">${esc(from ? from.label : tagView ? tagView.value : "Feed")}</span></button><span class="pubname">${esc(p.name)}</span><span class="when"><span class="lg">${fmtLong(it.d)}</span><span class="sm">${it.d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></span>
          ${p.embeddable ? `<button id="b-site">Site view</button>` : ""}<span class="mono">${kb(it.size)} · ${it.kind}${it.archived ? " · from saved copy" : ""}</span></div>
        <div class="h3"><button data-act="save" aria-label="Save for later" title="Save for later">${MARK.save}</button><button data-act="sendto" aria-label="Share with a friend" title="Share with a friend">${MARK.share}</button><button data-act="unread" aria-label="Mark unread" title="Mark unread">${MARK.unread}</button><button class="nav" data-act="prev" aria-label="Previous story" title="Previous story">${MARK.prev}</button><button class="nav" data-act="next" aria-label="Next story" title="Next story">${MARK.next}</button></div>
      </div><div class="pin" role="button" tabindex="0" aria-label="Back to the top of the story" title="Back to the top of the story"><div class="pl" aria-hidden="true"><span class="sw" style="background:${p.color}"></span>${esc(p.name)} · ${it.d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${it.author ? " · " + esc(it.author) : ""}</div><div class="ph" aria-hidden="true">${esc(it.title)}</div></div><button class="pinopen" data-act="${p.embeddable ? "site" : "source"}" aria-label="${p.embeddable ? "Open the outlet's page here" : "Open on the outlet's own site"}" title="${p.embeddable ? "Open the outlet's page here" : "Open on the outlet's own site"}">${MARK.open}</button></div>
      ${p.embeddable ? `<div class="frame"><iframe data-src="${esc(it.link)}" referrerpolicy="no-referrer-when-downgrade" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" title="${esc(p.name)}"></iframe></div>` : ""}
      <div class="doc">
        <div class="label"><span class="sw" style="background:${p.color}"></span><a class="outlet" tabindex="0" role="button" data-key="${esc(groupOf(p))}" title="Everything from ${esc(p.name)} on your list">${esc(p.name)}</a>${p.section && p.section !== p.name ? " · " + esc(p.section) : ""} · ${it.d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
        <h1>${esc(it.title)}</h1>
        ${it.author ? `<div class="by">By ${esc(it.author)}</div>` : ""}
        <div class="tags">${tagChips(it)}</div>
        ${it.image && !dup ? `<img class="hero" src="${esc(it.image)}" alt="">` : ""}
        ${it.content ? tidy(it.content) : `<p>${esc(it.summary)}</p>`}
        ${it.kind === "Excerpt" ? `<div class="excerpt">This feed provides an excerpt only. ${p.embeddable ? `<button id="x-site">Show the full story here</button>` : `Use <b>Open</b> to read it on its own site. ${esc(p.name)} does not allow its pages inside other sites, so it opens in a side window that stays signed in.`}</div>` : ""}
        <div class="src">Source: <a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.link)}</a></div>
        ${p.support?.url ? `<div class="support">Support ${esc(p.name)}: <a href="${esc(p.support.url)}" target="_blank" rel="noopener noreferrer">${esc(p.support.label)} ↗</a> <span class="to">goes to ${esc(hostName(p.support.url))}</span></div>`
          : p.support_checked ? `<div class="support none">Support ${esc(p.name)}: ${p.support_why === "blocked" ? "its site does not let the reader look for a way to pay it." : "the reader found no donation, membership or subscription link on its site."} <a href="${esc(new URL(p.home).origin)}" target="_blank" rel="noopener noreferrer">Visit ${esc(hostName(p.home))} ↗</a></div>` : ""}
        ${account ? `<div class="cats"><a class="report" tabindex="0" role="button" data-pub="${esc(it.pub)}" data-name="${esc(p.name + (p.section ? " · " + p.section : ""))}">Report this feed</a></div>` : ""}
        ${it.categories.length ? `<div class="cats">Filed under: ${it.categories.map(esc).join(", ")}</div>` : ""}
      </div>`;
    $("#article").scrollTop = 0;
    $("#article").classList.remove("site");
    $("#back").onclick = () => from ? from.back() : document.querySelector(".window").classList.remove("reading");
    const bs = $("#b-site"), xs = $("#x-site");
    if (bs) bs.onclick = () => setSite(!$("#article").classList.contains("site"));
    if (xs) xs.onclick = () => setSite(true);
    if (opened && !read.has(id)) { read.add(id); linger.add(id); saveRead(); push({ read: [id] }); }
    if (opened) armReading(it, p);
    // Only a story the reader chose to open is marked read (above). One the list merely landed on, because a filter, a refresh or a closed
    // panel took the open story away, is shown but stays unread, red dot and all: nobody is charged for a story they did not pick.
    $$("#rows tr").forEach(tr => { tr.classList.toggle("sel", tr.dataset.id === id); if (tr.dataset.id === id && read.has(id)) tr.classList.remove("unread"); });
    if (scroll) $(`#rows tr[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
    // the title bar always reads retronewsreader and nothing else: it never takes a headline or a panel's name
    renderStatus(); readProgress(); fitTags();
    document.dispatchEvent(new CustomEvent("reader:selected"));
  }
  // previous and next walk the loaded rows; stepping past the last of them loads the next day
  // ---- how far through the story (the one-screen layout's status bar) ----
  // The share of the story that has been scrolled past: 0% at its top, 100% at its end, and 100% at once for a story short enough to need
  // no scrolling. Measured, not stored, so it is right whatever the text size, line spacing or window. Not shown for an outlet's own page
  // (Site view), which the reader cannot measure.
  const art = $("#article"); let progT = 0;
  function readProgress() {
    const cell = $("#s-prog"), site = art.classList.contains("site"), room = art.scrollHeight - art.clientHeight;
    // The running head (phones): once the headline and byline have gone up under the bar, a slim strip under the bar says what is being
    // read. It lies over the story and takes no room of its own, so nothing moves when it comes and goes.
    const bar = art.querySelector(".hdr"), last = art.querySelector(".doc .by") || art.querySelector(".doc h1");
    art.classList.toggle("pinned", !site && !!bar && !!last && last.getBoundingClientRect().bottom < bar.getBoundingClientRect().bottom);
    cell.classList.toggle("off", site || !art.querySelector(".doc")); if (site) return;
    const pct = room <= 4 ? 100 : Math.max(0, Math.min(100, Math.round(art.scrollTop / room * 100)));
    if (room > 4 && pct >= 50) countReading();   // scrolled halfway through a story that needs scrolling: it is being read
    $("#prog-bar").style.width = pct + "%"; $("#prog-pct").textContent = pct + "%"; cell.setAttribute("aria-valuenow", pct);
  }
  const progSoon = () => { if (!progT) progT = setTimeout(() => { progT = 0; readProgress(); }, 60); };
  art.addEventListener("scroll", progSoon, { passive: true });
  // The running head is the way back up the story: a press scrolls to the top, where the whole header is (smoothly, unless the reader asked for less motion).
  art.addEventListener("click", e => {
    if (!e.target.closest(".pin") || !art.classList.contains("pinned")) return;
    art.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setTimeout(() => { if (art.scrollTop > 0) art.scrollTop = 0; progSoon(); }, 700);   // if the smooth scroll did not run, arrive anyway, and let the strip go
  });
  art.addEventListener("load", progSoon, true);   // a picture arriving makes the story taller
  addEventListener("resize", progSoon); document.addEventListener("reader:zoom", progSoon);
  function step(n) {
    const i = rows.findIndex(r => r.id === sel); let nx = rows[i + n] || (i < 0 && n > 0 ? rows[0] : null);
    if (!nx && n > 0 && i >= 0 && more) { const had = new Set(rows.map(r => r.id)); loadMore(); nx = rows.find(r => !had.has(r.id)); }
    if (nx) show(nx.id, true, true);
  }
  // A click on a row opens its story and ends any selecting. Cmd or Ctrl and a click adds or removes that row; Shift and a click selects the
  // run from the last one picked. On a phone, while selecting, a tap adds or removes the row instead of opening it (see the long press, below).
  let touchAt = 0, lpFired = false;
  $("#rows").addEventListener("click", e => {
    if (e.target.closest("tr.more")) return loadMore();
    const tr = e.target.closest("tr[data-id]"); if (!tr) return; const id = tr.dataset.id;
    if (lpFired) { lpFired = false; return; }   // the finger coming up after a long press is not a tap
    if (e.metaKey || e.ctrlKey) return togglePick(id);
    if (e.shiftKey) {
      const a = rows.findIndex(r => r.id === (anchor || sel)), b = rows.findIndex(r => r.id === id); if (a < 0) return togglePick(id);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) picked.add(rows[i].id); return paintPicks();
    }
    if (picked.size && Date.now() - touchAt < 1200) return togglePick(id);
    // With a mouse: the star at a row's right end saves or unsaves, and a click in the first column selects or unselects the row.
    // With a finger (which swipes to save and presses to select), a tap on a saved row's star unsaves.
    const mouse = Date.now() - touchAt > 1200 && matchMedia("(hover: hover) and (pointer: fine)").matches;   // a mouse at any window width
    if (e.target.closest(".sv")) return toggleSave(id);
    if (e.target.closest("td.star") && mouse) return togglePick(id);
    if (e.target.closest("td.star") && saved[id] && !picked.has(id)) return toggleSave(id);
    if (picked.size) { picked.clear(); anchor = null; paintPicks(); }
    show(id, false, true);
  });
  $("#rows").addEventListener("contextmenu", e => { if (Date.now() - touchAt < 1500) e.preventDefault(); });   // a long press is the reader's, not the phone's menu
  $("#save").onclick = () => sel && toggleSave(sel);
  // ---- sync (operator, Saved view) ----
  // A hidden gesture, so the envelope looks and works like everyone's (screenshots show nothing unusual): a tap marks read or unread as ever; held for 0.6 s it
  // turns into the Sync mark (let go now and nothing happens); held to 1.5 s it sends the selected stories (or the open one) whole to the operator's table
  // story_records, to be analysed later. A story sent again is refreshed, not doubled; the selection ends afterwards. Shift and click does it from the keyboard.
  // The server only takes it from the operator account. It is deliberately not in Help.
  let syncT1 = 0, syncT2 = 0, swallowClick = false;
  const clearHold = () => { clearTimeout(syncT1); clearTimeout(syncT2); if (holdSync) { holdSync = false; renderStatus(); } };
  const markBtn = $("#t-mark");
  markBtn.addEventListener("pointerdown", e => {
    if (!syncOn() || syncBusy || e.button > 0 || markBtn.disabled) return; swallowClick = false;
    syncT1 = setTimeout(() => { holdSync = true; swallowClick = true; navigator.vibrate?.(15); renderStatus(); }, 600);
    syncT2 = setTimeout(() => { clearHold(); navigator.vibrate?.([20, 40, 20]); syncNow(); }, 1500);
  });
  for (const t of ["pointerup", "pointercancel", "pointerleave"]) markBtn.addEventListener(t, clearHold);
  markBtn.addEventListener("contextmenu", e => { if (syncOn()) e.preventDefault(); });   // a long press must not open the browser's own menu
  markBtn.onclick = e => { if (swallowClick) { swallowClick = false; return; } if (e.shiftKey && syncOn()) return syncNow(); markNow(); };
  const tell = msg => { flash = msg; renderStatus(); clearTimeout(flashT); flashT = setTimeout(() => { flash = ""; renderStatus(); }, 6000); };
  async function syncNow() {
    if (syncBusy) return; const ids = picked.size ? [...picked] : sel ? [sel] : []; if (!ids.length) return;
    const pubOf = new Map(data.publications.map(p => [p.id, p]));
    const stories = ids.map(id => items.find(i => i.id === id)).filter(Boolean).map(it => { const p = pubOf.get(it.pub) || {};
      return { id: it.id, pub: it.pub, outlet: p.name || it.pub, section: p.section || "", title: it.title, link: it.link, author: it.author, date: it.date, first_seen: it.first_seen, saved_at: saved[it.id]?.saved_at || null,
        lang: langOf(it), summary: it.summary, content: it.content, image: it.image, categories: it.categories, topics: it.topics, places: it.places, also: it.also }; });
    syncBusy = true; renderStatus(); let added = 0, updated = 0;
    try {
      for (let i = 0; i < stories.length; i += 10) {
        const r = await fetch("/api/op/records", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stories: stories.slice(i, i + 10) }) });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        added += j.added; updated += j.updated;
      }
      picked.clear(); anchor = null; syncBusy = false; renderList(); tell(`Synced ${stories.length} ${stories.length === 1 ? "story" : "stories"} (${added} new${updated ? `, ${updated} updated` : ""})`);
    } catch (e) { syncBusy = false; renderStatus(); tell(`Could not sync: ${e.message}`); }
  }
  // Refresh (wide screens; a phone pulls the list down): bring in the latest stories, in place
  $("#t-refresh").onclick = async () => { $("#s1").textContent = "Checking for new stories…"; $("#t-refresh").disabled = true; const n = await pullLatest(); $("#t-refresh").disabled = false; said(n); if (n > 0) $("#list").scrollTop = 0; };
  $("#t-saved").onclick = () => { savedOnly = !savedOnly; renderList(); $("#list").scrollTop = 0; };
  $("thead").addEventListener("click", e => { const th = e.target.closest("th"); if (!th || !th.dataset.k) return; sortDesc = !sortDesc; renderList(); });
  $("#prev").onclick = () => step(-1); $("#next").onclick = () => step(1);
  $("#source").onclick = () => { const it = items.find(i => i.id === sel); if (it) companion(it.link); };
  // a write to the reader's own server (/refresh, /publications, /probe): JSON out, JSON back, with the machine token where this browser keeps one
  const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body || {}) }).then(r => r.json());
  async function refreshFeeds() {
    $("#s1").textContent = "Fetching feeds…";
    try {
      const r = await post("/refresh");
      if (!r.ok) throw new Error(r.error || "fetch.py failed");
      $("#s1").textContent = `Done in ${r.seconds}s · ${r.added ?? "?"} new stories`;
      try { sessionStorage.setItem("rolodex.sel", sel || ""); } catch {}
      setTimeout(() => location.reload(), r.added ? 600 : 1200);
    } catch (e) {
      $("#s1").textContent = "Refresh failed: " + e.message;
    }
  }
  // Fetching happens every 30 minutes on its own. File → Fetch feeds now runs one there and then: a row only the operator sees on the web,
  // and the Mac, which is its owner's own machine. Readers have no such row; the list reloads itself, or by a pull on a phone.
  // What it fetched is then brought into the list in place: nothing else on screen is redrawn.
  const fetchNow = $("#m-fetch").onclick = async () => {
    closeMenus(); $("#s1").textContent = "Fetching feeds…";
    const r = await (mine.cloud ? fetch("/api/op/refresh", { method: "POST" }).then(x => x.json()) : post("/refresh")).catch(() => ({ ok: false, error: "could not reach the server" }));
    if (!r.ok) { $("#s1").textContent = "Refresh failed: " + (r.error || "unknown"); return -1; }
    const n = await pullLatest(); $("#s1").textContent = `Fetched in ${r.seconds}s · ${n > 0 ? n : "no"} new ${n === 1 ? "story" : "stories"}`; return n;
  };
  // ---- refreshing in place ----
  // A refresh (a pull on a phone, the Refresh button on a wide screen, the "new stories" line, coming back to an idle reader) does not reload
  // the page: it asks for the archive again, adds the stories this list does not have yet, and redraws the list alone. The bars, the menus
  // and an open story stay exactly as they are. New rows carry the tint for "new since you were last here". Returns how many were added
  // (-1 if the server could not be reached).
  const known = new Set(items.map(i => i.id)); let seenFetch = Math.floor(new Date(data.generated).getTime() / 1000) || 0;
  // what a refresh found, said in the status bar for a few seconds; the story counts stay in view beside it
  let flash = "", flashT = 0;
  const said = n => { flash = n < 0 ? "Could not reach the server" : n ? `${n} new ${n === 1 ? "story" : "stories"}` : "Up to date";
    renderStatus(); clearTimeout(flashT); flashT = setTimeout(() => { flash = ""; renderStatus(); }, 5000); };
  // A refresh does not reload the page, so an open reader would otherwise keep running the code it started with for as long as its tab
  // lives, and miss whatever was published since. Each refresh therefore asks, cheaply (three header-only requests), whether the page or
  // its scripts have changed on the server. If they have, this one refresh is a full reload, back to the story that was open.
  const codeTag = () => Promise.all(["/", "/app.js", "/chat.js"].map(u => fetch(u, { method: "HEAD", cache: "no-store" }).then(r => r.ok ? r.headers.get("etag") || r.headers.get("last-modified") || "" : "")))
    .then(t => t.every(Boolean) ? t.join("|") : "").catch(() => "");
  let codeAtLoad = ""; codeTag().then(t => { codeAtLoad = t; });
  async function pullLatest(fresh) {
    const code = await codeTag();
    if (code && codeAtLoad && code !== codeAtLoad) { try { sessionStorage.setItem("rolodex.sel", sel || ""); } catch {} $("#s1").textContent = "The reader has been updated. Loading the new version…"; location.reload(); return 0; }
    // Signed on, saved and read stories belong to the account: a refresh reads them back too, so a story saved or read on another device
    // shows here without closing the reader. (It first lets this device's own last changes reach the server, so they are not undone.)
    const state = account ? pushing.then(() => fetch("/api/state", { cache: "no-store" })).then(r => r.ok ? r.json() : null).catch(() => null) : null;
    fresh = fresh || await fetch("data.json", { cache: "no-store" }).then(r => r.json()).catch(() => null); if (!fresh || !Array.isArray(fresh.items)) return -1;
    const keep = new Set(data.publications.map(p => p.id)), byId = new Map(items.map(i => [i.id, i])); let n = 0;
    let changed = 0;
    for (const raw of fresh.items) {
      // A story already in the list may have gained its tags (or a picture) since it arrived: the fetch stores a story first and Jev tags
      // it a run or two later. Take those in, so its row files under the right Topic and Place and its tag buttons appear without a reload.
      if (known.has(raw.id)) {
        const it = Array.isArray(raw.topics) && byId.get(raw.id);
        if (it && !it.archived && JSON.stringify([it.topics, it.places]) !== JSON.stringify([raw.topics, raw.places])) {
          it.topics = raw.topics.map(t => ({ ...t, name: REN[t.name] || t.name })); it.places = raw.places || []; placeCache.delete(it.id); changed++;
          if (sel === it.id && $("#article .doc .tags")) { $("#article .doc .tags").innerHTML = tagChips(it); fitTags(); }
        }
        if (it && !it.image && raw.image) it.image = plainUrl(raw.image);
        continue;
      }
      const i = { ...raw }; if (!keep.has(i.pub)) { const other = (i.also || []).find(x => keep.has(x)); if (!other) continue; i.pub = other; }
      known.add(i.id); mend(i); for (const t of i.topics || []) if (REN[t.name]) t.name = REN[t.name];
      const it = { ...i, d: new Date(i.date), size: new Blob([i.content || i.summary]).size, kind: (i.content || "").length > 1500 ? "Full text" : "Excerpt" };
      const g = guessLang(it); langCache.set(it.id, g.sure ? g.lang : pubLang.get(it.pub) || g.lang || "English");
      items.push(it); n++; shownMax = Math.max(shownMax, seenAt(it));
    }
    if (n) try { localStorage.setItem("rolodex.seen", String(shownMax)); } catch {}   // a later sitting, or a fresh start, begins after these
    const st = await state;
    if (st && st.saved && Array.isArray(st.read)) {
      saved = st.saved; read = new Set(st.read); saveRead(); persistSaved();
      // a story saved elsewhere that has left the archive comes back from its saved copy, as it does when the reader opens
      for (const [id, snap] of Object.entries(saved)) if (!known.has(id)) { const { saved_at, ...it } = snap; mend(it); known.add(id);
        const item = { ...it, d: new Date(it.date), size: new Blob([it.content || it.summary]).size, kind: (it.content || "").length > 1500 ? "Full text" : "Excerpt", archived: true };
        const g = guessLang(item); langCache.set(id, g.sure ? g.lang : pubLang.get(item.pub) || g.lang || "English"); items.push(item); }
    }
    if (fresh.generated) { data.generated = fresh.generated; seenFetch = Math.max(seenFetch, Math.floor(new Date(fresh.generated).getTime() / 1000) || 0); }
    // a reader left open past midnight: "to today" moves to the new day, or today's stories would fall outside the range
    const today = ymd(new Date()); if ($("#to").max !== today) { const was = $("#to").value === $("#to").max; $("#to").max = today; if (was) $("#to").value = today; }
    $("#fresh").style.display = "none";
    linger.clear();   // a refresh is when stories read under Unread only leave the list
    renderList();   // (it redraws Sources too; `changed` stories now sit under their new tags)
    return n;
  }
  const modal = () => $("#pubshade").classList.contains("on") || $("#readshade").classList.contains("on") || $("#volshade").classList.contains("on") || $("#invshade").classList.contains("on");   // a window is open over the reader
  // ---- keyboard reach ----
  // Everything a mouse or a finger can do, the keyboard can too. The menu bar's words and every menu row take focus and answer Enter
  // or Space; inside an open menu the arrow keys move; Escape closes it and puts focus back where it came from. The story list is one
  // stop on the Tab key (not one per story): once on it, the arrow keys or J and K move through it and Enter opens the story.
  const KEYABLE = ".menu .row.act, .menu .row[id]:not(.k), .menu .row[data-days], .menu .row[data-st], .menu .row[data-emoji]";
  $$(KEYABLE).forEach(el => { el.tabIndex = 0; el.setAttribute("role", "menuitem"); });
  $$(".menubar > span.dd:not(.ic), #menu-signon").forEach(el => { el.tabIndex = 0; el.setAttribute("role", "button"); if (el.classList.contains("dd")) el.setAttribute("aria-haspopup", "true"); });
  $$("#list thead th[data-k], #th-top").forEach(th => { th.tabIndex = 0; th.setAttribute("role", "button"); });
  // the Story heading is the way back up: a press scrolls the list to its first row (smoothly, unless the reader asked for less motion)
  $("#th-top").onclick = () => { const l = $("#list"); l.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setTimeout(() => { if (l.scrollTop > 0) l.scrollTop = 0; }, 700); };   // if the smooth scroll did not run (it does not in a page that is not showing), arrive anyway
  $("#list").tabIndex = 0; $("#list").setAttribute("aria-label", "Stories. The arrow keys, or J and K, move through them. Enter opens one. Space selects it.");
  document.addEventListener("keydown", e => {
    const t = e.target; if (!t.matches) return;
    if (e.key === "Escape") { const d = dds.find(d => d.menu.classList.contains("on")); if (d) { const back = d.btn || d.dd; setTimeout(() => back.focus(), 0); } return; }
    if ((e.key === "Enter" || e.key === " ") && t.matches('[role="button"][tabindex], [role="menuitem"]')) {
      e.preventDefault(); t.click();
      if (t.matches(".menubar > span.dd")) t.querySelector('.menu.on [role="menuitem"], .menu.on input, .menu.on button')?.focus();   // opened by keyboard: step into it
      return;
    }
    if (e.key === "Enter" && t.id === "list" && sel) return show(sel, true, true);
    if (e.key === " " && t.id === "list") { e.preventDefault(); if (sel && rows.some(r => r.id === sel)) togglePick(sel); return; }   // Space selects the story the list is on
    const menu = t.closest(".menu.on");
    if (menu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const stops = [...menu.querySelectorAll('[role="menuitem"], button, input')].filter(x => x.offsetParent !== null && !x.disabled), i = stops.indexOf(t);
      e.preventDefault(); (stops[(i + (e.key === "ArrowDown" ? 1 : stops.length - 1)) % stops.length] || stops[0])?.focus();
    }
  });
  window.addEventListener("keydown", e => {
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || modal() && e.key !== "Escape") return;
    if (e.key !== "Escape" && e.target.closest && e.target.closest(".menu")) return;   // keys pressed inside a menu belong to the menu
    // in the Gossip Column the story list is out of view: no stepping through it, and S and U only on a story opened from a card
    const gossip = $(".window").classList.contains("gossip"), story = !gossip || $(".window").classList.contains("gstory");
    if (!gossip && (e.key === "ArrowDown" || e.key === "j")) { e.preventDefault(); step(1); }
    if (!gossip && (e.key === "ArrowUp" || e.key === "k")) { e.preventDefault(); step(-1); }
    if (e.key === "Escape") { closeMenus(); $("#pubshade").classList.remove("on"); $("#volshade").classList.remove("on"); $("#readshade").classList.remove("on"); $("#invshade").classList.remove("on"); }
    if (e.key === "s" && sel && story) toggleSave(sel);
    if (e.key === "u" && story && !gossip && picked.size) markNow(); else if (e.key === "u" && sel && story) toggleRead(sel);
  });

  // ---- swipes (phones) ----
  // The screens sit side by side in the mind: the Gossip Column to the right of the feed, a story or a conversation to the right of its list.
  // A swipe from left to right goes back, and it does so by pressing whichever back button is on screen, so the two can never disagree.
  // The one exception: started on a story's row in the list, it saves that story (or unsaves a saved one). The row follows the finger a short
  // way, showing the star behind it, and settles. So in a tag's list the way back by swipe is from the bar above it, or from the story.
  // A press held still on a row for half a second selects it instead (selecting in groups, above).
  // A swipe from right to left goes forward: from the feed (or a tag's list) to the Gossip Column, from the friends to the open conversation.
  // Not counted: a touch that starts in a text field or in something that itself scrolls sideways (a wide table in a story), a slow drag,
  // a mostly vertical one, or anything while a menu, question or window is open.
  let sw = null;
  const sideways = el => { for (; el && el !== document.body; el = el.parentElement) { if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) return true; if (el.scrollWidth > el.clientWidth + 4 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true; } return false; };
  const busy = () => $("#sheet-shade").classList.contains("on") || modal() || document.querySelector(".ask, .wel, .aim");
  // ---- new stories while the reader is open ----
  // Opening the reader always shows the latest. Left open, the list used to stay as it was until someone asked. Now the reader asks for them:
  // every five minutes while it is showing, and whenever it is come back to, it checks (one small request) whether the server has fetched
  // since. If it has, it counts the stories this list does not have yet. Come back to with nothing in hand (the feed, at its top), it simply
  // adds them to the list, in place. Otherwise it says how many are waiting, in a line above the list, and a tap shows them: a story being read, a
  // conversation, or a place half way down the list is never pulled away.
  { let awaySince = 0;
    const fetchedAt = () => fetch("/status", { cache: "no-store" }).then(r => r.json()).then(s => Math.floor(s.data_mtime || 0)).catch(() => 0);
    async function freshen(back) {
      const t = await fetchedAt(); if (!t || t <= seenFetch) return;
      const fresh = await fetch("data.json", { cache: "no-store" }).then(r => r.json()).catch(() => null); if (!fresh) return;
      seenFetch = t;
      const keep = new Set(data.publications.map(p => p.id)), n = fresh.items.filter(i => !known.has(i.id) && (keep.has(i.pub) || (i.also || []).some(x => keep.has(x)))).length;
      if (!n) return;
      const W = $(".window").classList, idle = !W.contains("reading") && !W.contains("gossip") && !W.contains("tagview") && !busy() && $("#list").scrollTop < 40 && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
      if (back && idle) return pullLatest(fresh);
      $("#fresh-go").textContent = `${n} new ${n === 1 ? "story" : "stories"} · Show ${n === 1 ? "it" : "them"}`; $("#fresh").style.display = "";
    }
    $("#fresh-go").onclick = async () => { said(await pullLatest()); $("#list").scrollTop = 0; };
    setInterval(() => { if (!document.hidden) freshen(false); }, 5 * 60e3);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { awaySince = Date.now(); return; }
      const away = awaySince ? Date.now() - awaySince : 0;
      here();   // back after five idle minutes or more: first clear the old tints, then look for what is new
      if (away > 60e3) freshen(true);
    });
    window.reader_freshen = freshen;   // (for checking by hand)
  }

  // ---- pull to refresh (phones) ----
  // Drag the story list down from its very top and a gap opens above it, holding a progress bar that fills with the pull. Let go past the mark
  // and it refreshes, in place: the new stories join the list; for the operator, after a fetch when the feeds are stale. Let go short of it and it closes.
  // Only the story list does this, only from its top, and only for a drag that is clearly downward, so it never fights scrolling or a swipe.
  { const pane = $("#list"), gap = $("#pull"), MARK = 64, FULL = 104; let from = null, h = 0, busyNow = false;
    const draw = px => { h = px; gap.style.height = px + "px"; $("#pull-bar").style.width = Math.min(100, px / MARK * 100) + "%"; const ready = px >= MARK; gap.classList.toggle("armed", ready); $("#pull-t").textContent = ready ? "Let go to refresh" : "Pull to refresh"; };
    pane.addEventListener("touchstart", e => { from = !busyNow && e.touches.length === 1 && isPhone() && pane.scrollTop <= 0 && !$(".window").classList.contains("gossip") && !busy() ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; gap.classList.remove("ease"); }, { passive: true });
    pane.addEventListener("touchmove", e => {
      if (!from) return; const dx = e.touches[0].clientX - from.x, dy = e.touches[0].clientY - from.y;
      if (!h && (dy < 8 || Math.abs(dx) > dy)) { if (dy < -4 || Math.abs(dx) > 24) from = null; return; }   // not a pull: leave it to scrolling or to the swipe
      draw(Math.max(0, Math.min(FULL, dy * 0.5)));   // the gap opens at half the finger's speed, like something with weight
    }, { passive: true });
    const done = () => {
      if (!from) return; from = null; gap.classList.add("ease"); sw = null;   // a pull is never also a swipe
      if (h < MARK) return draw(0);
      // For the operator (and on the Mac) File → Fetch feeds now fetches every outlet there and then, which takes several seconds. A pull only does that when the
      // feeds are stale: fetched within the last five minutes, it is a plain reload, as it always is for a reader.
      const fetches = (operator || !mine.cloud) && Date.now() - new Date(data.generated).getTime() > 5 * 60e3;
      busyNow = true; gap.style.height = "58px"; gap.classList.add("go"); $("#pull-t").textContent = fetches ? "Fetching the feeds…" : "Refreshing…";
      // only the list changes: the new stories are added in place and the gap closes. No page reload, so nothing else on screen is redrawn.
      const close = () => { if (!busyNow) return; busyNow = false; gap.classList.remove("go"); gap.classList.add("ease"); draw(0); };
      setTimeout(async () => { const n = fetches ? await fetchNow() : await pullLatest(); if (!fetches) said(n); close(); }, 450);   // long enough to see that it took
      setTimeout(close, 20000);   // if nothing came of it, close up
    };
    pane.addEventListener("touchend", done, { passive: true }); pane.addEventListener("touchcancel", () => { from = null; gap.classList.add("ease"); draw(0); }, { passive: true }); }

  let lp = 0, drag = null; const under = $("#swipe-under");
  const settleRow = then => {
    if (!drag) return; const tr = drag; drag = null; tr.classList.add("settle"); tr.style.setProperty("--sx", "0px");
    setTimeout(() => { tr.classList.remove("swiping", "settle"); tr.style.removeProperty("--sx"); under.classList.remove("on", "armed"); if (then) then(); }, 170);
  };
  const touchDown = e => {
    touchAt = Date.now(); lpFired = false; clearTimeout(lp);
    const row = !$(".window").classList.contains("gossip") && e.target.closest("#rows tr[data-id]");
    sw = e.touches.length === 1 && isPhone() && !busy() && !sideways(e.target) ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), row } : null;
    if (sw && row) lp = setTimeout(() => { if (!sw || drag) return; sw = null; lpFired = true; togglePick(row.dataset.id); }, 500);
  };
  const touchMove = e => {
    if (!sw) return; const dx = e.touches[0].clientX - sw.x, dy = e.touches[0].clientY - sw.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(lp);   // a finger that moves is not pressing and holding
    if (!sw.row) return;
    if (!drag) {
      if (dx < 14 || dx < 2.2 * Math.abs(dy)) return;
      drag = sw.row; drag.classList.add("swiping");
      // the star sits where the row was: placed by the row's own offsets in the list, which scale with the page
      under.style.top = drag.offsetParent.offsetTop + drag.offsetTop + "px"; under.style.height = drag.offsetHeight + "px";
      const on = !!saved[drag.dataset.id]; under.firstElementChild.textContent = on ? "☆" : "★"; under.lastElementChild.textContent = on ? "Remove from saved" : "Save"; under.classList.add("on");
    }
    drag.style.setProperty("--sx", Math.max(0, Math.min(96, dx * .7)) + "px"); under.classList.toggle("armed", dx >= 70);
  };
  const touchUp = e => {
    clearTimeout(lp);
    if (!sw || e.touches.length) return settleRow(); const t = e.changedTouches[0], dx = t.clientX - sw.x, dy = t.clientY - sw.y, quick = Date.now() - sw.t < 700, row = sw.row; sw = null;
    if (drag) return settleRow(dx >= 70 ? () => toggleSave(row.dataset.id) : null);   // a dragged row saves on a full pull, however slow
    if (!quick || Math.abs(dx) < 70 || Math.abs(dx) < 2.2 * Math.abs(dy)) return;
    if (dx > 0 && row) return toggleSave(row.dataset.id);
    const W = $(".window").classList, press = sel => { const b = $(sel); if (b && b.offsetParent !== null) b.click(); };
    if (dx > 0) press(W.contains("reading") ? "#back" : W.contains("gossip") ? (W.contains("talking") ? "#cv-back" : "#gossip-back") : W.contains("tagview") ? "#tag-back" : "#none");
    else if (W.contains("gossip")) press(!W.contains("talking") ? "#g-rows tr.sel" : "#none");
    else if (!W.contains("reading")) document.dispatchEvent(new CustomEvent("reader:gossip"));   // chat.js opens the Gossip Column, signed on
  };
  // the list, the story and the conversation, and the bar above a tag's list (where the back swipe starts now that its rows save)
  for (const el of [$(".main"), $("#tagbar")]) {
    el.addEventListener("touchstart", touchDown, { passive: true }); el.addEventListener("touchmove", touchMove, { passive: true });
    el.addEventListener("touchend", touchUp, { passive: true }); el.addEventListener("touchcancel", () => { clearTimeout(lp); sw = null; settleRow(); }, { passive: true });
  }

  // ---- manage publications ----
  let draft = [], manageComplete = false;
  const PALETTE = ["#1a1a1a", "#8e2f2b", "#a8862a", "#3d6b4f", "#34507a", "#6a6762", "#b5542c", "#6a4a78", "#2f6468", "#86623a", "#4f7a2f", "#7a3f5a", "#3f6f7a", "#5c5a8a"];
  const inkFor = hex => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1c1c1c" : "#ffffff"; };
  const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "pub" + Date.now();
  let catalog = null;
  async function renderCatalog() {
    if (!catalog) { try { catalog = (await fetch("/catalog.json", { cache: "no-store" }).then(r => r.json())).publications; } catch { catalog = []; } }
    const have = new Set(draft.map(p => p.id)), haveFeeds = new Set(draft.map(p => p.feed));
    const groups = ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island", "Citywide"];
    $("#cat-list").innerHTML = groups.map(g => {
      const rows = catalog.filter(c => c.borough === g); if (!rows.length) return "";
      return `<div class="grp">${g}</div>` + rows.map(c => { const got = have.has(c.id) || haveFeeds.has(c.feed);
        return `<label class="${got ? "have" : ""}" title="${esc(c.note || "")}"><input type="checkbox" data-cid="${c.id}" ${got ? "checked disabled" : ""}><span class="sw" style="background:${c.color}"></span>${esc(c.name)} <span class="hd">${esc([...c.neighborhoods, c.kind === "newsletter" ? "newsletter" : ""].filter(Boolean).join(" · "))}</span></label>`; }).join("");
    }).join("");
    $("#cat-count").textContent = `${catalog.length} in the catalog, ${draft.length} in your list`;
  }
  $("#cat-add").onclick = () => {
    const picked = [...document.querySelectorAll("#cat-list input:checked:not(:disabled)")].map(i => catalog.find(c => c.id === i.dataset.cid));
    if (!picked.length) { $("#cat-msg").textContent = "Tick at least one first."; return; }
    for (const c of picked) { const { borough, neighborhoods, kind, note, ...pub } = c; let id = pub.id; while (draft.some(p => p.id === id)) id += "2"; draft.push({ ...pub, id }); }
    $("#cat-msg").textContent = `Added ${picked.length}. Press Save and refresh to fetch them.`; renderDraft(); renderCatalog();
  };
  async function openManage() {
    closeMenus();
    const cfg = await fetch("/publications", { cache: "no-store", headers: token ? { Authorization: "Bearer " + token } : {} }).then(r => r.json()).catch(() => null);
    if (!cfg) { $("#s1").textContent = "Could not load the publication list."; return; }
    manageComplete = cfg.complete === true;   // on the web, only the operator's token sees feeds that readers added
    draft = cfg.publications.map(p => ({ ...p }));
    renderDraft(); renderCatalog(); $("#probe-url").value = ""; $("#probe-msg").textContent = ""; $("#found").classList.remove("on");
    $("#pubshade").classList.add("on"); $("#probe-url").focus();
  }
  // A feed can answer every fetch and still be dead: the outlet stopped filling it, or moved it. A feed whose newest story is older than
  // QUIET days says "quiet since" and the date, in red, so a reader sees it in their own list. Read from stories already in the page: no
  // request, nothing stored. (The operator sees the same for every feed in File → Stories by publisher.)
  const QUIET = 14;
  function quietSince(id) {
    let t = 0; for (const i of items) if ((i.pub === id || (i.also || []).includes(id)) && +i.d > t) t = +i.d;
    return t && Date.now() - t >= QUIET * DAY ? new Date(t) : null;
  }
  function renderDraft() {
    $("#pub-rows").innerHTML = draft.map((p, i) => {
      const live = pubsMap.get(p.id), q = live && live.status === "ok" && quietSince(p.id);
      const st = q ? `quiet since ${q.toLocaleDateString([], { month: "short", day: "numeric" })}` : live ? live.status : "new", n = live ? live.count : 0;
      return `<tr data-i="${i}"><td><input type="color" value="${p.color}" data-k="color"></td><td><input type="text" value="${esc(p.name)}" data-k="name" style="width:170px"></td><td><input type="text" value="${esc(p.short)}" data-k="short" maxlength="10" style="width:80px"></td><td><input type="text" value="${esc((p.tags || []).join(", "))}" data-k="tags" placeholder="NYC, Politics" style="width:150px" title="Comma-separated. Place tags set the outlet's coverage area: NYC, a borough, a neighborhood, or National."></td><td class="feed" title="${esc(p.feed)}">${esc(p.feed)}</td><td class="st ${st === "ok" || st === "new" ? "" : "bad"}">${st === "ok" ? n + " stories" : st === "new" ? "not fetched yet" : st}</td><td><button class="sm" data-rm>Remove</button></td></tr>`;
    }).join("") || `<tr><td colspan="7" class="empty">No publications. Add one below.</td></tr>`;
  }
  $("#pub-rows").addEventListener("input", e => { const tr = e.target.closest("tr"), k = e.target.dataset.k; if (!tr || !k) return; const p = draft[+tr.dataset.i]; if (k === "tags") p.tags = e.target.value.split(",").map(t => t.trim()).filter(Boolean); else p[k] = e.target.value; if (k === "color") p.ink = inkFor(p.color); });
  $("#pub-rows").addEventListener("click", e => { if (!e.target.hasAttribute("data-rm")) return; const tr = e.target.closest("tr"); draft.splice(+tr.dataset.i, 1); renderDraft(); });
  let found = null;
  async function probeFeed() {
    const url = $("#probe-url").value.trim(); if (!url) return;
    $("#probe-msg").className = "msg"; $("#probe-msg").textContent = "Looking for a feed…"; $("#found").classList.remove("on"); $("#probe-go").disabled = true;
    try {
      const r = await post("/probe", { url });
      if (r.error) { $("#probe-msg").className = "msg bad"; $("#probe-msg").textContent = r.error + (r.tried ? " · tried " + r.tried.map(t => t.replace(/^https?:\/\/[^/]+/, "")).join(", ") : ""); return; }
      found = r;
      $("#probe-msg").textContent = `Found a feed with ${r.items} stories.`;
      $("#f-name").value = r.title || ""; $("#f-short").value = ((r.title || "").split(/\s+/).find(w => !/^(the|a|an|of|new)$/i.test(w)) || "").toUpperCase().replace(/[^A-Z0-9&]/g, "").slice(0, 10);
      $("#f-color").value = PALETTE[draft.length % PALETTE.length]; $("#f-feed").textContent = r.feed;
      $("#found").classList.add("on"); $("#f-name").focus();
    } catch (e) { $("#probe-msg").className = "msg bad"; $("#probe-msg").textContent = "Could not look it up: " + e.message; }
    finally { $("#probe-go").disabled = false; }
  }
  $("#probe-go").onclick = probeFeed;
  $("#probe-url").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); probeFeed(); } });
  $("#f-add").onclick = () => {
    if (!found) return;
    const name = $("#f-name").value.trim() || found.title || found.feed; let id = slug(name); while (draft.some(p => p.id === id)) id += "2";
    const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
    const dupe = draft.find(p => p.feed === found.feed || host(p.feed) === host(found.feed) || host(p.home) === host(found.home));
    if (dupe) { $("#probe-msg").className = "msg bad"; $("#probe-msg").textContent = `Already in the list as "${dupe.name}" (${dupe.feed}).`; return; }
    const color = $("#f-color").value;
    draft.push({ id, name, short: $("#f-short").value.trim() || name.slice(0, 8).toUpperCase(), color, ink: inkFor(color), home: found.home, feed: found.feed, tags: $("#f-tags").value.split(",").map(t => t.trim()).filter(Boolean) });
    $("#f-tags").value = "";
    found = null; $("#found").classList.remove("on"); $("#probe-url").value = ""; $("#probe-msg").textContent = `Added ${name}. Press Save and refresh to fetch it.`; renderDraft();
  };
  $("#pub-save").onclick = async () => {
    if (!draft.length) { $("#pub-msg").className = "msg bad"; $("#pub-msg").textContent = "Keep at least one publication."; return; }
    $("#pub-save").disabled = true; $("#pub-msg").className = "msg"; $("#pub-msg").textContent = "Saving feeds.json…";
    try {
      const r = await post("/publications", { publications: draft, complete: manageComplete });
      if (!r.ok) throw new Error(r.error);
      $("#pub-msg").textContent = "Saved. Fetching feeds…"; $("#pubshade").classList.remove("on"); refreshFeeds();
    } catch (e) { $("#pub-msg").className = "msg bad"; $("#pub-msg").textContent = "Not saved: " + e.message; }
    finally { $("#pub-save").disabled = false; }
  };
  $("#pub-cancel").onclick = $("#pub-x").onclick = () => $("#pubshade").classList.remove("on");
  $("#m-manage").onclick = openManage;

  // ---- stories by publisher (File → Operator) ----
  // The operator's report: every feed on the reader, with a small column chart of stories published per day, the count, and how long since
  // its latest story. On the web the numbers come from /api/op/volume (times only, for every feed, whoever follows it); on the Mac, which
  // holds the whole archive in the page, they are counted here. All rows share one scale, so a busy outlet and a quiet one compare honestly.
  // Counts are of stories still in the archive, by publication date, in this device's time zone.
  let volDays = 14, volData = null;
  const ago = s => { const h = (Date.now() / 1000 - s) / 3600; return h < 1 ? "under 1h" : h < 48 ? `${Math.floor(h)}h ago` : `quiet ${Math.floor(h / 24)}d`; };
  function drawVolume() {
    $$("#vol-range button").forEach(b => { const on = Number(b.dataset.vd) === volDays; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    const box = $("#vol-body"); box.classList.toggle("nofol", !mine.cloud);
    if (!volData) { $("#vol-sum").textContent = ""; box.innerHTML = `<div class="msg bad">Could not load the counts.</div>`; return; }
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (volDays - 1));
    const dayIdx = s => { const d = new Date(s * 1000); d.setHours(0, 0, 0, 0); return Math.round((d - start) / DAY); };
    const list = volData.map(p => { const days = Array(volDays).fill(0); for (const s of p.at) { const k = dayIdx(s); if (k >= 0 && k < volDays) days[k]++; }
      return { ...p, days, total: days.reduce((a, b) => a + b, 0), last: p.at.length ? Math.max(...p.at) : 0, label: p.name + (p.section && p.section !== p.name ? " · " + p.section : "") }; })
      .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    const peak = Math.max(1, ...list.flatMap(p => p.days)), all = list.reduce((n, p) => n + p.total, 0), quiet = list.filter(p => !p.last || Date.now() / 1000 - p.last >= 48 * 3600).length;
    const dayName = k => { const d = new Date(start); d.setDate(d.getDate() + k); return d.toLocaleDateString([], { month: "short", day: "numeric" }); };
    $("#vol-sum").textContent = `${list.length} ${list.length === 1 ? "publisher" : "publishers"} · ${all} ${all === 1 ? "story" : "stories"} in ${volDays} days (${dayName(0)} to today) · ${quiet ? `${quiet} quiet for 2 days or more` : "none quiet"} · tallest column: ${peak} in a day`;
    box.innerHTML = `<div class="vhead"><span>Publisher</span><span>Per day</span><span>Stories</span><span>Latest</span><span class="vf">Readers</span></div>` + list.map(p => {
      const best = p.days.indexOf(Math.max(...p.days)), late = !p.last ? "no stories" : ago(p.last), bad = !p.last || late.startsWith("quiet");
      const words = `${p.label}: ${p.total} ${p.total === 1 ? "story" : "stories"} in ${volDays} days${p.total ? `, most on ${dayName(best)} (${p.days[best]})` : ""}. Latest: ${late}.${mine.cloud ? ` ${p.followers} ${p.followers === 1 ? "reader follows" : "readers follow"} it.` : ""}`;
      return `<div class="vrow" style="--pc:${esc(p.color)}" title="${esc(words)}" aria-label="${esc(words)}" role="group"><span class="vn"><span class="sw" style="background:${esc(p.color)}"></span>${esc(p.label)}</span><span class="vbars" aria-hidden="true">${p.days.map(c => `<i style="height:${c ? Math.max(10, c / peak * 100).toFixed(0) : 0}%"></i>`).join("")}</span><b class="vt">${p.total}</b><span class="vl ${bad ? "bad" : ""}">${late}</span><span class="vf">${p.followers ?? ""}</span></div>`;
    }).join("");
  }
  async function openVolume() {
    closeMenus(); $("#volshade").classList.add("on"); $("#vol-sum").textContent = "Counting…"; $("#vol-body").innerHTML = ""; $("#vol-close").focus();
    volData = mine.cloud ? await fetch("/api/op/volume").then(r => r.ok ? r.json() : null).then(j => j && j.publications).catch(() => null)
      : data.publications.map(p => ({ id: p.id, name: p.name, section: p.section || "", color: p.color, followers: null, at: items.filter(i => i.pub === p.id && !i.archived).map(i => Math.floor(i.d / 1000)).filter(Boolean) }));
    drawVolume();
  }
  $("#m-volume").onclick = openVolume;
  // ---- my reading (File) ----
  // Which outlets and topics you read most, as small column charts like Stories by publisher. Counted here, in this browser, once you have actually read a
  // story (below: not merely opened it, since on a computer you may be stepping through them), and kept only here (never sent to the server, never on the account): nobody else can see it, and it is the whole of what the page knows
  // of your habits. 90 days are kept. It also puts the feeds your friends follow in the order you would likely want them (see chat.js, the picker).
  const READS = "rolodex.reads";
  const loadReads = () => { try { const r = JSON.parse(localStorage.getItem(READS)); if (r && r.d) return r; } catch {} return { d: {}, n: {}, c: {} }; };
  // A story counts when you do something that shows you are reading it, not when you merely open it (on a computer you may be stepping through them):
  // you scroll at least halfway down it, or you save it, share it, or open the outlet's own page. Nothing is timed and nothing runs in the background:
  // it is decided by those events alone. Each story counts once.
  let reading = null;
  const armReading = (it, p) => { if (!reading || reading.id !== it.id) reading = { id: it.id, it, p }; };
  const countReading = () => { const c = reading; if (!c) return; reading = null; noteReading(c.it, c.p); };
  document.addEventListener("click", e => { if (reading && e.target.closest("#save, #sendto, #source, #b-site, #x-site, .pinopen, #article .src a, #article [data-act=save], #article [data-act=sendto]")) countReading(); });
  function noteReading(it, p) {
    try {
      const r = loadReads(); r.s ||= []; if (r.s.includes(it.id)) return; r.s = [...r.s, it.id].slice(-2000);
      const day = ymd(new Date()), d = r.d[day] ||= { o: {}, t: {} }, key = groupOf(p);
      d.o[key] = (d.o[key] || 0) + 1; r.n[key] = p.name; r.c[key] = p.color;
      const tp = it.topics && it.topics[0] && it.topics[0].name; if (tp) { const t = REN[tp] || tp; d.t[t] = (d.t[t] || 0) + 1; }
      const keep = ymd(new Date(Date.now() - 90 * 86400e3)); for (const k of Object.keys(r.d)) if (k < keep) delete r.d[k];
      localStorage.setItem(READS, JSON.stringify(r));
    } catch {}
  }
  let readDays = 14;
  function drawReading() {
    $$("#read-range button").forEach(b => { const on = Number(b.dataset.rd) === readDays; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    const r = loadReads(), start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (readDays - 1));
    const rows = (which, name, color) => {
      const m = new Map();
      for (const [day, d] of Object.entries(r.d)) {
        const k = Math.round((new Date(day + "T00:00:00") - start) / DAY); if (k < 0 || k >= readDays) continue;
        for (const [key, n] of Object.entries(d[which])) { const x = m.get(key) || { key, days: Array(readDays).fill(0), total: 0 }; x.days[k] += n; x.total += n; m.set(key, x); }
      }
      return [...m.values()].map(x => ({ ...x, label: name(x.key), color: color(x.key) })).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)).slice(0, 25);
    };
    const outlets = rows("o", k => r.n[k] || k, k => r.c[k] || ""), topics = rows("t", k => k, () => "");
    const all = outlets.reduce((n, x) => n + x.total, 0), peak = Math.max(1, ...outlets.concat(topics).flatMap(x => x.days));
    const dayName = k => { const d = new Date(start); d.setDate(d.getDate() + k); return d.toLocaleDateString([], { month: "short", day: "numeric" }); };
    const section = (title, list, unit) => `<div class="vsec">${title}</div><div class="vhead"><span>${unit}</span><span>Per day</span><span>Read</span><span>Share</span></div>` + list.map(x => {
      const share = Math.round(x.total / Math.max(1, all) * 100) + "%", words = `${x.label}: ${x.total} ${x.total === 1 ? "story" : "stories"} read in ${readDays} days, ${share} of your reading.`;
      return `<div class="vrow" ${x.color ? `style="--pc:${esc(x.color)}"` : ""} title="${esc(words)}" aria-label="${esc(words)}" role="group"><span class="vn">${x.color ? `<span class="sw" style="background:${esc(x.color)}"></span>` : ""}${esc(x.label)}</span><span class="vbars" aria-hidden="true">${x.days.map(c => `<i style="height:${c ? Math.max(10, c / peak * 100) : 0}%"></i>`).join("")}</span><span class="vt">${x.total}</span><span class="vl">${share}</span></div>`;
    }).join("");
    $("#read-sum").textContent = all ? `${all} ${all === 1 ? "story" : "stories"} read in ${readDays} days (${dayName(0)} to today). Counted in this browser only: nothing is sent anywhere.` : "Nothing read in this time yet. A story counts once you have read into it, here in this browser only.";
    $("#read-body").innerHTML = all ? section("Outlets", outlets, "Outlet") + (topics.length ? section("Topics", topics, "Topic") : "") : "";
    $("#read-body").style.display = all ? "" : "none";   // nothing to chart: no empty box under the message
  }
  // two views in one window: what you read, and how many stories arrived (the Story volume chart, which used to be a floating window)
  function showReadView() {
    const vol = readView === "vol", read = readView === "read";
    $$("#read-view button").forEach(b => { const on = b.dataset.rv === readView; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    $$("#read-range button").forEach(b => { const on = Number(b.dataset.rd) === readDays; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
    $("#read-range").style.display = read ? "" : "none"; $("#vol72").style.display = vol ? "" : "none"; $("#read-sum").style.display = read || !readView ? "" : "none";
    if (!readView) { $("#read-sum").textContent = "Choose what to look at. Nothing here leaves this browser."; $("#read-body").style.display = "none"; $("#read-body").innerHTML = ""; }
    else if (vol) { $("#read-body").style.display = "none"; drawChart(); } else drawReading();
  }
  function openReading() { closeMenus(); readView = ""; readDays = 14; $("#readshade").classList.add("on"); showReadView(); $("#read-x").focus(); }   // nothing is remembered: each time it opens small, until a view is chosen
  $("#read-view").onclick = e => { const b = e.target.closest("[data-rv]"); if (b) { readView = b.dataset.rv; showReadView(); } };
  addEventListener("resize", () => { if (chartOpen()) drawChart(); });
  $("#m-reading").onclick = openReading;
  $("#read-range").onclick = e => { const b = e.target.closest("[data-rd]"); if (b) { readDays = Number(b.dataset.rd); drawReading(); } };
  $("#read-x").onclick = () => $("#readshade").classList.remove("on");
  $("#readshade").addEventListener("pointerdown", e => { if (e.target.id === "readshade") $("#readshade").classList.remove("on"); });
  // ---- top inviters (File → Operator, web only) ----
  // Whose links have brought people in: up to ten names, each with a bar (all on one scale) and the count of accounts made through their
  // link that still exist. From /api/op/inviters: names and counts, nothing else.
  async function openInviters() {
    closeMenus(); $("#invshade").classList.add("on"); $("#inv-sum").textContent = "Counting…"; $("#inv-body").innerHTML = ""; $("#inv-close").focus();
    const d = await fetch("/api/op/inviters").then(r => r.ok ? r.json() : null).catch(() => null);
    if (!d) { $("#inv-sum").textContent = "Could not load the report."; return; }
    const top = Math.max(1, ...d.inviters.map(r => r.n));
    $("#inv-sum").textContent = `${d.invited} of ${d.accounts} ${d.accounts === 1 ? "account" : "accounts"} came through a friend's link.${(d.sources || []).length ? " By tagged link: " + d.sources.map(s => `${s.source} ${s.n}`).join(", ") + "." : ""}`;
    $("#inv-body").innerHTML = d.inviters.map(r => `<div class="irow"><span class="vn">${esc(r.screen_name)}</span><span class="ibar" aria-hidden="true"><i style="width:${Math.round(100 * r.n / top)}%"></i></span><span class="vt">${r.n}</span></div>`).join("")
      || `<div class="irow"><span class="vn">Nobody has joined through a link yet.</span></div>`;
  }
  $("#m-inviters").style.display = operator ? "" : "none"; $("#m-inviters").onclick = openInviters;
  $("#m-records").style.display = operator ? "" : "none"; $("#m-records").onclick = () => { closeMenus(); location.href = "/api/op/records.csv"; };   // the synced stories as a file for a spreadsheet
  // Tagged links (File → Operator, web only): the invite links posted somewhere on purpose, such as the one for an Instagram caption. They
  // live here and not under Invite a friend, which shows only a person's ordinary link. A tag with a short address (SHORT, the same paths
  // as TAGGED in cloud/worker.js) is shown by it, since that is what gets typed; the button copies it.
  const SHORT = { instagram: "/ig" };
  $("#m-links").style.display = operator ? "" : "none";
  $("#m-links").onclick = async () => {
    closeMenus();
    const d = await fetch("/api/op/links").then(r => r.ok ? r.json() : null).catch(() => null), links = d ? d.links : [];
    if (!links.length) return retroAsk({ title: "Tagged links", cancel: "", text: d ? "There are no tagged links yet." : "Could not load the links." });
    const addr = l => SHORT[l.source] ? location.host + SHORT[l.source] : `${location.origin}/#invite=${l.code}`;
    const text = links.map(l => `${l.source[0].toUpperCase() + l.source.slice(1)} · ${l.owner}'s link\n${addr(l)}\n${l.n} ${l.n === 1 ? "account" : "accounts"} so far`).join("\n\n");
    if (await retroAsk({ title: "Tagged links", text, ok: links.length === 1 ? "Copy link" : "Copy the first", cancel: "Close" })) { try { await navigator.clipboard.writeText((SHORT[links[0].source] ? "https://" : "") + addr(links[0])); } catch {} }
  };
  $("#inv-close").onclick = $("#inv-x").onclick = () => $("#invshade").classList.remove("on");
  $("#invshade").addEventListener("pointerdown", e => { if (e.target.id === "invshade") $("#invshade").classList.remove("on"); });
  $("#vol-range").onclick = e => { const b = e.target.closest("[data-vd]"); if (b) { volDays = Number(b.dataset.vd); drawVolume(); } };
  $("#vol-close").onclick = $("#vol-x").onclick = () => $("#volshade").classList.remove("on");
  $("#volshade").addEventListener("pointerdown", e => { if (e.target.id === "volshade") $("#volshade").classList.remove("on"); });

  // ---- splitter ----
  const split = $("#split"), list = $("#list");
  split.addEventListener("pointerdown", e => { split.setPointerCapture(e.pointerId); const x0 = e.clientX, w0 = list.getBoundingClientRect().width;
    const mv = ev => list.style.width = Math.max(220, w0 + ev.clientX - x0) + "px";
    split.addEventListener("pointermove", mv); split.addEventListener("pointerup", () => split.removeEventListener("pointermove", mv), { once: true }); });

  // ---- the Story volume chart (drawn in My reading's second view) ----
  function drawChart() {
    const c = $("#chart"), box = c.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1; if (!box.width) return;
    c.width = (box.width - 6) * dpr; c.height = (box.height - 6) * dpr; const g = c.getContext("2d"); g.scale(dpr, dpr);
    const W = box.width - 6, H = box.height - 6, N = 24, now = Date.now(), B = 3 * 3600e3, buckets = Array(N).fill(0);
    for (const it of all) { const k = Math.floor((now - it.d) / B); if (k >= 0 && k < N) buckets[N - 1 - k]++; }
    const peak = Math.max(1, ...buckets), total = buckets.reduce((a, b) => a + b, 0);
    $("#st-now").textContent = buckets[N - 1]; $("#st-avg").textContent = (total / N).toFixed(1); $("#st-peak").textContent = peak; $("#st-total").textContent = all.length;
    const ink = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();   // the chart is drawn in the paper's own colours
    g.fillStyle = ink("--field"); g.fillRect(0, 0, W, H);
    const L = 6, R = 30, T = 6, Bt = 14, pw = W - L - R, ph = H - T - Bt;
    g.strokeStyle = ink("--paper-rule"); g.lineWidth = 1; g.font = "9px Lucida Console, Courier New, monospace"; g.fillStyle = ink("--dim2");
    for (let t = 0; t <= 4; t++) { const y = T + ph - ph * t / 4 + .5; g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); g.textAlign = "left"; g.fillText(Math.round(peak * t / 4), L + pw + 4, y + 3); }
    for (let x = 0; x <= N; x += 4) { const px = L + pw * x / N + .5; g.beginPath(); g.moveTo(px, T); g.lineTo(px, T + ph); g.stroke(); }
    g.textAlign = "left"; g.fillText("-72 H", L, H - 3); g.textAlign = "right"; g.fillText("NOW", L + pw, H - 3);
    g.strokeStyle = ink("--black"); g.lineWidth = 1.5; g.beginPath();
    buckets.forEach((v, i) => { const x = L + pw * (i + .5) / N, y = T + ph - ph * v / peak; i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    g.fillStyle = ink("--accent"); buckets.forEach((v, i) => { const x = L + pw * (i + .5) / N, y = T + ph - ph * v / peak; g.fillRect(x - 1.5, y - 1.5, 3, 3); });
  }

  // The catch for any picture that still will not load (moved, removed, or refused by its outlet): take it out, with its frame and caption
  // if that leaves them empty, so a story shows no broken-image marker. Image errors do not bubble, so this listens on the way down.
  document.addEventListener("error", e => {
    const img = e.target; if (!img || img.tagName !== "IMG" || !img.closest(".article .doc, .convo .log")) return;
    const frame = img.closest("figure, picture"); img.remove();
    if (frame && !frame.querySelector("img, video")) frame.remove();
  }, true);
  window.reader = { show, syncActs, closeMenus, leaveTag: () => { if (tagView) closeTag(); }, status: t => { $("#s1").textContent = t; }, findItem: id => items.find(i => i.id === id), currentItem: () => items.find(i => i.id === sel), companion, pubName: id => pubs.get(id).name, pubColor: id => pubs.get(id).color };
  renderSources(); renderList();
  let restore = null; try { restore = sessionStorage.getItem("rolodex.sel"); sessionStorage.removeItem("rolodex.sel"); } catch {}
  // the story that was open before a reload comes back, and the list is loaded far enough back to hold its row
  const kept = restore && all.find(r => r.id === restore);
  // (on a phone nothing is picked out until a story is opened: a highlighted first row would hide the tint on the newest story)
  if (kept) { if (at(kept) <= cutoff) { cutoff = edge(dayOf(kept)); renderList(); } show(restore, true); } else if (rows[0] && !isPhone()) show(rows[0].id);
})();
