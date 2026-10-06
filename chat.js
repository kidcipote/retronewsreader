// The Gossip Column (the friends list; "buddies" in the API and the database) and its conversations for the retronewsreader, plus the
// account windows (Sign On, My Account, the welcome steps, Manage feed / Add to feed, Reports). Talks to /api/* (cloud only).
// Expects window.reader = { show, findItem, currentItem, companion, pubName, pubColor, closeMenus, leaveTag, status } from app.js.
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // index.html publishes window.reader once its data has loaded; look it up lazily rather than at script load
  const R = new Proxy({}, { get: (_, k) => (window.reader || {})[k] || (() => null) });
  const api = async (path, opts = {}) => {
    const r = await fetch(path, { credentials: "same-origin", headers: opts.body ? { "Content-Type": "application/json" } : {}, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  };
  // ---------- private messages ----------
  // A message is sealed in the sender's browser and opened in the reader's. The server stores and relays the sealed form and cannot open it;
  // neither can the person who runs the reader, from the database. How:
  //   · Each account has a key pair (ECDH, P-256) made in its own browser. The public half is given to the server in the open.
  //   · The private half is kept on the server too, but locked (AES-GCM) with a key stretched from the account's password (PBKDF2), so the
  //     database alone cannot open it. A browser opens it once, at sign-on, and keeps the opened key in IndexedDB in a form that cannot be
  //     read back out. Signing off removes that copy; nothing else is lost by signing off.
  //   · Two friends' browsers each combine their own private key with the other's public key and reach the same secret. That secret seals
  //     (AES-GCM, a fresh nonce each time) every message between them: the text and any story, together.
  //   · Reset a forgotten password and the lock on the private half can never be opened, so a new pair is made. What was written before can no
  //     longer be read by that person. The friend still can, because old public halves are kept.
  // What this does not hide: who wrote to whom, when, whether a message carries a story, and what it answers. And like any website, it rests
  // on the reader's own code being what it says it is.
  const te = new TextEncoder(), td = new TextDecoder(), ECDH = { name: "ECDH", namedCurve: "P-256" };
  const b64 = buf => { let s = ""; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); }, unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const stretch = async (password, salt) => crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 250000 },
    await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const seal = async (key, bytes) => { const iv = crypto.getRandomValues(new Uint8Array(12)), ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes)), out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return b64(out); };
  const unseal = async (key, s) => { const b = unb64(s); return crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, key, b.slice(12)); };
  // a new pair, its private half locked with this password. `pkcs8` is the open private half, for this browser to keep.
  async function makeKeys(password) {
    const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveKey"]), salt = crypto.getRandomValues(new Uint8Array(16)), pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
    return { pub: b64(await crypto.subtle.exportKey("raw", pair.publicKey)), enc_salt: b64(salt), enc_priv: await seal(await stretch(password, salt), pkcs8), pkcs8 };
  }
  const unlock = async (password, k) => unseal(await stretch(password, unb64(k.enc_salt)), k.enc_priv);   // the open private half; throws when the password is wrong
  const relock = async (password, pkcs8) => { const salt = crypto.getRandomValues(new Uint8Array(16)); return { enc_salt: b64(salt), enc_priv: await seal(await stretch(password, salt), pkcs8) }; };
  const vault = (mode, fn) => new Promise((done, fail) => { const o = indexedDB.open("retronewsreader", 1); o.onupgradeneeded = () => o.result.createObjectStore("keys"); o.onerror = () => fail(o.error);
    o.onsuccess = () => { const tx = o.result.transaction("keys", mode), rq = fn(tx.objectStore("keys")); tx.oncomplete = () => done(rq && rq.result); tx.onerror = () => fail(tx.error); }; });
  let myKey = null; const pairs = new Map();   // { id, priv } once this browser can open my messages; the shared secret with each friend's public key
  async function holdKey(uid, id, pkcs8) { myKey = { id, priv: await crypto.subtle.importKey("pkcs8", pkcs8, ECDH, false, ["deriveKey"]) }; pairs.clear();
    for (const b of buddies) if (b.last && b.last.enc) b.last.opened = b.last.locked = false;   // what could not be opened a moment ago can be now
    try { await vault("readwrite", s => s.put(myKey, String(uid))); } catch {} }
  async function loadKey() { try { const k = await vault("readonly", s => s.get(String(me.id))); myKey = k && k.id === me.key_id ? k : null; } catch { myKey = null; } }
  const dropKey = async uid => { myKey = null; pairs.clear(); try { await vault("readwrite", s => s.delete(String(uid))); } catch {} };
  async function pairKey(pub) {
    let k = pairs.get(pub);
    if (!k) { k = await crypto.subtle.deriveKey({ name: "ECDH", public: await crypto.subtle.importKey("raw", unb64(pub), ECDH, false, []) }, myKey.priv, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); pairs.set(pub, k); }
    return k;
  }
  const sealFor = async (b, what) => seal(await pairKey(b.key.pub), te.encode(JSON.stringify(what)));
  // Open a message (or a friend's latest line) in place: it gains `body` and `story`, or `locked` when this account's key cannot open it.
  async function reveal1(m) {
    if (!m || !m.enc || m.opened) return m;
    try { if (!myKey || m.mk !== myKey.id || !m.pub) throw 0; const o = JSON.parse(td.decode(await unseal(await pairKey(m.pub), m.enc))); m.body = String(o.body || ""); m.story = o.story || null; }
    catch { m.locked = true; m.body = ""; m.story = null; }
    m.opened = true; return m;
  }
  const revealAll = list => Promise.all(list.map(reveal1));
  async function revealLasts() { for (const b of buddies) { const l = b.last; if (l && l.enc && !l.opened) { await reveal1(l); l.text = l.locked ? "A message this account can no longer open" : l.body; l.story = l.story ? l.story.title : null; } } }
  // At sign-on the password is in hand: open the key with it, or make one if this account has none yet.
  async function keysAtSignOn(password, d) {
    try {
      if (d.keys) return await holdKey(d.me.id, d.keys.id, await unlock(password, d.keys));
      const k = await makeKeys(password), r = await api("/api/keys", { method: "POST", body: { pub: k.pub, enc_priv: k.enc_priv, enc_salt: k.enc_salt, password } });
      if (r.ok) await holdKey(d.me.id, r.data.id, k.pkcs8);
    } catch {}
  }
  // Is this browser able to open my messages? If not, ask for the password, once: to open the key, or to make one for an older account.
  async function ready() {
    if (myKey && myKey.id === me.key_id) return true;
    const setup = !me.key_id;
    for (let again = ""; ;) {
      const pw = await retroAsk({ title: setup ? "Private messages" : "Unlock your messages", ok: setup ? "Turn on" : "Unlock", input: true, secret: true, placeholder: "Your sign-on password",
        text: again + (setup ? "Type your sign-on password to turn on private messages.\n\nOnly you and your friend can read them." : "Type your sign-on password to open your messages in this browser.") });
      if (pw === null) return false;
      try {
        if (setup) {
          const k = await makeKeys(pw), r = await api("/api/keys", { method: "POST", body: { pub: k.pub, enc_priv: k.enc_priv, enc_salt: k.enc_salt, password: pw } });
          if (!r.ok) { again = (r.data.error || "That did not work.") + "\n\n"; continue; }
          me.key_id = r.data.id; await holdKey(me.id, r.data.id, k.pkcs8);
        } else { const r = await api("/api/keys/mine"); if (!r.ok) throw 0; await holdKey(me.id, r.data.id, await unlock(pw, r.data)); }
        return true;
      } catch { again = "That is not your password.\n\n"; }
    }
  }
  const fmt = iso => { const d = new Date(iso.replace(" ", "T") + "Z"); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };

  // ---------- styles ----------
  document.head.insertAdjacentHTML("beforeend", `<style>
    .aim { position: fixed; z-index: 80; display: flex; flex-direction: column; padding: 3px; width: 300px; max-height: calc(80 * var(--vh, 1vh)); }
    .aim .titlebar { cursor: move; }
    .aim .body { padding: 8px; display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: auto; }
    .aim .k { font: 300 10px var(--mono); letter-spacing: .05em; color: var(--black); }
    .aim .bud { display: flex; align-items: center; gap: 6px; padding: 4px 6px; cursor: default; }
    .aim .bud:hover { background: var(--sel); color: var(--white); }
    .aim .bud .dot { width: 7px; height: 7px; border-radius: 50%; box-shadow: inset 0 0 0 1px var(--shade); }
    .aim .bud.on .dot { background: var(--green); box-shadow: none; }
    .aim .bud .n { flex: 1; }
    .aim .row { display: flex; gap: 4px; }
    .aim input[type=text], .aim input[type=password], .aim input[type=email] { flex: 1; min-width: 0; font: 12px var(--font); border: 0; padding: 4px 6px; background: var(--paper); box-shadow: inset -1px -1px var(--light), inset 1px 1px var(--shade), inset -2px -2px var(--lighter), inset 2px 2px var(--dark); }
    .aim .msg { font: 300 10px var(--mono); color: var(--accent); min-height: 12px; }
    .aim textarea { width: 100%; height: 56px; resize: none; font: 13px var(--font); border: 0; padding: 5px 6px; background: var(--paper); box-shadow: inset -1px -1px var(--light), inset 1px 1px var(--shade), inset -2px -2px var(--lighter), inset 2px 2px var(--dark); }
    .aim .btns { display: flex; gap: 6px; justify-content: flex-end; }
    .aim.acct { width: 330px; }
    .aim .sub { font: 300 10px var(--mono); color: var(--dim1); }
    .aim a.lnk { color: var(--paper-link); cursor: pointer; text-decoration: underline; font-size: 11px; }
    .aim .links { display: flex; gap: 4px 10px; flex-wrap: wrap; margin-right: auto; }
    .aim .btns.wrap { flex-wrap: wrap; justify-content: flex-start; }
    #sendto-menu .bud { padding: 6px 8px; }
    .wel { position: fixed; inset: 0; z-index: 900; background: var(--desk); display: grid; place-items: center; }
    .wel .panel { width: min(470px, calc(100 * var(--vw, 1vw))); max-height: min(calc(92 * var(--vh, 1vh)), var(--vvh, 100dvh)); display: flex; flex-direction: column; padding: 3px; }
    /* the body is the part that scrolls; without min-height: 0 a flex child refuses to shrink and the window runs off the screen */
    .wel .wbody, .aim .body { overscroll-behavior: none; }
    .wel .wbody { flex: 1 1 auto; min-height: 0; padding: 16px 16px 8px; overflow: auto; display: flex; flex-direction: column; gap: 7px; }
    .wel .wbody > * { flex: none; } .wel .titlebar, .wel .foot { flex: none; }
    .wel h2 { font: 500 22px/1.05 var(--font); letter-spacing: -.012em; margin: 0; }
    .wel .lead { margin: 0 0 4px; font-size: 12.5px; color: var(--dim); }
    .wel .k { font: 300 10px var(--mono); letter-spacing: .05em; color: var(--black); margin-top: 5px; }
    .wel input { width: 100%; font: 13px var(--font); border: 0; padding: 6px 8px; background: var(--paper); box-shadow: inset -1px -1px var(--light), inset 1px 1px var(--shade), inset -2px -2px var(--lighter), inset 2px 2px var(--dark); }
    .wel input[readonly] { color: var(--paper-soft); }
    .wel .chips { display: flex; flex-wrap: wrap; gap: 5px; } .wel .chip { padding: 4px 9px; position: relative; }
    /* the × sits inside the button, in its top right corner: a small mark in the button's own padding, not a badge hanging off it */
    .wel .chip .rm { display: none; position: absolute; top: 0; right: 0; width: 13px; height: 13px; font: 500 11px/12px var(--font); text-align: center; color: var(--white); opacity: .75; }
    .wel .chip .rm:hover { opacity: 1; background: var(--accent); }
    @media (hover: hover) { .wel .chip.on:hover .rm { display: block; } }
    .wel .chip.on { background: var(--black); color: var(--white); box-shadow: inset 1px 1px #000, inset -1px -1px var(--shade); }
    .wel .sub2 { border-left: 2px solid var(--shade); padding: 2px 0 2px 8px; }
    .wel .row2 { display: flex; gap: 6px; } .wel .row2 input { flex: 1; min-width: 0; }
    .wel .frow { display: flex; gap: 8px; align-items: flex-start; padding: 5px 0; border-bottom: 1px dotted var(--shade); } .wel .frow input { margin-top: 3px; }
    .wel input[type=checkbox], .wel input[type=radio] { width: 13px; padding: 0; flex: none; }
    .wel .swatch { width: 26px; height: 22px; padding: 0; } .wel .swatch.on { box-shadow: inset 0 0 0 2px var(--white), inset 0 0 0 3px var(--black); }
    .wel .note { font-size: 12px; padding: 7px 9px; background: var(--accent-soft); border-left: 3px solid var(--accent); margin-top: 4px; }
    .wel .frow small { display: block; font: 300 10.5px var(--mono); color: var(--dim1); } .wel .frow i { font: 300 10px var(--mono); color: var(--accent); font-style: normal; } #fd-found { display: flex; flex-direction: column; gap: 2px; } #fd-add { margin-top: 6px; }
    .wel .foot { display: flex; align-items: center; gap: 10px; padding: 8px 16px 14px; } .wel .foot .msg { flex: 1; font: 300 10.5px var(--mono); color: var(--accent); } .wel .foot .go { padding: 6px 14px; }
    .wel a.lnk { color: var(--paper-link); text-decoration: underline; }
    .tipbar { display: flex; gap: 10px; align-items: center; padding: 7px 10px; background: var(--lighter); border-bottom: 1px solid var(--shade); font-size: 12px; } .tipbar span { flex: 1; }
    /* Phones: windows sit at the top, full width, and never taller than what is visible above the keyboard (--vvh, kept current below). */
    @media (max-width: 700px) {
      .aim { left: 0 !important; right: 0 !important; top: 0 !important; bottom: auto !important; width: auto !important; max-height: var(--vvh, 100dvh); overflow: auto; }
      .aim .titlebar { position: sticky; top: 0; z-index: 1; flex: none; height: 36px; }
      .wel { place-items: stretch; } .wel .panel { width: calc(100 * var(--vw, 1vw)); height: var(--vvh, 100dvh); max-height: none; } .wel .wbody { flex: 1; } .wel .foot { padding: 8px 14px calc(14px + env(safe-area-inset-bottom)); }
      /* One type scale for every window on a phone, the same as the menus (index.html, .menu.sheet): 15px text, 10.5px capital labels,
         12px small print, buttons 36px tall, 14px side margins. A new window uses these; it does not pick its own sizes. */
      .wel .wbody, .aim .body { padding: 14px; gap: 10px; font: 400 15px/1.35 var(--font); }
      .wel .lead, .wel .note, .wel .frow, .aim .bud, .aim a.lnk, .wel a.lnk, .tipbar { font-size: 15px; }
      .wel .k, .aim .k { font: 300 10.5px var(--mono); letter-spacing: .08em; text-transform: uppercase; }
      .wel .foot .msg, .aim .msg, .aim .sub, .wel .frow small, .wel .frow i { font: 300 12px var(--mono); }
      .wel button, .aim button, .tipbar button { font: 400 15px var(--font); min-height: 36px; padding: 0 12px; }
      .wel .chips { gap: 6px; } .wel .chip .rm, .wel .swatch { min-height: 0; padding: 0; } .wel .swatch { width: 36px; height: 36px; }
      .aim a.lnk { font: 400 15px var(--font); padding: 4px 0; } .aim .sub a, .aim .msg a { font: inherit; padding: 0; } .aim .bud { min-height: 40px; padding: 0 6px; }
      .wel .chip, .wel .foot .go { padding: 0 12px; }
      .wel .titlebar { height: 36px; flex: none; } .wel .titlebar .wb { display: block; width: 34px; height: 26px; min-height: 0; font-size: 18px; line-height: 1; padding: 0; }
      .aim .titlebar .wb { display: block; width: 34px; height: 26px; min-height: 0; font-size: 18px; line-height: 1; padding: 0; }   /* the page hides its own decorative window buttons on phones; these ones close things */
      .aim .btns { align-items: center; }
    }
  </style>`);

  // The visible height: on a phone it shrinks when the keyboard opens, which 100dvh does not report on iOS.
  const vv = window.visualViewport;
  // On wide screens the whole page is scaled up ("Fit to screen" sets a zoom on the document), and a length inside a scaled document is
  // multiplied by that scale: so the height is divided by it, or a window sized to "the screen" would be taller than the screen.
  if (vv) { const fit = () => document.documentElement.style.setProperty("--vvh", Math.floor(vv.height / (parseFloat(document.documentElement.style.zoom) || 1)) + "px"); fit(); vv.addEventListener("resize", fit); addEventListener("resize", () => setTimeout(fit, 0)); document.addEventListener("reader:zoom", fit); }

  // ---------- state ----------
  let me = null, buddies = [], lastId = 0, pollTimer = null;
  let z = 80;
  const raise = el => el.style.zIndex = ++z;
  // Put a window's top left corner at a point on screen, held inside the reader's frame.
  function place(el, x, y) {
    const z = parseFloat(document.documentElement.style.zoom) || 1, f = document.querySelector(".window").getBoundingClientRect(), r = el.getBoundingClientRect();
    const cx = Math.min(Math.max(x, f.left), Math.max(f.left, f.right - r.width)), cy = Math.min(Math.max(y, f.top), Math.max(f.top, f.bottom - r.height));
    Object.assign(el.style, { left: cx / z + "px", top: cy / z + "px", right: "auto", bottom: "auto" });
  }
  // a window that the frame has shrunk away from (the browser was resized) is brought back inside
  addEventListener("resize", () => { if (innerWidth > 700) for (const el of document.querySelectorAll(".aim")) { const r = el.getBoundingClientRect(); place(el, r.left, r.top); } });
  function makeWindow(cls, title, html, pos) {
    const el = document.createElement("div"); el.className = "aim raised " + cls;
    el.innerHTML = `<div class="titlebar"><span class="ico"></span><span class="wt">${esc(title)}</span><span class="sp"></span><button class="wb x" aria-label="Close">×</button></div><div class="body">${html}</div>`;
    Object.assign(el.style, pos); document.body.appendChild(el); raise(el);
    el.addEventListener("pointerdown", () => raise(el));
    const tb = el.querySelector(".titlebar");
    // Dragging keeps the window inside the reader's own frame: it cannot be left half off the page or out of reach.
    // On wide screens the page is scaled up, so a distance on screen is `zoom` times a distance in the page's own units.
    tb.addEventListener("pointerdown", e => { if (e.target.tagName === "BUTTON" || innerWidth <= 700) return; const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const mv = ev => place(el, ev.clientX - dx, ev.clientY - dy);
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", () => window.removeEventListener("pointermove", mv), { once: true }); });
    return el;
  }

  // ---------- sign on (also: new account, forgot password) ----------
  const LEGAL = `<a class="lnk" href="/terms" target="_blank" rel="noopener">terms</a> and the <a class="lnk" href="/privacy" target="_blank" rel="noopener">privacy notes</a>`;
  let signon = null;
  function openSignOn(msg, name) {
    if (signon) { raise(signon); if (msg) signon.querySelector(".msg").textContent = msg; return; }
    signon = makeWindow("signon", "Sign On", `
      <div data-m="signon create"><div class="k">Screen name</div><div class="row"><input type="text" id="so-name" autocomplete="username" maxlength="16" spellcheck="false"></div></div>
      <div data-m="signon create"><div class="k">Password</div><div class="row"><input type="password" id="so-pw" autocomplete="current-password"></div></div>
      <div data-m="create forgot"><div class="k">Email</div><div class="row"><input type="email" id="so-email" autocomplete="email" spellcheck="false" placeholder="where password resets are sent"></div></div>
      <div class="sub" data-m="create">By creating an account you accept the ${LEGAL}.</div>
      <div class="msg" id="so-msg"></div>
      <div class="btns"><span class="links"><a class="lnk" data-go="signon">Sign on</a><a class="lnk" data-go="create">New account…</a><a class="lnk" data-go="forgot">Forgot password?</a></span><button id="so-go" class="default">Sign On</button></div>`, { left: "calc(50% - 150px)", top: "24%" });
    let mode = "signon";
    const LABEL = { signon: "Sign On", create: "Create account", forgot: "Send reset link" };
    const HINT = { signon: "", create: "The very first account needs no invite.", forgot: "Enter the email on your account. If it is confirmed, a link to choose a new password is sent there. After a reset, messages you had before can no longer be read." };
    const setMode = (m, text) => {
      if (m === "create") return openWelcome();
      mode = m;
      signon.querySelectorAll("[data-m]").forEach(el => el.style.display = el.dataset.m.split(" ").includes(m) ? "" : "none");
      signon.querySelectorAll("[data-go]").forEach(el => el.style.display = el.dataset.go === m ? "none" : "");
      $("#so-go").textContent = LABEL[m]; $("#so-pw").autocomplete = m === "create" ? "new-password" : "current-password"; $("#so-msg").textContent = text ?? HINT[m];
    };
    const go = async () => {
      const screen_name = $("#so-name").value.trim(), password = $("#so-pw").value, email = $("#so-email").value.trim();
      $("#so-msg").textContent = "One moment…";
      const r = mode === "signon" ? await api("/api/login", { method: "POST", body: { screen_name, password } })
        : mode === "create" ? await api("/api/signup", { method: "POST", body: { screen_name, password, email } })
        : await api("/api/password/forgot", { method: "POST", body: { email } });
      if (!r.ok) { $("#so-msg").textContent = r.data.error || `Error ${r.status}`; return; }
      if (mode === "forgot") { $("#so-msg").textContent = r.data.message; return; }
      if (mode === "signon") await keysAtSignOn(password, r.data);   // the password opens the message key, here and now, while it is in hand
      restart("");   // the page reloads to show this person's own list
    };
    signon.querySelector("#so-go").onclick = go;
    signon.querySelectorAll("input").forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") go(); }));
    signon.querySelectorAll("[data-go]").forEach(el => el.onclick = () => setMode(el.dataset.go));
    signon.querySelector(".x").onclick = () => { signon.remove(); signon = null; };
    setMode("signon", msg || ""); if (name) $("#so-name").value = name;
    $("#so-name").focus();
  }
  function notice(title, text) {
    const el = makeWindow("", title, `<div>${esc(text)}</div><div class="btns"><button class="default ok">OK</button></div>`, { left: "calc(50% - 150px)", top: "30%" });
    el.querySelector(".x").onclick = el.querySelector(".ok").onclick = () => el.remove();
  }

  // ---------- welcome (a new account in three steps) and Your feeds ----------
  // Full-screen panels rather than small windows: step 1 the account, step 2 what to read.
  const restart = after => { try { if (after) sessionStorage.setItem("rolodex.after", after); } catch {} location.reload(); };
  let wel = null;
  function shell(title, onClose) {
    if (wel) wel.remove();
    wel = document.createElement("div"); wel.className = "wel";
    wel.innerHTML = `<div class="panel raised"><div class="titlebar"><span class="ico"></span><span class="wt">${esc(title)}</span><span class="sp"></span><button class="wb x" aria-label="Close">×</button></div><div class="wbody"></div><div class="foot"><span class="msg"></span><button class="default go"></button></div></div>`;
    document.body.appendChild(wel);
    wel.querySelector(".x").onclick = onClose;
    return { body: wel.querySelector(".wbody"), msg: wel.querySelector(".msg"), go: wel.querySelector(".go"), title: t => wel.querySelector(".wt").textContent = t };
  }
  // Your list, as chips: every feed you follow, each one tappable to take it off (saved with the Save button), or removed at once with its ×.
  // Under it, the feeds you had before and took off, each one tap from being put back: taking a feed off never loses it.
  // There is no catalog to browse: a feed you have never had is added by looking its outlet up (the box in the same window), or picked
  // from what your friends follow, which is the reader's one way of suggesting anything.
  // `sel` is a Set of publication ids, edited in place. `onRemoved`, when given, is told after a × removal so the caller can save at once.
  async function picker(host, sel, onChange, onMore, onRemoved) {
    const pick = await api("/api/pubs/pick").then(r => r.ok ? r.data : {}).catch(() => ({})), reg = pick.publications || [];
    const label = p => p.section && p.section !== p.name ? `${p.name} · ${p.section}` : p.name;   // one outlet can have several feeds: each is a section
    const mine = reg.filter(p => sel.has(p.id)).map(p => ({ id: p.id, name: label(p) })).sort(az);
    const before = reg.filter(p => (pick.past || []).includes(p.id) && !sel.has(p.id)).map(p => ({ id: p.id, name: label(p) })).sort(az);
    // what your friends read and you do not: the one way a feed is suggested. The server sends the order (most followed first, never a count); this page
    // then puts first the feeds whose topics you open most, from your own reading counts, which are kept in this browser only (app.js, "my reading").
    const mineRead = (() => { try { const r = JSON.parse(localStorage.getItem("rolodex.reads")), t = {}, from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10); for (const [day, d] of Object.entries(r.d)) if (day >= from) for (const [k, n] of Object.entries(d.t || {})) t[k] = (t[k] || 0) + n; return t; } catch { return {}; } })();
    const likes = p => (p.top || []).reduce((n, t) => n + (mineRead[t] || 0), 0);
    const viaFriends = reg.filter(p => p.friend && !sel.has(p.id) && !(pick.past || []).includes(p.id)).sort((a, b) => likes(b) - likes(a) || a.rank - b.rank).map(p => ({ id: p.id, name: label(p) }));
    const groups = () => onMore ? [...new Map(reg.filter(p => p.group && sel.has(p.id)).map(p => [p.group, p])).values()].sort(az) : [];
    // a feed on the list shows an × at its corner when the mouse is over it; removing that way asks first
    const chip = p => `<button class="chip ${sel.has(p.id) ? "on" : ""}" data-id="${esc(p.id)}" data-name="${esc(p.name)}">${esc(p.name)}${sel.has(p.id) ? `<span class="rm" data-rm="${esc(p.id)}" role="button" aria-label="Remove ${esc(p.name)}" title="Remove from your feed">×</span>` : ""}</button>`;
    const draw = () => {
      host.innerHTML = `<div class="k">On your list</div><div class="chips">${mine.map(chip).join("") || `<span class="lead">Nothing yet. Look an outlet up to add it.</span>`}</div>
        ${viaFriends.length ? `<div class="k">Followed by your friends</div><div class="chips">${viaFriends.map(chip).join("")}</div>` : ""}
        ${before.length ? `<div class="k">Had before. Tap one to put it back</div><div class="chips">${before.map(chip).join("")}</div>` : ""}
        ${groups().length ? `<div class="k">More from an outlet you follow</div><div class="chips">${groups().map(g => `<button class="chip boro" data-more="${esc(g.home)}">${esc(g.name)}: other sections ▸</button>`).join("")}</div>` : ""}`;
      onChange();
    };
    host.onclick = async e => {
      const rm = e.target.closest("[data-rm]");
      if (rm) {
        const id = rm.dataset.rm, name = rm.parentNode.dataset.name;
        if (sel.size <= 1) return notice("Keep one", "Your list needs at least one feed. Add another before removing this one.");
        if (!await retroAsk({ title: "Remove feed", ok: "Remove", text: `Remove “${name}” from your feed?\n\nIts stories leave your list. You can add it back any time.` })) return;
        sel.delete(id); draw(); if (onRemoved) onRemoved(name);
        return;
      }
      const b = e.target.closest(".chip"); if (!b) return;
      if (b.dataset.more) return onMore(b.dataset.more);
      sel.has(b.dataset.id) ? sel.delete(b.dataset.id) : sel.add(b.dataset.id);
      draw();
    };
    draw();
    return { add: p => { if (!mine.some(x => x.id === p.id)) { mine.push(p); mine.sort(az); } sel.add(p.id); draw(); } };
  }
  // every list of outlets reads A to Z, ignoring a leading "The"
  const az = (a, b) => a.name.replace(/^the\s+/i, "").localeCompare(b.name.replace(/^the\s+/i, ""), undefined, { sensitivity: "base", numeric: true });
  const feedCount = n => `${n} feed${n === 1 ? "" : "s"}`;
  // Making an account is one screen: a name, an email and a password. There is nothing to pick and nothing to save: the reader
  // opens on the three starter outlets, and a tip says where to add more. Someone who came by a friend's link is told whose it is; the link is
  // kept on this device until the account is made, so leaving the page and coming back does not lose it. With accounts by invitation and
  // no link, the screen says so in place of the form.
  function openWelcome(invite) {
    closeSignOn();
    try { invite = invite || localStorage.getItem("rolodex.invite") || ""; } catch { invite = invite || ""; }
    const s = shell("Welcome", () => { wel.remove(); wel = null; });
    s.body.innerHTML = `<h2>Make your account</h2><p class="lead">Your own list of New York news, and a Gossip Column for sharing stories with friends.</p>
      <div class="k">Screen name</div><input type="text" id="w-name" autocomplete="username" maxlength="16" spellcheck="false" autocapitalize="off">
      <div class="k">Email, for password resets</div><input type="email" id="w-email" autocomplete="email" spellcheck="false">
      <div class="k">Password</div><input type="password" id="w-pw" autocomplete="new-password">
      <p class="lead" id="w-legal">By continuing you accept the ${LEGAL}.</p>`;
    api("/api/door", { method: "POST", body: { invite } }).then(r => {
      if (!r.ok || !wel) return;
      if (r.data.by) s.body.querySelector(".lead").textContent = `${r.data.by} invited you, and will be in your Gossip Column when you arrive.`;
      else if (r.data.invite_only) {
        s.body.querySelector(".lead").textContent = "Accounts are by invitation for now. Ask a friend who is already here for their link, and open it on this device.";
        s.body.querySelectorAll(".k, input, #w-legal").forEach(el => el.style.display = "none"); s.go.style.display = "none";
      }
    });
    s.go.textContent = "Create account";
    s.go.onclick = async () => {
      s.msg.textContent = "One moment…";
      const pw = $("#w-pw").value, k = pw.length >= 8 ? await makeKeys(pw) : null;   // the message key is made here, in the new person's browser
      const r = await api("/api/signup", { method: "POST", body: { screen_name: $("#w-name").value.trim(), email: $("#w-email").value.trim(), password: pw, invite, ...(k ? { keys: { pub: k.pub, enc_priv: k.enc_priv, enc_salt: k.enc_salt } } : {}) } });
      if (!r.ok) { s.msg.textContent = r.data.error || `Error ${r.status}`; return; }
      if (k && r.data.me.key_id) await holdKey(r.data.me.id, r.data.me.key_id, k.pkcs8);
      try { localStorage.removeItem("rolodex.invite"); } catch {}
      restart("tip");   // straight into the reader, on the three starter outlets
    };
    $("#w-name").focus();
  }
  async function openFeeds(add) {
    const r = await api("/api/pubs"); if (!r.ok) return;
    const sel = new Set(r.data.pubs);
    let dirty = false;   // something was saved while the window was open: reload on closing so the list behind it is current
    // One window, entered from two ends. Add to feed leads with the outlet lookup; Manage feed leads with the list you already have.
    const s = shell(add ? "Add to feed" : "Manage feed", () => { wel.remove(); wel = null; if (dirty) restart(); });
    const lookup = lead => `<div class="k">${lead}</div><div class="row2"><input type="text" id="fd-url" placeholder="e.g. NPR, or nytimes.com" spellcheck="false" autocapitalize="off"><button id="fd-go">Find feeds</button></div><div id="fd-found"></div>`;
    s.body.innerHTML = add
      ? `<h2>Add to feed</h2><p class="lead">Look an outlet up and choose from the feeds it offers. A new one brings its stories within a minute or so.</p>${lookup("Type an outlet's name or paste its site")}<div class="pick"></div>`
      : `<h2>Manage feed</h2><p class="lead">These are the feeds on your list. Tap one to take it off, then Save.</p><div class="pick"></div>${lookup("Add another: type an outlet's name or paste its site")}`;
    // The wizard: look the outlet up, list every feed it offers with a preview, add the ticked ones as sections of one publication.
    const find = async given => {
      const url = (typeof given === "string" ? given : $("#fd-url").value).trim(); if (!url) return;
      $("#fd-found").innerHTML = ""; s.msg.textContent = "Looking for its feeds…";
      const d = await api("/api/pubs/discover", { method: "POST", body: { url } });
      if (!d.ok) {
        s.msg.textContent = d.data.error || "Could not look that up.";
        // a name or a misspelling: offer the outlets the reader already knows that are close to it
        if (d.data.suggestions?.length) { $("#fd-found").innerHTML = `<div class="k">Did you mean</div><div class="chips">${d.data.suggestions.map(x => `<button class="chip" data-site="${esc(x.host)}">${esc(x.name)} · ${esc(x.host)}</button>`).join("")}</div>${d.data.suggestions.some(x => x.from) ? `<div class="lead">Addresses for outlets the reader has not seen before come from Wikipedia. Check the one you pick is right before adding its feeds.</div>` : ""}`;
          $("#fd-found").onclick = e => { const b = e.target.closest("[data-site]"); if (b) { $("#fd-url").value = b.dataset.site; $("#fd-found").onclick = null; find(b.dataset.site); } }; }
        return;
      }
      const { site, feeds, slots_left, found, partial } = d.data, fresh = feeds.filter(f => !f.mine);
      // an outlet that refuses lookups: say so, and say what still works (pasting a feed's own address)
      const blocked = partial ? `${site.host} does not let the reader look through its site, so this is only what the reader already follows from it. Know another of its feeds? Paste that feed's own address (it usually ends in .xml or /feed).` : "";
      if (!fresh.length) { $("#fd-found").innerHTML = blocked ? `<div class="note">${esc(blocked)}</div>` : ""; s.msg.textContent = feeds.length === 1 ? `${site.name}: the one feed found is already on your list.` : `Every feed found at ${site.host} is already on your list.`; return; }
      s.msg.textContent = "";
      const rate = f => f.perDay ? ` · about ${f.perDay >= 1 ? Math.round(f.perDay) : "under 1"} a day` : "";
      $("#fd-found").innerHTML = `${blocked ? `<div class="note">${esc(blocked)}</div>` : ""}<div class="k">${feeds.length === 1 ? `One feed at ${esc(site.host)}` : `${feeds.length} feeds at ${esc(site.host)}${found > feeds.length ? ` (the ${feeds.length} most likely of ${found})` : ""}`} · ${slots_left} feed slots left on the reader</div>
        <div class="note">You are adding <b>${esc(site.host)}</b>, which calls itself “${esc(site.name)}”. Check that is the outlet you meant: a misspelled address can belong to someone else.</div>
        ${feeds.map(f => `<label class="frow"><input type="checkbox" value="${esc(f.feed)}" ${f.mine ? "checked disabled" : f.suggested || feeds.length === 1 ? "checked" : ""}><span><b>${esc(f.title)}</b>${f.mine ? " <i>on your list</i>" : ""}<small>${esc(f.latest)}${rate(f)}</small></span></label>`).join("")}
        <div><button id="fd-add">Add ticked</button></div>`;
      $("#fd-add").onclick = async () => {
        const picked = [...document.querySelectorAll("#fd-found input:checked:not(:disabled)")].map(i => i.value);
        if (!picked.length) { s.msg.textContent = "Tick at least one."; return; }
        s.msg.textContent = "Adding…"; const a = await api("/api/pubs/sections", { method: "POST", body: { url, feeds: picked } });
        if (!a.ok) { s.msg.textContent = a.data.error || "Could not add those."; return; }
        a.data.added.forEach(p => pk.add(p)); $("#fd-found").innerHTML = ""; $("#fd-url").value = "";
        s.msg.textContent = `Added ${a.data.added.map(p => p.name).join(", ")}. Fetching their stories now.`;
      };
      $("#fd-found").scrollIntoView({ block: "nearest" });
    };
    const pk = await picker(s.body.querySelector(".pick"), sel, () => s.go.textContent = `Save ${feedCount(sel.size)}`, home => { $("#fd-url").value = home.replace(/^https?:\/\/(www\.)?/, ""); find(home); },
      async name => { const w = await api("/api/pubs", { method: "POST", body: { pubs: [...sel] } }); dirty = dirty || w.ok; s.msg.textContent = w.ok ? `Removed ${name}.` : w.data.error || "Could not save that."; });
    $("#fd-go").onclick = find; $("#fd-url").addEventListener("keydown", e => { if (e.key === "Enter") find(); });
    if (add && innerWidth > 700) $("#fd-url").focus();   // on a phone the keyboard waits to be asked for
    if (me.operator) operatorTools(s);
    s.go.onclick = async () => {
      if (!sel.size) { s.msg.textContent = "Keep at least one."; return; }
      s.msg.textContent = "Saving…"; const w = await api("/api/pubs", { method: "POST", body: { pubs: [...sel] } });
      if (!w.ok) { s.msg.textContent = w.data.error || "Could not save."; return; }
      restart();
    };
  }
  // Reporting a feed tells the operator, who can remove it. It is a safety valve for something that should not be here, not a rating.
  document.addEventListener("reader:report", async e => {
    if (!me) return openSignOn("Sign on to report a feed.");
    const note = await retroAsk({ title: "Report this feed", text: `Report “${e.detail.name}” to the person who runs this reader?\n\nSay briefly what is wrong with it (optional).`, input: true, ok: "Send report" }); if (note === null) return;
    const r = await api("/api/report", { method: "POST", body: { pub: e.detail.pub, note } });
    notice(r.ok ? "Reported" : "Not sent", r.ok ? "Thank you. The person who runs this reader will look at it. To stop seeing the feed now, remove it under Edit → Manage feed." : r.data.error || "That did not go through.");
  });
  // ---------- the operator's view (the account marked as running this reader) ----------
  // The same Your feeds window, with one more section: every feed on the reader, each opening to its name, label, color and place tags,
  // and a way to remove it for everyone. Removing asks for the password again.
  const INKS = ["#1a1a1a", "#8e2f2b", "#a8862a", "#3d6b4f", "#34507a", "#6a6762", "#b5542c", "#6a4a78", "#2f6468", "#86623a", "#4f7a2f", "#7a3f5a", "#3f6f7a", "#5c5a8a"];
  async function removeForEveryone(id, name) {
    const pw = await retroAsk({ title: "Remove for everyone", ok: "Remove feed", input: true, secret: true, text: `Remove “${name}” from the reader for every reader?\n\nIt leaves everyone's list and its stories stop being served. Type your password to confirm.` });
    if (pw === null) return false;
    const r = await api("/api/op/pub/remove", { method: "POST", body: { id, password: pw } });
    if (!r.ok) { notice("Not removed", r.data.error || "That did not go through."); return false; }
    return true;
  }
  async function operatorTools(s) {
    const pick = await api("/api/pubs/pick"); if (!pick.ok || !pick.data.operator) return;
    const label = p => p.section && p.section !== p.name ? `${p.name} · ${p.section}` : p.name;
    const all = pick.data.publications.sort((a, b) => az({ name: label(a) }, { name: label(b) }));
    s.body.insertAdjacentHTML("beforeend", `<div class="k">Operator · every feed on the reader (${all.length}). Tap one to edit it</div><div class="chips" id="op-list">${all.map(p => `<button class="chip boro" data-op="${esc(p.id)}">${esc(label(p))}${p.readers ? ` · ${p.readers}` : ""}</button>`).join("")}</div><div id="op-edit"></div>`);
    $("#op-list").onclick = e => {
      const b = e.target.closest("[data-op]"); if (!b) return; const p = all.find(x => x.id === b.dataset.op);
      $("#op-edit").innerHTML = `<div class="note"><b>${esc(label(p))}</b> · ${p.readers} ${p.readers === 1 ? "reader" : "readers"} · ${p.own ? "added by a reader" : "starter catalog"}<br><span style="font:300 10px var(--mono);word-break:break-all">${esc(p.feed)}</span></div>
        <div class="k">Name${p.group ? " (shared by this outlet's sections)" : ""}</div><input type="text" id="op-name" value="${esc(p.name)}" maxlength="40">
        ${p.group ? `<div class="k">Section</div><input type="text" id="op-section" value="${esc(p.section || "")}" maxlength="40">` : ""}
        <div class="k">Short label</div><input type="text" id="op-short" value="${esc(p.short)}" maxlength="10">
        <div class="k">Color</div><div class="chips" id="op-colors">${INKS.map(c => `<button class="swatch ${c.toLowerCase() === String(p.color).toLowerCase() ? "on" : ""}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join("")}</div>
        <div class="k">Place tags (NYC, a borough, a neighborhood, or National), separated by commas</div><input type="text" id="op-tags" value="${esc((p.tags || []).join(", "))}">
        <div class="row2" style="margin-top:6px"><button id="op-save">Save changes</button><span style="flex:1"></span><button id="op-remove">Remove for everyone</button></div>`;
      let color = p.color;
      $("#op-colors").onclick = ev => { const c = ev.target.closest("[data-color]"); if (!c) return; color = c.dataset.color; $("#op-colors").querySelectorAll(".swatch").forEach(x => x.classList.toggle("on", x === c)); };
      $("#op-save").onclick = async () => {
        const r = await api("/api/op/pub", { method: "POST", body: { id: p.id, name: $("#op-name").value, short: $("#op-short").value, color, tags: $("#op-tags").value, section: $("#op-section")?.value } });
        s.msg.textContent = r.ok ? "Saved. It shows after the next fetch." : r.data.error || "Could not save.";
      };
      $("#op-remove").onclick = async () => { if (await removeForEveryone(p.id, label(p))) restart(); };
      $("#op-edit").scrollIntoView({ block: "nearest" });
    };
  }
  async function openReports() {
    const r = await api("/api/op/reports"); if (!r.ok) return notice("Reports", r.data.error || "Could not load the reports.");
    const s = shell("Reports", () => { wel.remove(); wel = null; });
    s.go.textContent = "Close"; s.go.onclick = () => { wel.remove(); wel = null; };
    const draw = list => {
      s.body.innerHTML = `<h2>Reported feeds</h2><p class="lead">What readers have flagged. Dismiss a report that needs nothing, or remove the feed for everyone.</p>` +
        (list.length ? list.map(x => `<div class="note" data-rid="${x.id}"><b>${esc(x.name || x.target)}</b>${x.name ? "" : " (no longer on the reader)"}<br>${esc(x.note || "No note given.")}<br><span style="font:300 10px var(--mono)">${esc(x.reported_by)} · ${esc(x.created_at.slice(0, 16))}</span>
          <div class="row2" style="margin-top:6px"><button data-dismiss="${x.id}">Dismiss</button><span style="flex:1"></span>${x.name ? `<button data-remove="${esc(x.target)}" data-name="${esc(x.name)}">Remove for everyone</button>` : ""}</div></div>`).join("") : `<p>No feeds have been reported.</p>`);
    };
    let list = r.data.reports; draw(list);
    s.body.onclick = async e => {
      const d = e.target.closest("[data-dismiss]"), rm = e.target.closest("[data-remove]");
      if (d) { await api("/api/op/reports/dismiss", { method: "POST", body: { id: Number(d.dataset.dismiss) } }); list = list.filter(x => x.id !== Number(d.dataset.dismiss)); draw(list); }
      if (rm && await removeForEveryone(rm.dataset.remove, rm.dataset.name)) { list = list.filter(x => x.target !== rm.dataset.remove); draw(list); s.msg.textContent = "Removed."; }
    };
  }
  document.addEventListener("reader:reports", () => me && me.operator ? openReports() : null);
  document.addEventListener("reader:welcome", () => openWelcome());
  document.addEventListener("reader:feeds", e => me ? openFeeds(!!(e.detail && e.detail.add)) : openSignOn("Sign on to make your own list."));

  // ---------- my account ----------
  let acct = null;
  function openAccount(msg) {
    if (acct) { acct.remove(); acct = null; }
    acct = makeWindow("acct", "My Account", `
      <div class="sub">Signed on as <b>${esc(me.screen_name)}</b></div>
      <div class="k">Email <span class="sub" id="ac-state"></span></div>
      <div class="row"><input type="email" id="ac-email" autocomplete="email" spellcheck="false" placeholder="where password resets are sent"><button id="ac-email-go">Save</button></div>
      <div class="sub" id="ac-resend-row"><a class="lnk" id="ac-resend">Send the confirmation link again</a></div>
      <div class="k">Current password <span class="sub">(for any change below)</span></div>
      <div class="row"><input type="password" id="ac-cur" autocomplete="current-password"></div>
      <div class="k">New password</div>
      <div class="row"><input type="password" id="ac-new" autocomplete="new-password"><button id="ac-pw-go">Change</button></div>
      <div class="msg" id="ac-msg">${esc(msg || "")}</div>
      <div class="btns wrap"><button id="ac-export">Export my data</button><button id="ac-out">Sign out everywhere</button><button id="ac-del">Delete account</button></div>
      <div class="sub">What is stored and for how long: ${LEGAL}.</div>`, { left: "calc(50% - 160px)", top: "14%" });
    const say = t => $("#ac-msg").textContent = t, cur = () => $("#ac-cur").value;
    const paint = () => { $("#ac-email").value = me.email || ""; $("#ac-state").textContent = !me.email ? "(none yet: add one so a lost password can be reset)" : me.email_verified ? "(confirmed)" : "(not confirmed yet)"; $("#ac-resend-row").style.display = me.email && !me.email_verified ? "" : "none"; };
    const call = async (path, body, done) => { say("One moment…"); const r = await api(path, { method: "POST", body }); if (!r.ok) { say(r.data.error || `Error ${r.status}`); return; } done(r.data); };
    $("#ac-email-go").onclick = () => call("/api/email", { email: $("#ac-email").value.trim(), password: cur() }, d => { me = d.me; paint(); say(d.email_sent ? `Saved. A confirmation link is on its way to ${me.email}.` : "Saved, but the confirmation email could not be sent just now."); });
    $("#ac-resend").onclick = () => call("/api/email/resend", {}, d => say(d.email_sent ? "Sent. Check your inbox." : "It could not be sent just now."));
    // A new password means the message key is locked again with it. If the old lock opens (the current password is right), the same key is
    // kept and every message stays readable. If it cannot be opened, a new key is made and messages from
    // before can no longer be read.
    $("#ac-pw-go").onclick = async () => {
      const next = $("#ac-new").value; let extra = {}, fresh = null; say("One moment…");
      if (next.length >= 8) try { const mine = me.key_id ? await api("/api/keys/mine") : null; extra = { rekey: await relock(next, await unlock(cur(), mine.data)) }; }
        catch { fresh = await makeKeys(next); extra = { newkey: { pub: fresh.pub, enc_priv: fresh.enc_priv, enc_salt: fresh.enc_salt } }; }
      call("/api/password", { current: cur(), password: next, ...extra }, async d => {
        if (fresh && d.key_id) { me.key_id = d.key_id; await holdKey(me.id, d.key_id, fresh.pkcs8); }
        $("#ac-cur").value = $("#ac-new").value = ""; say(fresh && me.key_id ? "Password changed. Messages from before this change can no longer be opened; new ones are private as before." : "Password changed. Your other devices were signed out.");
      });
    };
    $("#ac-out").onclick = () => call("/api/logout-all", {}, async () => { await dropKey(me.id); restart("msg:Signed out on every device."); });
    $("#ac-export").onclick = async () => {
      say("Preparing…"); const r = await fetch("/api/export", { credentials: "same-origin" }); if (!r.ok) { say("Could not export."); return; }
      const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `retro-newsreader-${me.screen_name}.json`; a.click(); URL.revokeObjectURL(a.href); say("Downloaded.");
    };
    $("#ac-del").onclick = async () => {
      const yes = await retroAsk({ title: "Delete account", ok: "Delete my account", text: "Delete your account?\n\nYour friends list, your sessions, your saved stories and every message you sent are removed. Messages other people sent you stay with them, under “deleted user”. This cannot be undone." });
      if (yes) call("/api/account/delete", { password: cur() }, async () => { await dropKey(me.id); restart("msg:Your account is deleted."); });
    };
    acct.querySelector(".x").onclick = () => { acct.remove(); acct = null; };
    paint();
  }

  // ---------- the Gossip Column: a panel, not a window ----------
  // The friends list takes the story list's place and a conversation takes the story's (markup and styles are in index.html).
  // `.window` carries the state: `gossip` (the panel is open), `talking` (a friend is picked; on a phone, the conversation screen),
  // `gstory` (a story opened from a card is showing, with a back button to the conversation).
  const W = $(".window"), phone = () => innerWidth <= 700;
  let seenAt = "", blocks = [];   // the server's clock at the last poll (for hearing about deleted messages); the people you have blocked
  let cur = null, msgs = new Map(), target = null, removing = false;   // whose conversation is loaded, its messages by id, the story or comment the next message answers
  const friend = id => buddies.find(b => b.id === id && b.status === "accepted");
  const stamp = iso => new Date(iso.replace(" ", "T") + "Z");
  const rowWhen = d => d.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");   // as the story list writes a date
  const put = (el, html) => { if (el._html !== html) el.innerHTML = el._html = html; };   // a poll that changes nothing redraws nothing, so a tap in progress keeps its target
  // A conversation is live when it is the thing on screen: what arrives then is read as it lands; otherwise it waits as a red dot.
  const live = () => !!cur && W.classList.contains("gossip") && !W.classList.contains("gstory") && !document.hidden && (!phone() || W.classList.contains("talking"));
  const retitle = () => {};   // the title bar is the nameplate and nothing else; it does not change with the panel
  // The list pane is shared by the stories and the friends. When one is swapped for the other the pane must be still: arriving by a swipe,
  // it is usually mid-scroll or mid-bounce (a sideways swipe always moves a little up or down), and swapping its contents then leaves the
  // friends table hanging below a gap. So its motion is stopped (overflow off for a frame) and it is put where it belongs.
  let feedTop = 0;
  // (plain timers, not animation frames: those do not run in a tab that is not showing, and the pane must never be left unable to scroll)
  const settle = top => { const l = $("#list"); l.style.overflow = "hidden"; l.scrollTop = top; setTimeout(() => { l.style.overflow = ""; l.scrollTop = top; }, 40); setTimeout(() => { l.style.overflow = ""; l.scrollTop = top; }, 160); };
  const pressed = on => { $("#menu-gossip").classList.toggle("on", on); $("#menu-gossip").setAttribute("aria-pressed", on); };
  // The toolbar's fourth slot: two figures, the count of unread messages beside them, and the whole of it in words for a screen reader.
  const gossipLabel = total => { const t = !me ? "Gossip Column: sign on to see your friends" : total ? `Gossip Column: ${total} unread ${total === 1 ? "message" : "messages"}` : "Gossip Column: your friends and what you have sent each other";
    $("#chat-n").textContent = total ? String(total) : ""; $("#menu-gossip").title = t; $("#menu-gossip").setAttribute("aria-label", t); };
  // The strip of gadgets above the panel (wide screens): New York's weather, your clock, and the clock of the friend you are talking to.
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } })();
  const clock = tz => { try { return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) }); } catch { return ""; } };
  const zoneCity = tz => (tz || "").split("/").pop().replace(/_/g, " ");
  let wx = null, wxAt = 0;
  // What each slot leads with. The clock is a real face: the hands are drawn for the hour and minute in that time zone.
  const hm = tz => { try { const p = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "numeric", hourCycle: "h23", ...(tz ? { timeZone: tz } : {}) }).formatToParts(new Date()); return [Number(p.find(x => x.type === "hour").value), Number(p.find(x => x.type === "minute").value)]; } catch { return [0, 0]; } };
  const face = tz => { const [h, m] = hm(tz), hand = (turn, len, w) => { const a = turn * 2 * Math.PI; return `<line x1="8" y1="8" x2="${(8 + len * Math.sin(a)).toFixed(2)}" y2="${(8 - len * Math.cos(a)).toFixed(2)}" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>`; };
    return `<svg class="face" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.2"/>${hand((h % 12 + m / 60) / 12, 3.4, 1.5)}${hand(m / 60, 5.3, 1)}</svg>`; };
  // the weather sign is a plain type glyph (the \uFE0E asks for the text form, not a colour emoji), chosen from the forecast's words
  const skySign = s => (/thunder/i.test(s) ? "⚡" : /snow|sleet|flurr|ice/i.test(s) ? "❄" : /rain|shower|drizzle/i.test(s) ? "☂" : /fog|haze|mist|smoke/i.test(s) ? "≋" : /cloud|overcast/i.test(s) ? "☁" : (h => h < 6 || h >= 19)(hm("America/New_York")[0]) ? "☾" : "☀") + "\uFE0E";
  function gadgets() {
    if (!me || !W.classList.contains("gossip")) return;
    const b = friend(cur), g = (icon, k, v, x) => `<span class="i">${icon}</span>${k ? `<span class="k">${esc(k.toUpperCase())}</span>` : ""}<b>${esc(v)}</b>${x ? `<span class="x">${esc(x)}</span>` : ""}`;
    put($("#gd-wx"), wx ? g(skySign(wx.sky), "", `${wx.temp}°${wx.unit}`, wx.sky) : ""); if (wx) $("#gd-wx").title = `New York now: ${wx.sky}, ${wx.temp}°${wx.unit}. From the National Weather Service.`;
    put($("#gd-you"), g(face(""), "", clock(), zoneCity(TZ)));
    put($("#gd-them"), b && b.tz && clock(b.tz) ? g(face(b.tz), b.screen_name, clock(b.tz), zoneCity(b.tz)) : "");
    $("#gs-pick").innerHTML = `${me.status && me.status.emoji ? esc(me.status.emoji) : `<i class="sdot ${lightOf(me.status && me.status.text, true)}"></i>`} ▾`;
    if (document.activeElement !== $("#gs-text")) $("#gs-text").value = me.status ? me.status.text : "";
    if (Date.now() - wxAt > 15 * 60e3) { wxAt = Date.now(); api("/api/weather").then(r => { if (r.ok) { wx = r.data; gadgets(); } }); }
  }
  setInterval(gadgets, 10000);
  // The status box: an emoji and a line for friends to see, like an away message. Empty means none: friends then see Active or Away.
  // The button opens a menu of ready statuses and a grid of emoji; the box beside it takes your own words and saves on Enter or on leaving it.
  // "Active" stores nothing: friends then see Active while you have the reader open and Away when you do not.
  // the light that goes with a status: the ready-made ones each have their own; anything else is green while the person is here
  const lightOf = (text, online) => !online ? "away" : /^away$/i.test(text || "") ? "away" : /^busy$/i.test(text || "") ? "busy" : /^be right back$/i.test(text || "") ? "brb" : "active";
  const moodOf = b => b.mood ? `${b.mood.emoji} ${b.mood.text}`.trim() : b.online ? "Active" : "Away";
  async function saveStatus(change = {}) {
    const was = me.status || { emoji: "", text: "" }, { emoji, text } = { emoji: was.emoji, text: $("#gs-text").value.trim(), ...change };
    if (emoji === was.emoji && text === was.text) return;
    const r = await api("/api/status", { method: "POST", body: { emoji, text } });
    if (!r.ok) return R.status(r.data.error || "Your status was not saved.");
    me.status = r.data.status; R.status(me.status ? `Your friends now see: ${`${me.status.emoji} ${me.status.text}`.trim()}` : "Status cleared. Your friends see Active or Away."); gadgets();
  }
  $("#gs-text").addEventListener("change", () => saveStatus()); $("#gs-text").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
  $("#gs-emojis").innerHTML = ["🙂", "😂", "😍", "🤔", "😴", "😎", "🥳", "😭", "😡", "🤒", "☕", "🍕", "🍺", "🎧", "📚", "📰", "💻", "🎮", "🏃", "🚇", "✈️", "🏠", "🌧️", "❤️"].map(e => `<button data-emoji="${e}" aria-label="${e}">${e}</button>`).join("");
  // any emoji at all: the field brings up the keyboard, whose emoji key is the device's full list. The server keeps the first one typed.
  $("#gs-any").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
  $("#gs-any").addEventListener("change", e => { const v = e.target.value.trim(); e.target.value = ""; if (!v) return; R.closeMenus(); saveStatus({ emoji: v }); });
  $("#gs-menu").addEventListener("click", e => {
    const em = e.target.closest("[data-emoji]"), st = e.target.closest("[data-st]"); if (!em && !st) return;
    R.closeMenus(); if (st) $("#gs-text").value = st.dataset.st;
    saveStatus(em ? { emoji: em.dataset.emoji } : { text: st.dataset.st });
  });
  const blankConvo = () => { cur = null; msgs = new Map(); target = null; W.classList.remove("talking"); $("#convo").innerHTML = `<div class="blank">Select a friend</div>`; };

  async function openGossip(id) {
    if (!me) return;
    R.closeMenus();
    if (!await ready()) return R.status("Your messages stay locked until you type your password.");   // nothing in here can be read without the key
    await revealLasts();
    R.leaveTag();
    if (!W.classList.contains("gossip")) feedTop = $("#list").scrollTop;   // where the feed was, to go back to
    W.classList.add("gossip"); W.classList.remove("reading", "gstory", "talking"); pressed(true); settle(0);
    try { localStorage.setItem("rolodex.gossip", "1"); } catch {}   // it comes back after a reload only if it was left open
    if (!$("#g-msg").textContent) $("#g-msg").textContent = !me.email ? "Add an email in File → My Account so a lost password can be reset." : !me.email_verified ? "Confirm your email: the link is in your inbox (My Account sends it again)." : "";
    retitle(); renderFriends(); gadgets();
    if (id) openConvo(id); else if (cur && friend(cur) && !phone()) openConvo(cur);   // a phone opens on the friends screen
  }
  function closeGossip(quiet) {
    if (!W.classList.contains("gossip")) return;
    W.classList.remove("gossip", "talking", "gstory", "reading"); pressed(false); settle(feedTop);
    try { localStorage.removeItem("rolodex.gossip"); } catch {}
    if (quiet) return;
    const it = R.currentItem(); if (it) R.show(it.id);   // the story pane and the title bar go back to the feed's
  }
  function renderFriends() {
    const acc = buddies.filter(b => b.status === "accepted"), pin = buddies.filter(b => b.status === "pending_in"), pout = buddies.filter(b => b.status === "pending_out");
    // nothing pops open for a new message: the Gossip Column's button counts them and the friend's row carries the red dot
    const total = acc.reduce((n, b) => n + (b.unread || 0), 0);
    gossipLabel(total);
    if (!W.classList.contains("gossip")) return;
    $("#gossip-me").textContent = `${me.screen_name} · ${acc.length ? `${acc.filter(b => b.online).length} of ${acc.length} ${acc.length === 1 ? "friend" : "friends"} active` : "no friends yet"}`;   // active: has the reader open now
    // The list is conversations, not the whole friends list: a friend shows here while there has been gossip in the last 30 days (or
    // something unread, or their conversation is the one open). Everyone, with or without messages, is in the friends menu.
    // Newest gossip first, as the feed is newest first.
    const recent = b => b.unread || b.id === cur || (b.last && Date.now() - stamp(b.last.at) < 30 * 864e5);
    const order = acc.filter(recent).sort((a, b) => (b.last ? b.last.id : 0) - (a.last ? a.last.id : 0) || a.screen_name.localeCompare(b.screen_name, undefined, { sensitivity: "base" }));
    put($("#g-rows"), order.map(b => {
      const l = b.last, line = !l ? "No gossip yet" : (l.mine ? (l.story ? "You shared: " : "You: ") : (l.story ? "Shared: " : "")) + (l.story || l.text);
      return `<tr data-id="${b.id}" class="${b.unread ? "unread" : ""} ${cur === b.id ? "sel" : ""}"><td class="gdot" title="${esc(moodOf(b))}"><i class="${lightOf(b.mood && b.mood.text, b.online)}"></i></td><td class="t ico" colspan="2" title="${esc(moodOf(b) + " · " + line)}"><span class="hl">${esc(b.screen_name)}<span class="mood">${esc(moodOf(b))}</span></span><span class="sub">${l ? `<span class="when">${rowWhen(stamp(l.at))}</span> · ` : ""}${esc(line)}</span></td></tr>`;
    }).join("") || `<tr><td colspan="3" class="empty">${acc.length ? "No gossip in the last 30 days. All your friends are under the Friends button above: pick one to start." : "No friends here yet. Add or invite one from the Friends button above."}</td></tr>`);
    // The friends menu: every friend, under the groups you filed them in (A to Z), then the rest under "Friends". A heading folds its group
    // and says how many of it are active; a row opens that friend's conversation; Group moves them. Folded headings are kept in this browser.
    const groups = new Map(); for (const b of acc) { const g = b.group || ""; (groups.get(g) || groups.set(g, []).get(g)).push(b); }
    const names = [...groups.keys()].sort((x, y) => !x - !y || x.localeCompare(y, undefined, { sensitivity: "base" }));
    put($("#g-list"), names.map(g => { const list = groups.get(g), shut = gfolded.has(g), label = g || (names.length > 1 ? "Other friends" : "Friends");
      return `<div class="grow ghead" data-g="${esc(g)}" role="button" tabindex="0" aria-expanded="${!shut}"><span class="tw">${shut ? "▸" : "▾"}</span><span class="n">${esc(label)}</span><span class="c">${list.filter(b => b.online).length} of ${list.length} active</span></div>` +
        (shut ? "" : list.map(b => `<div class="grow gfr" data-open="${b.id}" role="button" tabindex="0" title="Open your conversation with ${esc(b.screen_name)}"><i class="sdot ${lightOf(b.mood && b.mood.text, b.online)}"></i><span class="n">${esc(b.screen_name)} <span class="mood">${esc(moodOf(b))}</span></span>${b.unread ? `<span class="gnew">${b.unread} new</span>` : ""}<button data-group="${b.id}" title="Move ${esc(b.screen_name)} to a group">Group</button></div>`).join("")); }).join(""));
    $("#g-n").textContent = pin.length ? ` ${pin.length}` : "";   // someone is waiting on you: the button says how many
    const who = (b, btns) => `<div class="grow"><span class="n">${esc(b.screen_name)}</span>${btns}</div>`;
    put($("#g-pending"), (pin.length ? `<div class="k">Want to join your column</div>` + pin.map(b => who(b, `<button data-acc="${b.id}">Accept</button><button data-rm="${b.id}">No</button><button data-block="${b.id}">Block</button>`)).join("") : "") +
      (pout.length ? `<div class="k">Waiting on</div>` + pout.map(b => who(b, `<button data-rm="${b.id}">Cancel</button>`)).join("") : ""));
    put($("#g-remove"), removing ? (acc.map(b => who(b, `<button data-drop="${b.id}">Remove</button><button data-block="${b.id}">Block</button>`)).join("") || `<div class="msg">No friends to remove.</div>`) +
      (blocks.length ? `<div class="k">Blocked</div>` + blocks.map(b => who(b, `<button data-unblock="${b.id}">Unblock</button>`)).join("") : "") : "");
    $("#g-drop").classList.toggle("on", removing);
  }
  const setBuddies = r => { if (r.ok) { buddies = r.data.buddies; if (cur && !friend(cur)) blankConvo(); renderFriends(); } return r.ok; };
  $("#gossip-back").onclick = () => closeGossip();
  $("#g-rows").onclick = e => { const tr = e.target.closest("tr[data-id]"); if (tr) openConvo(Number(tr.dataset.id)); };
  let gfolded = new Set(); try { gfolded = new Set(JSON.parse(localStorage.getItem("rolodex.gfold") || "[]")); } catch {}
  $("#g-foot").onclick = async e => {
    const d = e.target.dataset;
    // the friends list in the menu: Group moves a friend, a heading folds its group, a row opens the conversation
    const mv = e.target.closest("[data-group]"), head = e.target.closest("[data-g]"), row = e.target.closest("[data-open]");
    if (mv) {
      const b = friend(Number(mv.dataset.group)); if (!b) return;
      const mine = [...new Set(buddies.map(x => x.group).filter(Boolean))].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: "base" }));
      const name = await retroAsk({ title: "Group", input: true, ok: "Move", placeholder: b.group || "Family", text: `Which group for ${b.screen_name}?\n\n${mine.length ? `Your groups: ${mine.join(", ")}. Type one of them, or a new name.` : "Type a name, such as Family or Work, to start a group."} Leave it empty for no group.` });
      if (name === null) return;
      const r = await api("/api/buddies/group", { method: "POST", body: { id: b.id, group: name } });
      if (setBuddies(r)) { const now = friend(b.id); $("#g-msg").textContent = now && now.group ? `${b.screen_name} is now in ${now.group}.` : `${b.screen_name} is in no group.`; } else $("#g-msg").textContent = r.data.error || "Could not move them.";
      if (!$("#g-menu").classList.contains("on")) $("#g-menu-btn").click();   // the question closed the menu: show the result in it
      return;
    }
    if (head) { e.stopPropagation();   // the row is redrawn under the click: do not let that read as a click outside the menu
      const g = head.dataset.g; gfolded.has(g) ? gfolded.delete(g) : gfolded.add(g); try { localStorage.setItem("rolodex.gfold", JSON.stringify([...gfolded])); } catch {} return renderFriends(); }
    if (row) { R.closeMenus(); return openGossip(Number(row.dataset.open)); }
    if (d.acc) return setBuddies(await api("/api/buddies/accept", { method: "POST", body: { id: d.acc } }));
    if (d.rm) return setBuddies(await api("/api/buddies/remove", { method: "POST", body: { id: d.rm } }));
    if ("copy" in d) { try { await navigator.clipboard.writeText(inviteLink); e.target.textContent = "Copied"; } catch { e.target.textContent = "Press and hold the link"; } return; }
    if ("text" in d) { location.href = "sms:?&body=" + encodeURIComponent(`Join me on retronewsreader: ${inviteLink}`); return; }
    // Blocking ends the friendship (or refuses the request) and stops that person asking again. They are not told.
    if (d.block) {
      const b = buddies.find(x => x.id === Number(d.block)); if (!b) return;
      if (!await retroAsk({ title: "Block", ok: "Block", text: `Block ${b.screen_name}?\n\nThey leave your Gossip Column and cannot ask to join it again. They are not told. What you wrote to each other is kept, and you can unblock them here later.` })) return;
      if (setBuddies(await api("/api/blocks", { method: "POST", body: { id: b.id } }))) { $("#g-msg").textContent = `Blocked ${b.screen_name}.`; loadBlocks(); }
      return;
    }
    if (d.unblock) { const r = await api("/api/blocks/remove", { method: "POST", body: { id: Number(d.unblock) } }); if (r.ok) { $("#g-msg").textContent = "Unblocked. They can ask to join your column again."; loadBlocks(); } return; }
    if (!d.drop) return;
    const b = friend(Number(d.drop));
    if (!b || !await retroAsk({ title: "Remove friend", ok: "Remove", text: `Remove ${b.screen_name} from your Gossip Column?\n\nYou leave theirs too. What you wrote to each other is kept, and shows again if you add each other back.` })) return;
    if (setBuddies(await api("/api/buddies/remove", { method: "POST", body: { id: b.id } }))) $("#g-msg").textContent = `Removed ${b.screen_name}.`;
  };
  const addFriend = async () => { const n = $("#g-add").value.trim(); if (!n) return; const r = await api("/api/buddies", { method: "POST", body: { screen_name: n } }); $("#g-msg").textContent = r.ok ? `Request sent to ${n}.` : (r.data.error || "Could not add."); if (setBuddies(r)) $("#g-add").value = ""; };
  $("#g-add-go").onclick = addFriend; $("#g-add").addEventListener("keydown", e => { if (e.key === "Enter") addFriend(); });
  // An invite is one link per person: the same every time, and good for any number of friends. It is shown with two ways to hand it over
  // that need no typing: Copy puts it on the clipboard, and Text opens the phone's own Messages with the link already written (an sms:
  // address; the reader cannot send a text itself). Neither brings up the phone's share sheet. Whoever joins through it starts as a friend.
  let inviteLink = "";
  const invite = async () => {
    let refused = "";
    if (!inviteLink) { const r = await api("/api/invites", { method: "POST", body: {} }); if (r.ok) inviteLink = `${location.origin}/#invite=${r.data.code}`; else refused = r.data.error || "Could not make your link."; }
    $("#g-msg").innerHTML = inviteLink ? `<span class="inv">Your link. Send it to anyone you want here: whoever joins with it starts as your friend.<br><b>${esc(inviteLink)}</b></span><span class="gbtns"><button data-copy>Copy link</button><button data-text>Text it</button></span>` : `<span class="inv" style="color:var(--accent)">${esc(refused)}</span>`;
    if (!$("#g-menu").classList.contains("on")) $("#g-menu-btn").click();   // the link is shown in the friends menu: open it
  };
  $("#g-invite").onclick = () => invite();
  // Edit, while the Gossip Column is showing, is about friends: its three rows open the friends menu at the right place
  const friendsMenu = () => { R.closeMenus(); if (!$("#g-menu").classList.contains("on")) $("#g-menu-btn").click(); };
  $("#e-addfriend").onclick = () => { friendsMenu(); if (!phone()) $("#g-add").focus(); };
  $("#e-invite").onclick = () => { R.closeMenus(); invite(); };
  $("#e-remove").onclick = () => { friendsMenu(); if (!removing) $("#g-drop").click(); };
  const loadBlocks = async () => { const r = await api("/api/blocks"); if (r.ok) { blocks = r.data.blocked; renderFriends(); } };
  $("#g-drop").onclick = () => { removing = !removing; renderFriends(); if (removing) loadBlocks(); };

  // ---------- a conversation ----------
  // Strictly two people. The log is every message between them in time order; a shared story is a card, and what was said about it sits
  // under the card: comments (parent = the story message) and replies to a comment (parent = the comment). The one text box sends all three:
  // Comment and Reply only choose what the next message answers.
  function openConvo(id) {
    const b = friend(id); if (!b) return;
    W.classList.add("talking"); W.classList.remove("gstory", "reading"); retitle();
    if (cur === id && $("#cv-log")) { renderFriends(); return catchUp(); }   // already loaded: keep a half-written message
    cur = id; msgs = new Map(); target = null;
    $("#convo").innerHTML = `<div class="hdr"><button class="back" id="cv-back">‹ Friends</button><span class="who" id="cv-who"><i></i><span></span></span><span class="st" id="cv-st"></span></div>
      <div class="log sunken" id="cv-log"></div>
      <div class="compose"><div class="re" id="cv-re" style="display:none"><span></span><button aria-label="Cancel" title="Just a message instead">×</button></div>
        <div class="crow"><textarea id="cv-in" placeholder="Type a message. Enter sends."></textarea><button id="cv-send" class="default send">Send</button></div><div class="msg" id="cv-msg"></div></div>`;
    $("#cv-who span").textContent = b.screen_name; paintHead(); renderFriends(); gadgets();
    $("#cv-back").onclick = () => { W.classList.remove("talking"); renderFriends(); };
    $("#cv-re button").onclick = () => setTarget(null);
    $("#cv-send").onclick = send;
    $("#cv-in").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    $("#cv-log").onclick = e => {
      const open = e.target.closest(".card .open"), re = e.target.closest("[data-re]"), st = e.target.closest("p.story, .card"), dl = e.target.closest("[data-del]");
      if (dl) return removeMessage(Number(dl.dataset.del));
      if (re) return setTarget(Number(re.dataset.re));
      if (st && !open) { const id = Number(st.dataset.mid || st.dataset.fold); fold(id, !folded.has(id)); if (target === id || (msgs.get(target) || {}).parent === id) setTarget(null); return drawLog(); }
      if (!open) return;
      const c = open.closest(".card");
      if (!R.findItem(c.dataset.sid)) return R.companion(c.dataset.link);   // not in this reader's archive: the outlet's own page
      W.classList.add("gstory"); R.show(c.dataset.sid, false, true, { label: (friend(cur) || {}).screen_name || "Back", back: backToConvo });
    };
    api(`/api/messages?with=${id}`).then(async r => {
      if (cur !== id) return;
      if (!r.ok) { $("#cv-msg").textContent = r.data.error || "Could not load this conversation."; return; }
      await revealAll(r.data.messages); if (cur !== id) return;
      r.data.messages.forEach(m => msgs.set(m.id, m)); b.unread = 0;   // fetching a conversation marks it read
      drawLog(); $("#cv-log").scrollTop = $("#cv-log").scrollHeight; renderFriends();
    });
    if (!phone()) $("#cv-in").focus();   // on a phone the keyboard waits to be asked for
  }
  // Delete one of your own messages, for both of you. The server erases the text and the story; what was said under it stays.
  const erase = id => { const m = msgs.get(id); if (!m || m.deleted) return false; m.deleted = true; m.body = ""; m.story = null; if (target === id) setTarget(null); return true; };
  async function removeMessage(id) {
    const m = msgs.get(id); if (!m || m.from !== me.id) return;
    if (!await retroAsk({ title: m.story ? "Delete story" : "Delete message", ok: "Delete", text: (m.story ? "Take this story out of the conversation, for both of you?\n\nWhat was said under it stays." : "Delete this for both of you?") + " It cannot be brought back." })) return;
    const r = await api("/api/messages/delete", { method: "POST", body: { id } });
    if (!r.ok) { $("#cv-msg").textContent = r.data.error || "Not deleted."; return; }
    erase(id); drawLog();
  }
  function backToConvo() { W.classList.remove("gstory", "reading"); retitle(); catchUp(); }
  function paintHead() { const b = friend(cur); if (!b || !$("#cv-who")) return; $("#cv-who i").className = lightOf(b.mood && b.mood.text, b.online); $("#cv-st").textContent = (b.mood ? moodOf(b) : moodOf(b).toUpperCase()) + (phone() && b.tz && clock(b.tz) ? ` · ${clock(b.tz)} THERE` : ""); }   // a phone has no strip: their time goes here
  function setTarget(id) {
    const m = id && msgs.get(id); target = m ? id : null;
    $("#cv-re").style.display = m ? "" : "none"; if (!m) return;
    $("#cv-re span").textContent = m.story ? `Commenting on: ${m.story.title}` : `Replying to ${m.from === me.id ? "yourself" : (friend(cur) || {}).screen_name}: ${m.body}`;
    $("#cv-in").focus();
  }
  // A story folds. The card is the story's record and stays a card either way: open, it has its picture and the comments under it; folded,
  // it slims to one line (headline, outlet, how many comments) and the comments are put away. Tap the card, or the text sent with it, to
  // fold or open. Which stories are folded is remembered in this browser.
  let folded = new Set(); try { folded = new Set(JSON.parse(localStorage.getItem("rolodex.folded") || "[]")); } catch {}
  function fold(id, shut) { shut ? folded.add(id) : folded.delete(id); try { localStorage.setItem("rolodex.folded", JSON.stringify([...folded].slice(-500))); } catch {} }
  function drawLog() {
    const log = $("#cv-log"); if (!log) return;
    const all = [...msgs.values()].sort((a, b) => a.id - b.id), kids = new Map(), today = new Date().toDateString();
    const under = m => m.parent && msgs.has(m.parent);   // a comment whose story is gone (its sender left) reads as a plain line
    for (const m of all) if (under(m)) (kids.get(m.parent) || kids.set(m.parent, []).get(m.parent)).push(m);
    const name = m => m.from === me.id ? me.screen_name : (friend(cur) || {}).screen_name || "?";
    const time = d => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const dated = d => d.toDateString() === today ? time(d) : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + time(d);   // a comment can be days younger than its story
    // A deleted message leaves a faint marker only where something was said under it (so those comments keep their place); otherwise it is gone.
    const alive = m => !m.deleted || (kids.get(m.id) || []).some(alive);
    const del = m => m.from === me.id ? `<a class="act del" data-del="${m.id}">Delete</a>` : "";   // only your own
    const line = (m, t, more = "", cls = "") => m.deleted
      ? `<p class="gone ${cls}" data-mid="${m.id}"><span class="who">${esc(name(m))}</span> deleted this${m.kind === "article" ? " story" : ""}</p>`
      : m.locked ? `<p class="gone ${cls}" data-mid="${m.id}"><span class="who">${esc(name(m))}:</span> written before a password reset; it can no longer be opened here<span class="t">${t}</span></p>`
      : `<p class="${m.from === me.id ? "me" : ""} ${cls}" data-mid="${m.id}"><span class="who">${esc(name(m))}${m.story && !m.body ? "" : ":"}</span> ${m.story && !m.body ? "sent a story" : esc(m.body)}<span class="t">${t}</span>${more}${del(m)}</p>`;
    const thread = m => (kids.get(m.id) || []).filter(alive).map(c => line(c, dated(stamp(c.at)), `<a class="act" data-re="${c.id}">Reply</a>`) + (kids.get(c.id) || []).filter(r => !r.deleted).map(r => line(r, dated(stamp(r.at)), "", "rep")).join("")).join("");
    let day = "", html = "";
    for (const m of all) {
      if (under(m) || !alive(m)) continue;
      const d = stamp(m.at), key = d.toDateString();
      if (key !== day) { day = key; html += `<div class="day">${key === today ? "Today" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</div>`; }
      if (m.deleted) { html += line(m, "") + `<div class="thread">${thread(m)}</div>`; continue; }
      if (m.locked && m.kind === "article") { html += line(m, time(d)) + `<div class="thread">${thread(m)}</div>`; continue; }   // a story this account can no longer open: what was said under it stays   // a deleted story: its marker and what was said under it
      if (!m.story) { html += line(m, time(d)); continue; }
      const cs = (kids.get(m.id) || []).filter(alive), said = cs.reduce((n, c) => n + (c.deleted ? 0 : 1) + (kids.get(c.id) || []).filter(r => !r.deleted).length, 0), shut = folded.has(m.id);
      html += line(m, time(d), "", "story");
      html += `<div class="card ${shut ? "shut" : ""}" style="--pc:${esc(R.pubColor(m.story.pub) || "")}" data-sid="${esc(m.story.id)}" data-link="${esc(m.story.link)}" data-fold="${m.id}" title="${shut ? "Show" : "Hide"} what was said about this story"><span class="tw">${shut ? "▸" : "▾"}</span>${m.story.image && !shut ? `<img src="${esc(String(m.story.image).replace(/&amp;/g, "&"))}" alt="">` : ""}<div class="ct"><b>${esc(m.story.title)}</b><span>${esc(R.pubName(m.story.pub) || "")}${said ? ` · ${said} comment${said === 1 ? "" : "s"}` : ""}</span></div><button class="open">Open</button></div>`;
      if (shut) continue;
      html += `<div class="thread">${thread(m)}<a class="act" data-re="${m.id}">${cs.length ? "Add a comment" : "Comment"}</a></div>`;
    }
    log.innerHTML = html || `<div class="day">Nothing here yet. Say something, or share a story with Share</div>`;
  }
  // Bring one message into view inside the log (not scrollIntoView: on a phone that can drag the whole page with it).
  function reveal(id) {
    const log = $("#cv-log"), el = log && log.querySelector(`[data-mid="${id}"]`); if (!el) return;
    const z = parseFloat(document.documentElement.style.zoom) || 1, r = (el.nextElementSibling?.matches(".card") ? el.nextElementSibling.nextElementSibling : el).getBoundingClientRect(), t = el.getBoundingClientRect(), L = log.getBoundingClientRect();
    if (r.bottom > L.bottom) log.scrollTop += (r.bottom - L.bottom) / z + 8; else if (t.top < L.top) log.scrollTop -= (L.top - t.top) / z + 8;
  }
  function take(list) {
    const fresh = list.filter(m => !msgs.has(m.id)); if (!fresh.length || !$("#cv-log")) return;
    fresh.forEach(m => { msgs.set(m.id, m); const up = msgs.get(m.parent); if (up) { fold(up.id, false); if (up.parent) fold(up.parent, false); } });   // something new under a folded story opens it
    drawLog(); reveal(fresh[fresh.length - 1].id);
  }
  // What arrived while the conversation was out of sight is marked read (by fetching past the last message held) once it is back in view.
  async function catchUp() {
    const id = cur, b = friend(id); if (!b || !b.unread || !live()) return;
    b.unread = 0; renderFriends();
    const r = await api(`/api/messages?with=${id}&after=${Math.max(0, ...msgs.keys())}`);
    if (r.ok && cur === id) { await revealAll(r.data.messages); if (cur === id) take(r.data.messages); }
  }
  const lastOf = m => ({ id: m.id, at: m.at, mine: m.from === me.id, story: m.story ? m.story.title : null, text: m.body.slice(0, 120) });
  // a message of mine that the server took: into the log if that conversation is loaded, and onto the friend's row
  // Seal and send. What comes back is the stored (sealed) message; this browser already knows what it says.
  async function post(b, what, kind, parent) {
    const r = await api("/api/messages", { method: "POST", body: { to: b.id, enc: await sealFor(b, what), kind, k_from: myKey.id, k_to: b.key.id, ...(parent ? { parent } : {}) } });
    if (r.ok) Object.assign(r.data.message, { body: what.body || "", story: what.story || null, opened: true });
    return r;
  }
  function sent(m) { const b = buddies.find(x => x.id === m.to); if (b) b.last = lastOf(m); if (cur === m.to) take([m]); renderFriends(); }
  async function send() {
    const ta = $("#cv-in"), text = ta.value.trim(), id = cur; if (!text) return;
    ta.value = ""; $("#cv-msg").textContent = "";
    const b = friend(id), back = why => { $("#cv-msg").textContent = why; if (!ta.value) ta.value = text; };
    if (!b.key) return back(`${b.screen_name} has not opened the reader since messages became private. You can write to them once they have.`);
    const r = await post(b, { body: text }, "text", target);
    if (cur !== id) return;
    if (!r.ok) return back(r.data.error || "Not sent.");
    setTarget(null); sent(r.data.message);
  }

  // ---------- share a story with a buddy (the Share button) ----------
  async function openSendTo() {
    const it = R.currentItem(); if (!it) return;
    if (!await ready()) return R.status("Your messages stay locked until you type your password.");
    const acc = buddies.filter(b => b.status === "accepted");
    document.getElementById("sendto-menu")?.remove();
    const el = makeWindow("", "Share with a friend", `<div class="sub" style="margin-bottom:4px">${esc(it.title.slice(0, 80))}${it.title.length > 80 ? "…" : ""}</div>
      <div id="sendto-menu">${acc.map(b => `<div class="bud ${b.online ? "on" : ""}" data-id="${b.id}"><span class="dot"></span><span class="n">${esc(b.screen_name)}</span></div>`).join("") || `<div class="sub">No friends yet. Open the Gossip Column and add one.</div>`}</div>
      <div class="k">Say something with it (optional)</div><textarea id="st-note" style="height:44px"></textarea>`, { left: "calc(50% - 150px)", top: "22%" });
    el.querySelector(".x").onclick = () => el.remove();
    el.querySelector("#sendto-menu").onclick = async e => {
      const b = e.target.closest(".bud"); if (!b) return; const id = Number(b.dataset.id);
      const to = friend(id); if (!to || !to.key) { el.remove(); return notice("Not sent", `${(to || {}).screen_name || "They"} has not opened the reader since messages became private. You can share with them once they have.`); }
      const r = await post(to, { body: el.querySelector("#st-note").value.trim().slice(0, 2000), story: { id: String(it.id), title: String(it.title).slice(0, 300), link: String(it.link).slice(0, 500), pub: String(it.pub), image: it.image ? String(it.image).slice(0, 500) : null } }, "article");
      el.remove(); if (!r.ok) return notice("Not sent", r.data.error || "That did not go through.");
      // the story lands in that friend's conversation; you stay on what you were reading
      sent(r.data.message); R.status(`Shared with ${(friend(id) || {}).screen_name}. It is in your Gossip Column.`);
    };
  }

  // ---------- polling ----------
  async function poll() {
    if (!me) return;
    const r = await api(`/api/poll?since=${lastId}&tz=${encodeURIComponent(TZ)}&seen=${encodeURIComponent(seenAt)}`);
    if (r.status === 401) { restart("msg:Your session ended. Sign on again."); return; }
    if (!r.ok) return;
    buddies = r.data.buddies; lastId = Math.max(lastId, r.data.last || 0); if (r.data.me) me = r.data.me;
    if (myKey && myKey.id !== me.key_id) myKey = null;   // the key was changed somewhere else (a reset): this browser must be unlocked again
    await revealLasts();
    // Nothing opens by itself. A message for the loaded conversation joins its log; it is marked read only if that log is on screen.
    if (cur && !friend(cur)) blankConvo();
    seenAt = r.data.now || seenAt;
    if (cur && (r.data.gone || []).map(erase).some(Boolean)) drawLog();   // the other person deleted something that is on screen
    if (cur) { const mine = r.data.incoming.filter(m => m.from === cur); await revealAll(mine); take(mine); paintHead(); catchUp(); }
    gadgets();
    renderFriends();
  }
  function startPolling() { stopPolling(); const tick = () => { poll(); pollTimer = setTimeout(tick, document.hidden ? 20000 : 5000); }; tick(); }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  document.addEventListener("visibilitychange", () => { if (me && !document.hidden) poll(); });
  // On a phone the open panel is as tall as what shows above the keyboard. iOS may still slide the page up to meet a focused field: put it back.
  if (vv) vv.addEventListener("scroll", () => { if (W.classList.contains("gossip") && phone() && (scrollY || vv.offsetTop)) scrollTo(0, 0); });

  // ---------- state transitions ----------
  async function signedOn(user) {
    me = user; lastId = 0;
    await loadKey();   // the opened message key, if this browser has it from an earlier sign-on
    const r = await api("/api/poll?since=0"); if (r.ok) { buddies = r.data.buddies; lastId = r.data.last || 0; seenAt = r.data.now || ""; await revealLasts(); }
    menuBar(true);
    $("#sendto").style.display = ""; $("#sendto").disabled = !R.currentItem();
    renderFriends();   // the count on the Gossip Column's button
    // The Gossip Column does not open by itself. It reappears after a reload only if it was open before (and never on a phone, where it would cover the list).
    let wasOpen = false; try { wasOpen = localStorage.getItem("rolodex.gossip") === "1"; } catch {}
    if (wasOpen && !phone() && myKey) openGossip();   // not if it would have to ask for the password as the page loads
    startPolling();
  }
  async function signOff() { const uid = me && me.id; await api("/api/logout", { method: "POST" }); if (uid) await dropKey(uid); restart(); }   // this browser gives up its copy of the key; the messages themselves are untouched
  function signedOff(msg) {
    me = null; stopPolling(); buddies = [];
    W.classList.remove("gossip", "talking", "gstory"); pressed(false); blankConvo(); gossipLabel(0); if (acct) { acct.remove(); acct = null; }
    menuBar(false);
    $("#sendto").style.display = "none";
    if (msg) openSignOn(msg);
  }

  // ---------- wire the page ----------
  // The right end of the menu bar reads Sign On and ? when signed off, and ? alone once signed on (the Gossip Column is the toolbar's fourth slot);
  // and the account's own rows (My Account, Sign Off) sit under File while signed on; inviting a friend is in the Gossip Column (its friends button, and Edit)
  const menuBar = on => { document.querySelector(".menubar > .dd").style.display = on ? "" : "none";   // signed off, File has nothing in it: it is not shown
    $("#menu-signon").style.display = on ? "none" : ""; document.querySelectorAll(".menu .acct").forEach(el => el.style.display = on ? "" : "none"); };
  // Three ways out of the sign-on window: its ×, Sign On again, or a tap anywhere outside it. Escape works too.
  const closeSignOn = () => { if (signon) { signon.remove(); signon = null; } };
  $("#menu-signon").onclick = () => signon ? closeSignOn() : openSignOn();
  document.addEventListener("pointerdown", e => { if (signon && !e.target.closest(".aim, #menu-signon, #menu-gossip")) closeSignOn(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeSignOn(); });
  $("#c-signoff").onclick = signOff;
  // the toolbar's fourth slot opens the panel (and, pressed, goes back to the feed); signed off, it opens Sign On
  $("#menu-gossip").onclick = () => !me ? (signon ? closeSignOn() : openSignOn()) : W.classList.contains("gossip") ? closeGossip() : openGossip();
  document.addEventListener("reader:gossip", () => { if (me && !W.classList.contains("gossip")) openGossip(); });   // the swipe from right to left on the feed
  document.addEventListener("reader:leavegossip", () => closeGossip(true));
  $("#c-account").onclick = () => { R.closeMenus(); openAccount(); };
  $("#sendto").onclick = openSendTo;
  document.addEventListener("reader:selected", () => { if (me) $("#sendto").disabled = !R.currentItem(); R.syncActs(); });

  (async () => {
    const r = await api("/api/me");
    if (r.status === 404 || r.status === 501) { $("#sendto").style.display = "none"; $("#menu-gossip").style.display = "none"; return; }   // the Mac server has no chat: no Sign On, and the toolbar's fourth slot is not shown
    if (r.ok) await signedOn(r.data.me); else signedOff();
    // Links from email arrive as /#verify=… or /#reset=…: the fragment never reaches a server, and it is cleared from the address bar at once.
    const frag = new URLSearchParams(location.hash.slice(1)), verify = frag.get("verify"), reset = frag.get("reset"), invite = frag.get("invite");
    if (verify || reset || invite) history.replaceState(null, "", location.pathname);
    let after = ""; try { after = sessionStorage.getItem("rolodex.after") || ""; sessionStorage.removeItem("rolodex.after"); } catch {}
    if (invite && !me) { try { localStorage.setItem("rolodex.invite", invite); } catch {} openWelcome(invite); }
    if (after.startsWith("msg:") && !me) openSignOn(after.slice(4));
    if (after === "tip" && me) {
      const tip = document.createElement("div"); tip.className = "tipbar";
      const host = buddies.find(b => b.status === "accepted");   // whoever sent the invite is already a friend
      tip.innerHTML = `<span><b>You start with three citywide outlets.</b> Add your own under Edit → Add to feed: type any outlet's name or site.${host ? ` ${esc(host.screen_name)} invited you and is already in your Gossip Column.` : ""}</span><button>Got it</button>`;
      document.querySelector(".main").before(tip); tip.querySelector("button").onclick = () => tip.remove();
    }
    if (verify) { const v = await api("/api/email/verify", { method: "POST", body: { token: verify } }); if (v.ok && me) me.email_verified = true; notice(v.ok ? "Email confirmed" : "Link not valid", v.ok ? `${v.data.email} is confirmed. Password resets will be sent there.` : v.data.error || "That link did not work."); }
    if (reset) {
      const el = makeWindow("", "Choose a new password", `<div class="k">New password</div><div class="row"><input type="password" id="rs-pw" autocomplete="new-password"></div><div class="msg" id="rs-msg">At least 8 characters. Every device is signed out, and messages you had before can no longer be read.</div><div class="btns"><button class="default" id="rs-go">Change password</button></div>`, { left: "calc(50% - 150px)", top: "26%" });
      el.querySelector(".x").onclick = () => el.remove();
      const go = async () => { const v = await api("/api/password/reset", { method: "POST", body: { token: reset, password: $("#rs-pw").value } }); if (!v.ok) { $("#rs-msg").textContent = v.data.error || "That did not work."; return; } el.remove(); signedOff(); openSignOn("Password changed. Sign on with the new one.", v.data.screen_name); };
      $("#rs-go").onclick = go; $("#rs-pw").addEventListener("keydown", e => { if (e.key === "Enter") go(); }); $("#rs-pw").focus();
    }
  })();
})();
