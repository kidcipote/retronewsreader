// Accounts, buddies, instant messages and the comments under shared stories. Mounted at /api/* by worker.js. D1 binding: DB. KV binding: STORE (rate limits, lockout).
import { unitOf, headKey } from "./archive.js";
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const rand = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const LINE_SPACINGS = ["1.25", "1.45", "1.65"];   // View → Line spacing: Close, Medium, Open (the radio values in index.html)
const PBKDF2_ITER = 10000;   // kept modest on purpose: the free Workers plan meters CPU per request; raise to 100,000 on a paid plan

// The documented limits. Sign-up, invites, feed lookup and reset requests count in KV (fixed windows, approximate: KV reads can lag a minute);
// messages are counted from the messages table itself, which is exact and costs no KV write per message.
export const LIMITS = { signup_per_ip_hour: 5, forgot_per_ip_hour: 5, messages_per_user_minute: 30, probe_per_token_minute: 10, feed_adds_per_user_day: 20, feed_lookups_per_user_day: 40,
  operator_feed_adds_day: Infinity, operator_feed_lookups_day: Infinity };   // the operator is not counted (see `capped`); kept so the page's About text has a value
const lookupCap = u => LIMITS.feed_lookups_per_user_day, addCap = u => LIMITS.feed_adds_per_user_day;
// The operator (the account marked is_operator, the person who runs this reader) has no limits of their own: not on feeds added or looked
// up in a day, invites, messages a minute, or the size of the registry. `capped` wraps a counted limit and answers 0 (no wait) for them.
const capped = (user, env, ...rule) => user.is_operator ? 0 : limit(env, ...rule);
// Lists. Signed off, the page shows FRONT_PAGE (the same three ids are in app.js). Every publication anyone follows is fetched by the one
// scheduled run, which has about 50 outbound requests on the free plan, so the registry is capped.
export const FRONT_PAGE = ["gothamist", "thecity", "nyt"]; const REGISTRY_MAX = 1000;
// REGISTRY_MAX is a fuse, not a limit a reader should meet: it stops a fault or one account from running the registry (and the bills
// that follow it) up without end. The person who runs the reader is emailed as it fills, at each of these counts.
const REGISTRY_MARKS = [100, 250, 500, 750, 900, 1000];
function registryGrew(env, before, now, later) {
  const mark = REGISTRY_MARKS.filter(m => before < m && now >= m).pop(); if (!mark) return;
  later(sendMail(env, OPERATOR_MAIL, `retronewsreader now carries ${now} feeds`, `The reader has reached ${mark} feeds (${now} now) of the ${REGISTRY_MAX} it will take from readers.\n\nEach feed is fetched every half hour, written to storage when it changes, and its new stories tagged. File → Stories by publisher lists them all, with how many readers follow each.${mark >= REGISTRY_MAX ? "\n\nReaders can add no more until the limit (REGISTRY_MAX in cloud/social.js) is raised." : ""}`).catch(() => {}));
}
const INKS = ["#8e2f2b", "#a8862a", "#3d6b4f", "#34507a", "#b5542c", "#6a4a78", "#2f6468", "#86623a", "#4f7a2f", "#7a3f5a", "#3f6f7a", "#5c5a8a"];
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const pubFields = p => Object.fromEntries(["id", "name", "short", "color", "ink", "home", "feed"].map(k => [k, String(p[k] || "")]));
const registry = async env => { const cfg = JSON.parse(await env.STORE.get("config") || "{}"); cfg.publications ||= []; return cfg; };
// "Followed by your friends": a few feeds, not a friend's whole list. Of the feeds my accepted friends follow that I neither follow nor
// have followed, the ones most of them follow come first; ties fall in an order that is fixed for me and different for each reader (a
// hash of my id and the feed's), so nothing favours the top of the alphabet and the same few are shown every time. One per outlet, and
// FRIEND_PICKS at most. The limit is applied here, on the server: the rest are never sent.
const FRIEND_PICKS = 8;
async function friendPicks(env, user, cfg, mine, past) {
  const rows = (await env.DB.prepare(`SELECT p.pub_id, COUNT(*) AS n FROM user_pubs p JOIN buddies b ON b.status = 'accepted' AND ((b.a = ? AND b.b = p.user_id) OR (b.b = ? AND b.a = p.user_id)) GROUP BY p.pub_id`).bind(user.id, user.id).all()).results;
  const n = new Map(rows.map(r => [r.pub_id, r.n]));
  if (user.is_operator) return n;   // the operator sees every feed anyway
  const mix = id => { let h = 2166136261; for (const c of `${user.id}:${id}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h; };
  const picks = new Map(), outlets = new Set();
  for (const p of cfg.publications.filter(p => n.has(p.id) && !mine.has(p.id) && !past.has(p.id) && !FRONT_PAGE.includes(p.id)).sort((a, b) => n.get(b.id) - n.get(a.id) || mix(a.id) - mix(b.id))) {
    const outlet = p.group || p.id; if (outlets.has(outlet)) continue;
    outlets.add(outlet); picks.set(p.id, n.get(p.id)); if (picks.size >= FRIEND_PICKS) break;
  }
  for (const id of [...mine, ...past, ...FRONT_PAGE]) if (n.has(id)) picks.set(id, n.get(id));   // a feed I already see keeps its count of friends
  return picks;
}
const full = () => json({ error: `The reader cannot take a new outlet just now. The person who runs it has been told.` }, 409);
export async function myPubs(env, userId) { return (await env.DB.prepare("SELECT pub_id FROM user_pubs WHERE user_id = ? ORDER BY position, pub_id").bind(userId).all()).results.map(r => r.pub_id); }
async function setMyPubs(env, userId, ids) {
  await env.DB.batch([env.DB.prepare("DELETE FROM user_pubs WHERE user_id = ?").bind(userId), ...ids.map((id, i) => env.DB.prepare("INSERT INTO user_pubs (user_id, pub_id, position) VALUES (?, ?, ?)").bind(userId, id, i)),
    // and remembered: a feed later taken off the list can still be shown as one you had before
    env.DB.prepare("INSERT OR IGNORE INTO user_pubs_seen (user_id, pub_id) SELECT user_id, pub_id FROM user_pubs WHERE user_id = ?").bind(userId)]);
}
const LOCK_AFTER = 5, LOCK_AFTER_IP = 20;   // wrong passwords before the waits start: per screen name, per address
const MAIL_FROM = "My News Reader <reader@example.com>", MAIL_REPLY_TO = "reader@example.com";   // put an address on a domain you have verified with Resend
// Where the person who runs the reader is told of a new account. Never shown to a reader. (reader@retronewsreader.com forwards here too.)
const OPERATOR_MAIL = "you@example.com";   // where you are told of new accounts

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITER }, key, 256));
}
function cookie(name, value, maxAge) { return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
function readCookie(req, name) { const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)); return m ? m[1] : null; }
// A session is the same token either way: the page carries it in an HttpOnly cookie, a native client as `Authorization: Bearer`.
const sessionToken = req => (req.headers.get("Authorization") || "").match(/^Bearer ([0-9a-f]{64})$/)?.[1] || readCookie(req, "sid");
// Who may make an account: by invitation (a friend's link) unless the operator has opened sign-ups. One KV value, read at sign-up.
const inviteOnly = async env => (await env.STORE.get("signups")) !== "open";
const validName = s => /^[A-Za-z0-9_]{3,16}$/.test(s || "");
const validEmail = s => typeof s === "string" && s.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(s);
const ipOf = req => req.headers.get("CF-Connecting-IP") || "local";
const human = ms => ms < 90e3 ? `${Math.ceil(ms / 1000)} seconds` : `${Math.ceil(ms / 60e3)} minutes`;
const statusOf = u => u.status_emoji || u.status_text ? { emoji: u.status_emoji || "", text: u.status_text || "" } : null;   // null: none set, so Active or Away
const b64ok = (v, max) => typeof v === "string" && v.length >= 16 && v.length <= max && /^[A-Za-z0-9+/]+=*$/.test(v);
const goodKeys = k => !!k && b64ok(k.pub, 200) && b64ok(k.enc_priv, 600) && b64ok(k.enc_salt, 64);
const currentKey = (env, u) => u.key_id ? env.DB.prepare("SELECT id, pub, enc_priv, enc_salt FROM user_keys WHERE id = ? AND user_id = ?").bind(u.key_id, u.id).first() : null;
async function newKey(env, userId, k) {   // a fresh pair for this account: it becomes the current one, and any older private half is dropped
  const r = await env.DB.prepare("INSERT INTO user_keys (user_id, pub, enc_priv, enc_salt) VALUES (?, ?, ?, ?)").bind(userId, k.pub, k.enc_priv, k.enc_salt).run(), id = r.meta.last_row_id;
  await env.DB.batch([env.DB.prepare("UPDATE user_keys SET enc_priv = NULL, enc_salt = NULL WHERE user_id = ? AND id != ?").bind(userId, id), env.DB.prepare("UPDATE users SET key_id = ? WHERE id = ?").bind(id, userId)]);
  return id;
}
const shapeMe = u => ({ id: u.id, screen_name: u.screen_name, key_id: u.key_id || null, email: u.email || null, email_verified: !!u.email_verified_at, status: statusOf(u), ...(u.is_operator ? { operator: true } : {}) });

export const sessionUser = (req, env) => me(req, env);
async function me(req, env) {
  const sid = sessionToken(req); if (!sid) return null;
  const row = await env.DB.prepare("SELECT u.id, u.screen_name, u.email, u.email_verified_at, u.is_operator, u.tz, u.status_emoji, u.status_text, u.key_id, s.via, s.token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now') AND u.deleted_at IS NULL").bind(sid).first();
  return row || null;
}
async function startSession(env, userId, via = "password") {
  const token = rand(32);
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at, via) VALUES (?, ?, datetime('now', '+30 days'), ?)").bind(token, userId, via).run();
  return token;
}
// what a successful sign-in answers: the cookie always; the token in the body only for a client that asks to hold it itself
const signedIn = (u, token, wantsBearer, extra = {}) => json({ me: shapeMe(u), ...(wantsBearer ? { token } : {}), ...extra }, 200, { "Set-Cookie": cookie("sid", token, 2592000) });
async function body(req) { try { return await req.json(); } catch { return {}; } }
const pair = (x, y) => x < y ? [x, y] : [y, x];

// ---------- rate limits and lockout (KV) ----------
// Fixed window. Returns 0 when the call may go ahead, otherwise the seconds until the window clears. Fails open if KV is unavailable.
export async function limit(env, name, id, max, windowSec) {
  const t = Math.floor(Date.now() / 1000), slot = Math.floor(t / windowSec), key = `rl:${name}:${id}:${slot}`;
  try {
    const n = Number(await env.STORE.get(key) || 0);
    if (n >= max) return (slot + 1) * windowSec - t;
    await env.STORE.put(key, String(n + 1), { expirationTtl: Math.max(60, windowSec * 2) });
  } catch {}
  return 0;
}
// A wait of an hour or more is said as a clock time in the person's own zone ("after 8 p.m."), New York's when it is not known
const untilClock = (wait, tz) => {
  let zone = tz || "America/New_York"; try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { zone = "America/New_York"; }
  const at = new Date(Date.now() + wait * 1000), day = d => d.toLocaleDateString("en-CA", { timeZone: zone });
  const t = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone }).replace(/:00(?=\s)/, "").replace(/\s(AM|PM)$/, (_, x) => x === "AM" ? " a.m." : " p.m.");
  return `after ${t}${day(at) !== day(new Date()) ? " tomorrow" : ""}`;
};
const tooMany = (wait, tz) => json({ error: wait >= 3600 ? `Too many requests. Try again ${untilClock(wait, tz).replace(/\.$/, "")}.` : `Too many requests. Try again in ${human(wait * 1000)}.` }, 429, { "Retry-After": String(wait) });
// Escalating lockout: the first misses are free; from then on each one doubles the wait (30 s, 1 min, 2 min … up to an hour). A day without misses forgets them.
async function lockState(env, key) { try { return JSON.parse(await env.STORE.get(key) || "null") || { n: 0, until: 0 }; } catch { return { n: 0, until: 0 }; } }
async function recordFail(env, key, free) {
  const s = await lockState(env, key); s.n++;
  if (s.n >= free) s.until = Date.now() + Math.min(3600e3, 30e3 * 2 ** (s.n - free));
  try { await env.STORE.put(key, JSON.stringify(s), { expirationTtl: 86400 }); } catch {}
  return { tripped: s.n === free, until: s.until };
}

// ---------- email (Resend) ----------
// MAIL_LOG=1 (local testing) writes the message to the log instead of sending it.
async function sendMail(env, to, subject, text) {
  if (env.MAIL_LOG) { console.log(`[mail] to=${to} subject=${subject}\n${text}`); return true; }
  if (!env.RESEND_API_KEY) { console.log(`[mail] RESEND_API_KEY is not set; "${subject}" was not sent`); return false; }
  try {
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], reply_to: MAIL_REPLY_TO, subject, text }) });
    if (!r.ok) console.log(`[mail] Resend answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.ok;
  } catch (e) { console.log(`[mail] ${e.name}`); return false; }
}
async function mailToken(env, userId, kind, email, minutes) {
  const raw = rand(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_tokens WHERE user_id = ? AND kind = ?").bind(userId, kind),   // a new link retires the older ones
    env.DB.prepare(`INSERT INTO email_tokens (token_hash, user_id, kind, email, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+${Number(minutes)} minutes'))`).bind(await sha256(raw), userId, kind, email),
  ]);
  return raw;
}
// Marks the token used and returns its row, or null if it is unknown, expired or already spent. The UPDATE is the single-use guard.
async function spendToken(env, raw, kind) {
  if (!/^[0-9a-f]{64}$/.test(raw || "")) return null;
  const h = await sha256(raw);
  const r = await env.DB.prepare("UPDATE email_tokens SET used_at = datetime('now') WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > datetime('now')").bind(h, kind).run();
  if (!r.meta.changes) return null;
  return env.DB.prepare("SELECT user_id, email FROM email_tokens WHERE token_hash = ?").bind(h).first();
}
async function sendVerification(env, origin, user, email) {
  const raw = await mailToken(env, user.id, "verify", email, 60 * 24);
  return sendMail(env, email, "Confirm your email for retronewsreader",
    `Hello ${user.screen_name},\n\nConfirm that this address belongs to your retronewsreader account. It is what lets you reset a lost password.\n\n${origin}/#verify=${raw}\n\nThe link works once and expires in 24 hours. If you did not create this account, ignore this message.`);
}
// The link goes in the fragment, which browsers do not send to servers, so the token stays out of request logs.

export async function handleApi(req, env, path, ctx, h = {}) {
  const m = req.method, origin = new URL(req.url).origin, ip = ipOf(req);
  const later = p => ctx ? ctx.waitUntil(p) : p;
  // ---------- auth ----------
  if (path === "/api/signup" && m === "POST") {
    const { screen_name, password, invite, email: rawEmail, bearer, keys } = await body(req);
    const email = String(rawEmail || "").trim();
    if (!validName(screen_name)) return json({ error: "Screen name: 3 to 16 letters, numbers or underscores." }, 400);
    if (!password || password.length < 8) return json({ error: "Password: at least 8 characters." }, 400);
    if (!validEmail(email)) return json({ error: "Email: enter the address you want password resets sent to." }, 400);
    const wait = await limit(env, "signup", ip, LIMITS.signup_per_ip_hour, 3600); if (wait) return tooMany(wait);
    const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n;
    // an invite is a person's own link, good for any number of friends; without one, sign-up waits on the operator's switch
    const inv = await env.DB.prepare("SELECT code, created_by, source FROM invites WHERE code = ?").bind(String(invite || "").trim()).first();
    if (count > 0 && !inv && await inviteOnly(env)) return json({ error: "Accounts are by invitation for now. Open the link a friend sent you." }, 403);
    if (await env.DB.prepare("SELECT 1 FROM users WHERE screen_name = ?").bind(screen_name).first()) return json({ error: "That screen name is taken." }, 409);
    if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE").bind(email).first()) return json({ error: "That email already has an account. Use Forgot password to get back in." }, 409);
    const salt = rand(16), pw_hash = await hashPassword(password, salt);
    const r = await env.DB.prepare("INSERT INTO users (screen_name, pw_hash, pw_salt, last_seen, email) VALUES (?, ?, ?, ?, ?)").bind(screen_name, pw_hash, salt, now(), email).run();
    const id = r.meta.last_row_id, user = { id, screen_name, email };
    if (count === 0) await env.DB.prepare("UPDATE users SET is_operator = 1 WHERE id = ?").bind(id).run();   // the first account made on a new copy runs it
    if (goodKeys(keys)) user.key_id = await newKey(env, id, keys);   // made in the new person's browser, the private half locked with their password
    // Only a count is kept, never which account came through which link: on the link's owner, and on the link itself if it is a tagged one.
    if (inv?.created_by) await env.DB.batch([env.DB.prepare("UPDATE users SET joined_count = joined_count + 1 WHERE id = ?").bind(inv.created_by), ...(inv.source ? [env.DB.prepare("UPDATE invites SET joined = joined + 1 WHERE code = ?").bind(inv.code)] : [])]);
    // the person whose link it is and the person who used it start out as friends: nobody should have to look the other up
    if (inv?.created_by && await env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL").bind(inv.created_by).first()) {
      const [a, b] = pair(inv.created_by, id);
      await env.DB.prepare("INSERT OR IGNORE INTO buddies (a, b, requested_by, status) VALUES (?, ?, ?, 'accepted')").bind(a, b, inv.created_by).run();
    }
    const have = new Set((await registry(env)).publications.map(p => p.id));
    await setMyPubs(env, id, FRONT_PAGE.filter(x => have.has(x)));   // a new account starts on the front page; the welcome steps let them choose
    // a lost password is reset by email: there are no recovery codes
    const email_sent = await sendVerification(env, origin, user, email);
    // the person who runs the reader is told that an account was made: the screen name and nothing else
    later(sendMail(env, OPERATOR_MAIL, `New account: ${screen_name}${inv?.source ? ` (${inv.source})` : ""}`, `${screen_name} made an account on retronewsreader${inv?.source ? `, through the ${inv.source} link` : ""}.`).catch(() => {}));
    return signedIn(user, await startSession(env, id), bearer === true, { email_sent });
  }
  if (path === "/api/login" && m === "POST") {
    const { screen_name, password, bearer } = await body(req);
    const ku = `fail:u:${String(screen_name || "").toLowerCase()}`, ki = `fail:ip:${ip}`;
    const [su, si] = await Promise.all([lockState(env, ku), lockState(env, ki)]);
    const locked = Math.max(su.until, si.until) - Date.now();
    if (locked > 0) return json({ error: `Too many attempts. Try again in ${human(locked)}.` }, 429, { "Retry-After": String(Math.ceil(locked / 1000)) });
    const u = await env.DB.prepare("SELECT id, screen_name, pw_hash, pw_salt, email, email_verified_at, is_operator, key_id FROM users WHERE screen_name = ? AND deleted_at IS NULL").bind(screen_name || "").first();
    const ok = (await hashPassword(password || "", u?.pw_salt || "0".repeat(32))) === u?.pw_hash;   // hash even for an unknown name, so both cost the same
    if (!ok) {
      const f = await recordFail(env, ku, LOCK_AFTER); await recordFail(env, ki, LOCK_AFTER_IP);
      if (f.tripped && u?.email && u.email_verified_at) later(sendMail(env, u.email, "Sign-in attempts on your retronewsreader account",
        `Hello ${u.screen_name},\n\nSomeone entered the wrong password for your account ${LOCK_AFTER} times in a row, so sign-in is paused for a short while and the pause grows with each further miss.\n\nIf that was you, wait and try again, or use Forgot password on the sign-on window. If it was not you, your password has not been guessed; no action is needed.`));
      return json({ error: "Wrong screen name or password." }, 401);
    }
    try { await env.STORE.delete(ku); } catch {}
    await env.DB.prepare("UPDATE users SET last_seen = ? WHERE id = ?").bind(now(), u.id).run();
    // with the session comes the locked private half of the message key, for the browser to open with the password just typed
    return signedIn(u, await startSession(env, u.id), bearer === true, { keys: await currentKey(env, u) });
  }
  if (path === "/api/logout" && m === "POST") {
    const sid = sessionToken(req); if (sid) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(sid).run();
    return json({ ok: true }, 200, { "Set-Cookie": cookie("sid", "", 0) });
  }
  // ---------- email links (no session needed: the link is the proof) ----------
  if (path === "/api/email/verify" && m === "POST") {
    const t = await spendToken(env, (await body(req)).token, "verify");
    if (!t) return json({ error: "That confirmation link is no longer valid. Ask for a new one from My Account." }, 400);
    const r = await env.DB.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ? AND email = ? COLLATE NOCASE").bind(t.user_id, t.email).run();
    return r.meta.changes ? json({ ok: true, email: t.email }) : json({ error: "The address on this account changed after that link was sent." }, 400);
  }
  if (path === "/api/password/forgot" && m === "POST") {
    const email = String((await body(req)).email || "").trim();
    const wait = await limit(env, "forgot", ip, LIMITS.forgot_per_ip_hour, 3600); if (wait) return tooMany(wait);
    // Answer first, look up afterwards: the reply is the same body after the same work whether or not the address has an account.
    later((async () => {
      if (!validEmail(email)) return;
      const u = await env.DB.prepare("SELECT id, screen_name, email FROM users WHERE email = ? COLLATE NOCASE AND email_verified_at IS NOT NULL AND deleted_at IS NULL").bind(email).first();
      if (!u || await limit(env, "forgot-to", u.id, 3, 3600)) return;
      const raw = await mailToken(env, u.id, "reset", u.email, 15);
      await sendMail(env, u.email, "Reset your retronewsreader password",
        `Hello ${u.screen_name},\n\nUse this link to choose a new password. It works once and expires in 15 minutes.\n\n${origin}/#reset=${raw}\n\nIf you did not ask for this, ignore this message; your password stays as it is.`);
    })());
    return json({ ok: true, message: "If that address has a confirmed account, a reset link is on its way. It expires in 15 minutes." });
  }
  if (path === "/api/password/reset" && m === "POST") {
    const { token, password } = await body(req);
    if (!password || password.length < 8) return json({ error: "Password: at least 8 characters." }, 400);
    const t = await spendToken(env, token, "reset");
    if (!t) return json({ error: "That reset link is no longer valid. Links work once and expire after 15 minutes." }, 400);
    const u = await env.DB.prepare("SELECT screen_name FROM users WHERE id = ? AND deleted_at IS NULL").bind(t.user_id).first();
    if (!u) return json({ error: "That account no longer exists." }, 400);
    const salt = rand(16);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?").bind(await hashPassword(password, salt), salt, t.user_id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(t.user_id),   // a reset signs every device out
      // and gives up the message key: it was locked with the forgotten password, so nothing can open it. Messages from before the reset can
      // no longer be read by this person. A new key is made at the next sign-on.
      env.DB.prepare("UPDATE user_keys SET enc_priv = NULL, enc_salt = NULL WHERE user_id = ?").bind(t.user_id),
      env.DB.prepare("UPDATE users SET key_id = NULL WHERE id = ?").bind(t.user_id),
    ]);
    try { await env.STORE.delete(`fail:u:${u.screen_name.toLowerCase()}`); } catch {}
    return json({ ok: true, screen_name: u.screen_name });
  }

  const user = await me(req, env);
  // Asked by the page before anyone is signed on: are accounts by invitation, and whose link is this.
  if (path === "/api/door" && m === "POST") {
    const code = String((await body(req)).invite || "").trim();
    const by = code ? await env.DB.prepare("SELECT u.screen_name FROM invites i JOIN users u ON u.id = i.created_by WHERE i.code = ? AND u.deleted_at IS NULL").bind(code).first() : null;
    return json({ invite_only: await inviteOnly(env), by: by ? by.screen_name : null });
  }
  if (path === "/api/me" && m === "GET") return user ? json({ me: shapeMe(user) }) : json({ me: null }, 401);
  if (!user) return json({ error: "sign on first" }, 401);
  // Sensitive changes ask for the password again.
  const confirmPassword = async pw => {
    const u = await env.DB.prepare("SELECT pw_hash, pw_salt FROM users WHERE id = ?").bind(user.id).first();
    return (await hashPassword(pw || "", u.pw_salt)) === u.pw_hash;
  };
  const wrongPassword = () => json({ error: "Enter your current password to do that." }, 403);

  // ---------- account ----------
  if (path === "/api/email" && m === "POST") {
    const { email: rawEmail, password } = await body(req), email = String(rawEmail || "").trim();
    if (!validEmail(email)) return json({ error: "That does not look like an email address." }, 400);
    if (user.email && !await confirmPassword(password)) return wrongPassword();   // the first address on an older account needs no password
    if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?").bind(email, user.id).first()) return json({ error: "That email is on another account." }, 409);
    await env.DB.prepare("UPDATE users SET email = ?, email_verified_at = NULL WHERE id = ?").bind(email, user.id).run();
    const email_sent = await sendVerification(env, origin, user, email);
    return json({ me: shapeMe({ ...user, email, email_verified_at: null }), email_sent });
  }
  if (path === "/api/email/resend" && m === "POST") {
    if (!user.email) return json({ error: "Add an email address first." }, 400);
    if (user.email_verified_at) return json({ error: "That address is already confirmed." }, 400);
    const wait = await limit(env, "verify-to", user.id, 3, 3600); if (wait) return tooMany(wait, user.tz);
    return json({ email_sent: await sendVerification(env, origin, user, user.email) });
  }
  if (path === "/api/password" && m === "POST") {
    // The message key is locked with the password, so a new password comes with the key locked again (`rekey`, same pair) or, when the old
    // lock could not be opened, with a new pair altogether (`newkey`).
    const { current, password, rekey, newkey } = await body(req);
    if (!password || password.length < 8) return json({ error: "Password: at least 8 characters." }, 400);
    if (!await confirmPassword(current)) return wrongPassword();
    const relock = rekey && b64ok(rekey.enc_priv, 600) && b64ok(rekey.enc_salt, 64);
    if (user.key_id && !relock && !goodKeys(newkey)) return json({ error: "Reload the page and try again: your message key has to be locked with the new password." }, 400);
    if (goodKeys(newkey) && !relock) user.key_id = await newKey(env, user.id, newkey);
    else if (relock && user.key_id) await env.DB.prepare("UPDATE user_keys SET enc_priv = ?, enc_salt = ? WHERE id = ? AND user_id = ?").bind(rekey.enc_priv, rekey.enc_salt, user.key_id, user.id).run();
    const salt = rand(16);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?").bind(await hashPassword(password, salt), salt, user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").bind(user.id, user.token),
      env.DB.prepare("UPDATE sessions SET via = 'password' WHERE token = ?").bind(user.token),
    ]);
    return json({ ok: true, key_id: user.key_id || null });
  }
  // The locked private half of my message key, for a browser that is signed on but does not hold it yet.
  if (path === "/api/keys/mine" && m === "GET") { const k = await currentKey(env, user); return k ? json(k) : json({ error: "No key yet." }, 404); }
  // An account from before messages were private makes its key here, once, proving the password it is locked with.
  if (path === "/api/keys" && m === "POST") {
    const b = await body(req);
    if (user.key_id) return json({ error: "This account already has a key." }, 409);
    if (!goodKeys(b)) return json({ error: "That key is not well formed." }, 400);
    if (!await confirmPassword(b.password)) return json({ error: "That is not your password." }, 403);
    return json({ id: await newKey(env, user.id, b) });
  }
  if (path === "/api/logout-all" && m === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run();
    return json({ ok: true }, 200, { "Set-Cookie": cookie("sid", "", 0) });
  }
  if (path === "/api/export" && m === "GET") {
    const names = new Map((await env.DB.prepare("SELECT id, screen_name FROM users").all()).results.map(u => [u.id, u.screen_name]));
    const profile = await env.DB.prepare("SELECT id, screen_name, email, email_verified_at, created_at, last_seen, tz AS time_zone, status_emoji, status_text FROM users WHERE id = ?").bind(user.id).first();
    const [buds, msgs, invs, sess] = await Promise.all([
      env.DB.prepare("SELECT a, b, requested_by, status, created_at, grp_a, grp_b FROM buddies WHERE a = ? OR b = ?").bind(user.id, user.id).all(),
      env.DB.prepare("SELECT id, from_id, to_id, kind, body, story, parent_id, created_at, read_at, deleted_at, enc FROM messages WHERE from_id = ? OR to_id = ? ORDER BY id").bind(user.id, user.id).all(),
      env.DB.prepare("SELECT code, created_at FROM invites WHERE created_by = ?").bind(user.id).all(),
      env.DB.prepare("SELECT created_at, expires_at, via FROM sessions WHERE user_id = ?").bind(user.id).all(),
    ]);
    return json({
      exported_at: new Date().toISOString(), profile,
      buddies: buds.results.map(r => ({ screen_name: names.get(r.a === user.id ? r.b : r.a), status: r.status, requested_by_me: r.requested_by === user.id, since: r.created_at, group: (r.a === user.id ? r.grp_a : r.grp_b) || null })),
      messages: msgs.results.map(r => ({ id: r.id, from: names.get(r.from_id), to: names.get(r.to_id), kind: r.kind, body: r.body, story: r.story ? JSON.parse(r.story) : null, in_reply_to: r.parent_id ?? null, ...(r.enc ? { sealed: true } : {}), sent_at: r.created_at, read: !!r.read_at, ...(r.deleted_at ? { deleted_at: r.deleted_at } : {}) })),
      publications: await myPubs(env, user.id),
      publications_had_before: (await env.DB.prepare("SELECT pub_id FROM user_pubs_seen WHERE user_id = ? AND pub_id NOT IN (SELECT pub_id FROM user_pubs WHERE user_id = ?)").bind(user.id, user.id).all()).results.map(r => r.pub_id),
      saved_stories: (await env.DB.prepare("SELECT item_id, snapshot, saved_at FROM user_saved WHERE user_id = ?").bind(user.id).all()).results.map(r => { let t = {}; try { t = JSON.parse(r.snapshot); } catch {} return { id: r.item_id, title: t.title, link: t.link, saved_at: r.saved_at }; }),
      read_story_ids: (await env.DB.prepare("SELECT item_id FROM user_read WHERE user_id = ?").bind(user.id).all()).results.map(r => r.item_id),
      filters: await env.DB.prepare("SELECT filters FROM user_filters WHERE user_id = ?").bind(user.id).first().then(r => { try { return r ? JSON.parse(r.filters) : null; } catch { return null; } }),
      invites: invs.results.map(r => ({ code: r.code, created_at: r.created_at })),
      blocked: (await env.DB.prepare("SELECT u.screen_name, b.created_at FROM blocks b JOIN users u ON u.id = b.blocked WHERE b.blocker = ?").bind(user.id).all()).results,
      sessions: sess.results,
    }, 200, { "Content-Disposition": `attachment; filename="retro-newsreader-${user.screen_name}.json"` });
  }
  if (path === "/api/account/delete" && m === "POST") {
    if (!await confirmPassword((await body(req)).password)) return wrongPassword();
    // Gone: sessions, buddies, codes, links, their invite link, every message they sent. Kept: messages other people sent them, which now
    // point at a nameless "deleted user" row with no password, email or activity left on it.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM buddies WHERE a = ? OR b = ?").bind(user.id, user.id),
      env.DB.prepare("DELETE FROM blocks WHERE blocker = ? OR blocked = ?").bind(user.id, user.id),
      env.DB.prepare("DELETE FROM user_pubs WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM user_pubs_seen WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM reports WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM user_saved WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM user_read WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM user_filters WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM email_tokens WHERE user_id = ?").bind(user.id),
      env.DB.prepare("DELETE FROM invites WHERE created_by = ?").bind(user.id),
      // what the other person wrote under one of these messages moves up to that message's own parent (a reply to the story, a comment to
      // the plain log); twice, because a reply can sit under a comment that sits under a story, all three going
      ...[0, 1].map(() => env.DB.prepare("UPDATE messages SET parent_id = (SELECT p.parent_id FROM messages p WHERE p.id = messages.parent_id) WHERE from_id != ? AND parent_id IN (SELECT id FROM messages WHERE from_id = ?)").bind(user.id, user.id)),
      env.DB.prepare("DELETE FROM messages WHERE from_id = ?").bind(user.id),
      env.DB.prepare("UPDATE users SET screen_name = 'deleted user ' || id, pw_hash = '', pw_salt = '', email = NULL, email_verified_at = NULL, last_seen = NULL, tz = NULL, status_emoji = NULL, status_text = NULL, joined_count = 0, deleted_at = datetime('now') WHERE id = ?").bind(user.id),
    ]);
    return json({ ok: true }, 200, { "Set-Cookie": cookie("sid", "", 0) });
  }

  // ---------- my saved and read stories (the same on every device) ----------
  if (path === "/api/state" && m === "GET") {
    const [sv, rd, fl] = await Promise.all([
      env.DB.prepare("SELECT item_id, snapshot FROM user_saved WHERE user_id = ?").bind(user.id).all(),
      env.DB.prepare("SELECT item_id FROM user_read WHERE user_id = ? ORDER BY rowid DESC LIMIT 5000").bind(user.id).all(),
      env.DB.prepare("SELECT filters FROM user_filters WHERE user_id = ?").bind(user.id).first()]);
    const saved = {}; for (const r of sv.results) try { saved[r.item_id] = JSON.parse(r.snapshot); } catch {}
    let filters = null; try { filters = fl ? JSON.parse(fl.filters) : null; } catch {}   // null: this account has never set a filter
    return json({ uid: user.id, saved, read: rd.results.map(r => r.item_id), filters });
  }
  if (path === "/api/state" && m === "POST") {
    const b = await body(req), ids = a => (Array.isArray(a) ? a : []).map(String).filter(x => x && x.length <= 120), st = [];
    for (const it of (Array.isArray(b.save) ? b.save : []).slice(0, 50)) {
      const snap = JSON.stringify(it?.snap || null); if (!it?.id || snap.length < 10 || snap.length > 400000) continue;
      st.push(env.DB.prepare("INSERT OR REPLACE INTO user_saved (user_id, item_id, snapshot) VALUES (?, ?, ?)").bind(user.id, String(it.id).slice(0, 120), snap));
    }
    for (const id of ids(b.unsave).slice(0, 500)) st.push(env.DB.prepare("DELETE FROM user_saved WHERE user_id = ? AND item_id = ?").bind(user.id, id));
    for (const id of ids(b.read).slice(0, 3000)) st.push(env.DB.prepare("INSERT OR IGNORE INTO user_read (user_id, item_id) VALUES (?, ?)").bind(user.id, id));
    for (const id of ids(b.unread).slice(0, 3000)) st.push(env.DB.prepare("DELETE FROM user_read WHERE user_id = ? AND item_id = ?").bind(user.id, id));
    // The read list is the newest 5,000 (what /api/state returns), in the order they were marked; no time is kept, and older marks are let go.
    if (ids(b.read).length) st.push(env.DB.prepare("DELETE FROM user_read WHERE user_id = ? AND rowid NOT IN (SELECT rowid FROM user_read WHERE user_id = ? ORDER BY rowid DESC LIMIT 5000)").bind(user.id, user.id));
    if (b.filters && typeof b.filters === "object") {
      // the Filter menu as a whole, replaced each time: names only, bounded
      const names = a => (Array.isArray(a) ? a : []).map(String).filter(x => x && x.length <= 80).slice(0, 200);
      // View's tastes ride in the same record: paper, line spacing, and the two tick boxes. Each is checked against what the menu offers.
      const v = b.filters.view && typeof b.filters.view === "object" ? b.filters.view : null;
      const view = v ? { paper: ["white", "sepia", "night"].includes(v.paper) ? v.paper : "white", lh: LINE_SPACINGS.includes(String(v.lh)) ? String(v.lh) : LINE_SPACINGS[0], tint: v.tint === true } : undefined;
      st.push(env.DB.prepare("INSERT OR REPLACE INTO user_filters (user_id, filters) VALUES (?, ?)").bind(user.id, JSON.stringify({ off: names(b.filters.off), places: names(b.filters.places), topics: names(b.filters.topics), langs: names(b.filters.langs), days: [0, 1, 3, 7, 30].includes(b.filters.days) ? b.filters.days : null, unread: b.filters.unread === true, ...(view ? { view } : {}) })));
    }
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    return json({ ok: true, applied: st.length });
  }

  // ---------- my publications ----------
  if (path === "/api/pubs" && m === "GET") return json({ pubs: await myPubs(env, user.id), operator: !!user.is_operator });
  if (path === "/api/pubs/pick" && m === "GET") {
    // What the picker may show me: the three front-page feeds, my own feeds, and a few of the feeds my buddies follow (friendPicks).
    // Any other feed on the reader, whoever added it, is not listed: a list is its owner's, and friends are the one way feeds travel.
    const cfg = await registry(env), mine = new Set(await myPubs(env, user.id));
    // feeds that were on my list before and are not now: still mine to see, so they can be put back
    const past = new Set((await env.DB.prepare("SELECT pub_id FROM user_pubs_seen WHERE user_id = ?").bind(user.id).all()).results.map(r => r.pub_id).filter(id => !mine.has(id)));
    const buddies = await friendPicks(env, user, cfg, mine, past);
    // Only the order goes to the page, never how many friends follow a feed: with a small circle a count points at a person. `friend` marks a
    // feed my friends follow; `rank` is its place in the list (most followed first, ties in the order fixed for me).
    const ranked = [...buddies].sort((a, b) => b[1] - a[1] || 0).map(([id]) => id);
    const tops = new Map(((JSON.parse(await env.STORE.get("meta") || "null") || {}).publications || []).map(p => [p.id, p.top]));   // what each feed mostly covers (a fact about the feed)
    // the operator is shown every feed, with the fields they can edit
    const op = !!user.is_operator, followers = op ? new Map((await env.DB.prepare("SELECT pub_id, COUNT(*) AS n FROM user_pubs GROUP BY pub_id").all()).results.map(r => [r.pub_id, r.n])) : null;
    return json({ mine: [...mine], past: cfg.publications.filter(p => past.has(p.id)).map(p => p.id), operator: op, publications: cfg.publications.filter(p => op || FRONT_PAGE.includes(p.id) || mine.has(p.id) || past.has(p.id) || buddies.has(p.id))
      .map(p => ({ ...pubFields(p), group: p.group, section: p.section, own: !!p.unvetted, friend: buddies.has(p.id), rank: ranked.indexOf(p.id), ...(buddies.has(p.id) && tops.get(p.id)?.length ? { top: tops.get(p.id) } : {}), ...(op ? { tags: p.tags || [], readers: followers.get(p.id) || 0 } : {}) })) });
  }
  if (path === "/api/report" && m === "POST") {
    const { pub, note } = await body(req), id = String(pub || "").slice(0, 60); if (!id) return json({ error: "Nothing to report." }, 400);
    const wait = await limit(env, "report", user.id, 10, 86400); if (wait) return tooMany(wait, user.tz);
    await env.DB.prepare("INSERT INTO reports (user_id, kind, target, note) VALUES (?, 'feed', ?, ?)").bind(user.id, id, String(note || "").slice(0, 500)).run();
    return json({ ok: true });
  }
  if (path === "/api/pubs" && m === "POST") {
    // Replace my list. An id may be one already fetched, or a catalog outlet nobody follows yet, which joins the registry here.
    const sent = (await body(req)).pubs, want = [...new Set((Array.isArray(sent) ? sent : []).map(String))].slice(0, 300);
    const cfg = await registry(env), byId = new Map(cfg.publications.map(p => [p.id, p])), byFeed = new Map(cfg.publications.map(p => [p.feed, p]));
    const ids = [], add = [];
    for (const id of want) {
      if (byId.has(id)) { ids.push(id); continue; }
      const c = (h.catalog || []).find(c => c.id === id); if (!c) continue;
      if (byFeed.has(c.feed)) { ids.push(byFeed.get(c.feed).id); continue; }
      add.push({ ...pubFields(c), tags: Array.isArray(c.tags) ? c.tags : [] }); ids.push(c.id);
    }
    if (!ids.length) return json({ error: "Keep at least one publication." }, 400);
    if (add.length) {
      if (!user.is_operator && cfg.publications.length + add.length > REGISTRY_MAX) return full();
      cfg.publications.push(...add); await env.STORE.put("config", JSON.stringify(cfg)); registryGrew(env, cfg.publications.length - add.length, cfg.publications.length, later);
      h.fetchNow?.(add.map(p => p.id));
    }
    await setMyPubs(env, user.id, [...new Set(ids)]);
    return json({ pubs: await myPubs(env, user.id), added: add.length });
  }
  if (path === "/api/pubs/discover" && m === "POST") {
    // The wizard's first step: every feed an outlet offers, ranked, each with a preview. Adds nothing.
    const url = String((await body(req)).url || "").trim(); if (!url) return json({ error: "Paste a site or feed address." }, 400);
    // A name ("New York Timed") or a misspelled address is answered from what the reader already knows, never by guessing at an address:
    // a guessed address can belong to someone else entirely.
    // Of the feeds on the reader, a name is only matched against the ones this person may already see (the front page, their own, past and
    // friends' feeds), so a suggestion never gives away what a stranger follows. The catalog file is public and is matched in full.
    const cfgK = await registry(env), mineK = new Set(await myPubs(env, user.id)), pastK = new Set((await env.DB.prepare("SELECT pub_id FROM user_pubs_seen WHERE user_id = ?").bind(user.id).all()).results.map(r => r.pub_id));
    const seeable = user.is_operator ? null : new Set([...FRONT_PAGE, ...mineK, ...pastK, ...(await friendPicks(env, user, cfgK, mineK, pastK)).keys()]);
    const norm = t => String(t || "").toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
    const grams = t => { const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
    const alike = (a, b) => { if (!a || !b) return 0; if (a === b) return 1; if (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a))) return 0.8; const A = grams(a), B = grams(b); let n = 0; for (const x of A) if (B.has(x)) n++; return A.size + B.size ? 2 * n / (A.size + B.size) : 0; };
    const suggest = q => {
      const words = q.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean), initials = words.map(w => w[0]).join(""), nq = norm(q), seen = new Set(), out = [];
      for (const p of [...cfgK.publications.filter(p => !seeable || seeable.has(p.id)), ...(h.catalog || [])]) {
        const host = hostOf(p.home), key = p.group || host; if (!host || seen.has(key)) continue;
        const score = Math.max(alike(nq, norm(p.name)), alike(nq, norm(host.split(".")[0])), words.length > 1 && initials === norm(p.name) ? 0.9 : 0);
        if (score >= 0.5) { seen.add(key); out.push({ name: p.name, host: /\.(substack|beehiiv|ghost)\./.test(host) ? host : h.siteOf(host), score }); }   // a newsletter's address is its whole subdomain
      }
      return out.sort((a, b) => b.score - a.score).slice(0, 4).map(({ name, host }) => ({ name, host }));
    };
    const bare = url.replace(/^https?:\/\//i, "");
    if (/\s/.test(bare) || !/^[^/]+\.[a-z]{2,}(\/|$)/i.test(bare)) {
      // outlets the reader already knows come first; then, for a name it has never seen, what Wikipedia and Wikidata say its site is
      const known = suggest(bare); let web = [];
      // (skipped when the name is exactly an outlet already known)
      if (bare.length >= 3 && !known.some(k => norm(k.name) === norm(bare))) { const w = await capped(user, env, "lookup", user.id, lookupCap(user), 86400); if (!w) web = (await h.resolveName(bare, env)).filter(x => !known.some(k => k.host === x.host)); }
      const suggestions = [...known, ...web].slice(0, 4);
      return json({ error: suggestions.length ? "That looks like a name. Is it one of these?" : "That looks like a name, and nothing close to it was found. Type the outlet's web address instead, like nytimes.com: look the outlet up in your browser and copy the address from there.", suggestions }, 400);
    }
    const wait = await capped(user, env, "lookup", user.id, lookupCap(user), 86400); if (wait) return tooMany(wait, user.tz);
    const found = await h.discover(url, env);
    if (found.error && /could not reach/.test(found.error)) return json({ error: "Could not reach that site. Check the spelling of the address.", suggestions: suggest(h.siteOf(bare.split("/")[0]).split(".")[0] || bare) }, 400);
    if (found.error) return json({ error: found.blocked
      ? "That outlet does not let the reader look through its site, so its feeds cannot be listed. If you know the address of one of its feeds, paste that instead: it usually ends in .xml or /feed, and is often linked from the outlet's own RSS page."
      : /could not reach/.test(found.error) ? "Could not reach that site. Check the address and try again."
      : `No feed found there (${found.error}). Not every outlet publishes one.` }, 400);
    const cfg = await registry(env), byFeed = new Map(cfg.publications.map(p => [p.feed, p.id])), mine = new Set(await myPubs(env, user.id));
    return json({ site: found.site, found: found.found, partial: !!found.partial, slots_left: user.is_operator ? 999 : Math.max(0, REGISTRY_MAX - cfg.publications.length),
      feeds: found.feeds.map(f => ({ ...f, id: byFeed.get(f.feed) || null, mine: mine.has(byFeed.get(f.feed)) })) });
  }
  if (path === "/api/pubs/sections" && m === "POST") {
    // The wizard's second step: add the ticked feeds as sections of one publication (one name, one color), and to my list.
    const b = await body(req), picked = (Array.isArray(b.feeds) ? b.feeds : []).slice(0, 8).map(f => String(f || ""));
    const found = await h.discover(String(b.url || ""), env); if (found.error) return json({ error: "Look the outlet up again first." }, 400);
    const chosen = found.feeds.filter(f => picked.includes(f.feed)); if (!chosen.length) return json({ error: "Tick at least one feed." }, 400);   // only feeds the lookup itself confirmed
    const wait = await capped(user, env, "addfeed", user.id, addCap(user), 86400); if (wait) return tooMany(wait, user.tz);
    const cfg = await registry(env), ids = [], fresh = [], group = found.site.host;
    const sibling = cfg.publications.find(p => p.group === group || hostOf(p.home).endsWith(group)), single = found.feeds.length === 1;
    const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 14);
    for (const f of chosen) {
      const ex = cfg.publications.find(p => p.feed === f.feed); if (ex) { ids.push(ex.id); continue; }
      if (!user.is_operator && cfg.publications.length >= REGISTRY_MAX) return full();
      const taken = new Set(cfg.publications.map(p => p.id)), name = sibling?.name || found.site.name;
      let id = single ? (slug(name) || "pub") : `${sibling ? sibling.id.split("-")[0] : slug(name) || "pub"}-${slug(f.title) || "feed"}`; while (taken.has(id)) id += "2";
      const short = sibling?.short || ((name.split(/\s+/).find(w => !/^(the|a|an|of|new)$/i.test(w)) || name).toUpperCase().replace(/[^A-Z0-9&]/g, "").slice(0, 10)) || "FEED";
      cfg.publications.push({ id, name, short, color: sibling?.color || INKS[cfg.publications.length % INKS.length], ink: sibling?.ink || "#ffffff", home: sibling?.home || found.site.home, feed: f.feed,
        ...(single ? {} : { group, section: f.title }), tags: f.nyc ? ["NYC"] : [], ...((h.catalog || []).some(c => c.feed === f.feed) ? {} : { unvetted: true }) });   // added by a reader: theirs, not part of the starter set
      ids.push(id); fresh.push(id);
    }
    await env.STORE.put("config", JSON.stringify(cfg)); registryGrew(env, cfg.publications.length - fresh.length, cfg.publications.length, later);
    h.fetchNow?.(fresh);
    const mine = await myPubs(env, user.id); await setMyPubs(env, user.id, [...new Set([...mine, ...ids])]);
    return json({ added: ids.map(id => { const p = cfg.publications.find(x => x.id === id); return { id, name: p.section ? `${p.name} · ${p.section}` : p.name }; }), pubs: await myPubs(env, user.id) });
  }
  if (path === "/api/pubs/add" && m === "POST") {
    // Paste any site or feed address: find its feed the way Manage publications does, add it to the registry if new, and to my list.
    const url = String((await body(req)).url || "").trim(); if (!url) return json({ error: "Paste a site or feed address." }, 400);
    const wait = await capped(user, env, "addfeed", user.id, addCap(user), 86400); if (wait) return tooMany(wait, user.tz);
    const found = await h.probe(url); if (found.error) return json({ error: `No feed found there (${found.error}).` }, 400);
    const cfg = await registry(env);
    let pub = cfg.publications.find(p => p.feed === found.feed || (hostOf(p.home) && hostOf(p.home) === hostOf(found.home)));
    if (!pub) {
      if (!user.is_operator && cfg.publications.length >= REGISTRY_MAX) return full();
      const c = (h.catalog || []).find(c => c.feed === found.feed), taken = new Set(cfg.publications.map(p => p.id));
      const name = (found.title || hostOf(found.home) || "New feed").slice(0, 40);
      let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "pub"; while (taken.has(id)) id += "2";
      const short = ((name.split(/\s+/).find(w => !/^(the|a|an|of|new)$/i.test(w)) || name).toUpperCase().replace(/[^A-Z0-9&]/g, "").slice(0, 10)) || "FEED";
      pub = c ? { ...pubFields(c), tags: c.tags || [] } : { id, name, short, color: INKS[cfg.publications.length % INKS.length], ink: "#ffffff", home: found.home, feed: found.feed, tags: [], unvetted: true };
      cfg.publications.push(pub); await env.STORE.put("config", JSON.stringify(cfg)); registryGrew(env, cfg.publications.length - 1, cfg.publications.length, later);
      h.fetchNow?.([pub.id]);
    }
    const mine = await myPubs(env, user.id); if (!mine.includes(pub.id)) await setMyPubs(env, user.id, [...mine, pub.id]);
    return json({ pub: { id: pub.id, name: pub.name }, pubs: await myPubs(env, user.id), items: found.items });
  }

  // ---------- the operator ----------
  // The operator is the account marked is_operator. These are the few things that change the reader for everyone: tidying an outlet's
  // name, color and place tags, removing a feed, reading reports, and running a fetch. Removing asks for the password again.
  if (path.startsWith("/api/op/")) {
    if (!user.is_operator) return json({ error: "That is for the person who runs this reader." }, 403);
    if (path === "/api/op/signups" && m === "POST") {   // the switch: open to anyone, or back to invitation only
      const open = (await body(req)).open === true;
      if (open) await env.STORE.put("signups", "open"); else await env.STORE.delete("signups");
      return json({ invite_only: !open });
    }
    // A link that got out: this person's link stops working, and the next time they press Invite a friend they are given a new one.
    // The friends it already brought in stay. It removes something, so it asks for the operator's password again.
    if (path === "/api/op/invite/reset" && m === "POST") {
      const b = await body(req);
      if (!await confirmPassword(b.password)) return wrongPassword();
      const who = await env.DB.prepare("SELECT id, screen_name FROM users WHERE screen_name = ? AND deleted_at IS NULL").bind(String(b.screen_name || "").trim()).first();
      if (!who) return json({ error: "No one has that screen name." }, 404);
      await env.DB.prepare("DELETE FROM invites WHERE created_by = ? AND source IS NULL").bind(who.id).run();   // a tagged link (one posted somewhere on purpose) is not theirs to lose
      return json({ ok: true, screen_name: who.screen_name });
    }
    if (path === "/api/op/reports" && m === "GET") {
      const names = new Map((await registry(env)).publications.map(p => [p.id, p.section ? `${p.name} · ${p.section}` : p.name]));
      const rows = (await env.DB.prepare("SELECT r.id, r.target, r.note, r.created_at, u.screen_name AS reported_by FROM reports r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 100").all()).results;
      return json({ reports: rows.map(r => ({ ...r, name: names.get(r.target) || null })) });
    }
    if (path === "/api/op/reports/dismiss" && m === "POST") { await env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(Number((await body(req)).id)).run(); return json({ ok: true }); }
    if (path === "/api/op/pub" && m === "POST") {
      const b = await body(req), cfg = await registry(env), p = cfg.publications.find(x => x.id === b.id); if (!p) return json({ error: "No such feed." }, 404);
      const name = String(b.name || "").trim().slice(0, 40), short = String(b.short || "").trim().toUpperCase().slice(0, 10), color = /^#[0-9a-f]{6}$/i.test(b.color || "") ? b.color : p.color;
      if (!name || !short) return json({ error: "A name and a short label are needed." }, 400);
      const n = parseInt(color.slice(1), 16), ink = ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 150 ? "#1c1c1c" : "#ffffff";
      for (const q of cfg.publications) if (q === p || (p.group && q.group === p.group)) Object.assign(q, { name, short, color, ink });   // an outlet's sections share a name and a color
      p.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || "").split(",")).map(t => String(t).trim()).filter(Boolean).slice(0, 12);
      if (p.group) p.section = String(b.section || p.section || "").trim().slice(0, 40) || p.section;
      await env.STORE.put("config", JSON.stringify(cfg));
      return json({ ok: true });
    }
    if (path === "/api/op/pub/remove" && m === "POST") {
      const b = await body(req); if (!await confirmPassword(b.password)) return wrongPassword();
      const cfg = await registry(env), i = cfg.publications.findIndex(x => x.id === b.id); if (i < 0) return json({ error: "No such feed." }, 404);
      const [gone] = cfg.publications.splice(i, 1);
      await env.STORE.put("config", JSON.stringify(cfg));
      await env.DB.batch([env.DB.prepare("DELETE FROM user_pubs WHERE pub_id = ?").bind(gone.id), env.DB.prepare("DELETE FROM reports WHERE target = ?").bind(gone.id)]);
      // Its stories leave the archive at the next fetch (`dropped` tells that run which outlet to tidy); taking it out of `meta` stops them being served now.
      try { const meta = JSON.parse(await env.STORE.get("meta") || "null"); if (meta?.publications) { meta.publications = meta.publications.filter(p => p.id !== gone.id); (meta.dropped ||= []).push({ id: gone.id, ...(gone.group ? { group: gone.group } : {}) }); await env.STORE.put("meta", JSON.stringify(meta)); } } catch {}
      try { await env.STORE.delete(`items:${gone.id}`); } catch {}   // (the old layout's piece, if it is still there)
      return json({ ok: true, removed: gone.id });
    }
    if (path === "/api/op/refresh" && m === "POST") return json(await h.refresh());
    // Stories by publisher: for every feed on the reader, when each stored story was published and how many people follow the feed.
    // Counts and times only; no story's text or headline leaves here. The dates are read straight out of the stored JSON, not parsed whole.
    // Tagged links: the invite links posted somewhere on purpose, each with how many accounts it has brought in. They are shown here and
    // nowhere else: Invite a friend only ever shows a person's ordinary link.
    if (path === "/api/op/links" && m === "GET") {
      const links = (await env.DB.prepare("SELECT i.source, i.code, u.screen_name AS owner, i.joined AS n FROM invites i JOIN users u ON u.id = i.created_by WHERE i.source IS NOT NULL ORDER BY i.source").all()).results;
      return json({ links });
    }
    // Top inviters: the ten people whose links have brought in the most accounts that still exist. Names and counts only.
    if (path === "/api/op/inviters" && m === "GET") {
      const rows = (await env.DB.prepare("SELECT screen_name, joined_count AS n FROM users WHERE joined_count > 0 AND deleted_at IS NULL ORDER BY n DESC, screen_name COLLATE NOCASE LIMIT 10").all()).results;
      const t = await env.DB.prepare("SELECT COUNT(*) AS accounts, COALESCE(SUM(joined_count), 0) AS invited FROM users WHERE deleted_at IS NULL").first();
      const sources = (await env.DB.prepare("SELECT source, SUM(joined) AS n FROM invites WHERE source IS NOT NULL AND joined > 0 GROUP BY source ORDER BY n DESC").all()).results;
      return json({ inviters: rows, accounts: t.accounts, invited: t.invited, sources });
    }
    // Synced stories: the operator's analysis store (story_records, migration 0019). POST adds or refreshes up to 20 stories the operator picked in the
    // Saved view, each kept whole; a story synced again is updated, never doubled. GET .csv is the same table as a file for a spreadsheet.
    if (path === "/api/op/records" && m === "POST") {
      const b = await body(req), list = (Array.isArray(b.stories) ? b.stories : []).filter(x => x && typeof x.id === "string" && x.id && x.id.length <= 120).slice(0, 20);
      if (!list.length) return json({ error: "No stories to sync." }, 400);
      const cut = (v, n) => v == null ? null : String(v).slice(0, n), js = v => v == null ? null : JSON.stringify(v).slice(0, 20000);
      const have = new Set((await env.DB.prepare(`SELECT id FROM story_records WHERE id IN (${list.map(() => "?").join(",")})`).bind(...list.map(x => x.id)).all()).results.map(r => r.id));
      const known = new Set(["id", "pub", "outlet", "section", "title", "link", "author", "date", "first_seen", "saved_at", "lang", "summary", "content", "image", "categories", "topics", "places"]);
      await env.DB.batch(list.map(x => env.DB.prepare(`INSERT INTO story_records (id, pub, outlet, section, title, link, author, published_at, first_seen, saved_at, language, summary, content, image, categories, topics, places, extra, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET pub = excluded.pub, outlet = excluded.outlet, section = excluded.section, title = excluded.title, link = excluded.link, author = excluded.author,
          published_at = excluded.published_at, first_seen = excluded.first_seen, saved_at = excluded.saved_at, language = excluded.language, summary = excluded.summary, content = excluded.content,
          image = excluded.image, categories = excluded.categories, topics = excluded.topics, places = excluded.places, extra = excluded.extra, user_id = excluded.user_id, updated_at = datetime('now')`)
        .bind(x.id, cut(x.pub, 120), cut(x.outlet, 200), cut(x.section, 200), cut(x.title, 1000), cut(x.link, 2000), cut(x.author, 500), cut(x.date, 40), cut(x.first_seen, 40), cut(x.saved_at, 40), cut(x.lang, 40),
          cut(x.summary, 4000), cut(x.content, 600000), cut(x.image, 2000), js(x.categories), js(x.topics), js(x.places), js(Object.fromEntries(Object.entries(x).filter(([k]) => !known.has(k)))), user.id)));
      const added = list.filter(x => !have.has(x.id)).length;
      return json({ ok: true, added, updated: list.length - added });
    }
    if (path === "/api/op/records.csv" && m === "GET") {
      const cols = ["id", "outlet", "section", "title", "author", "published_at", "saved_at", "language", "link", "summary", "text", "categories", "topics", "places", "image", "synced_at", "updated_at"];
      const rows = (await env.DB.prepare("SELECT id, outlet, section, title, author, published_at, saved_at, language, link, summary, content, categories, topics, places, image, synced_at, updated_at FROM story_records ORDER BY published_at DESC").all()).results;
      const plain = h => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim().slice(0, 45000);   // a spreadsheet cell holds 50,000 characters
      const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const csv = [cols.join(","), ...rows.map(r => cols.map(c => q(c === "text" ? plain(r.content) : r[c])).join(","))].join("\r\n");
      return new Response("\ufeff" + csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="synced-stories-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" } });
    }
    if (path === "/api/op/volume" && m === "GET") {
      const cfg = await registry(env), followers = new Map((await env.DB.prepare("SELECT pub_id, COUNT(*) AS n FROM user_pubs GROUP BY pub_id").all()).results.map(r => [r.pub_id, r.n]));
      // Each outlet's head keeps the times of its last 35 days of stories and the time of its newest ever, so this reads one value per outlet.
      const meta = JSON.parse(await env.STORE.get("meta") || "null"), heads = new Map();
      if (meta?.v === 2) await Promise.all([...new Set(cfg.publications.map(unitOf))].map(async u => { heads.set(u, JSON.parse(await env.STORE.get(headKey(u)) || "null")); }));
      const publications = await Promise.all(cfg.publications.map(async p => {
        let at = [];
        if (meta?.v === 2) { const h = heads.get(unitOf(p)); at = [...(h?.vol?.[p.id] || [])]; const last = h?.last?.[p.id]; if (last && !at.includes(last)) at.push(last); }
        else { const raw = await env.STORE.get(`items:${p.id}`) || ""; for (const d of raw.matchAll(/"date":"([^"]+)"/g)) { const t = Date.parse(d[1]); if (t) at.push(Math.floor(t / 1000)); } }
        return { id: p.id, name: p.name, section: p.section || "", color: p.color, followers: followers.get(p.id) || 0, at };
      }));
      return json({ publications });
    }
    return json({ error: "unknown endpoint" }, 404);
  }

  // ---------- my status (the away message) ----------
  // One emoji and a short line, shown to accepted friends. Sending both empty clears it, and friends see Active or Away again.
  if (path === "/api/status" && m === "POST") {
    const b = await body(req), wait = await limit(env, "status", user.id, 30, 3600); if (wait) return tooMany(wait, user.tz);
    const raw = String(b.emoji || "").trim(); let emoji = "";
    try { emoji = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(raw)][0]?.segment || ""; } catch { emoji = [...raw][0] || ""; }   // the first whole character, however many code points it is made of
    const text = String(b.text || "").replace(/\s+/g, " ").trim().slice(0, 80);
    await env.DB.prepare("UPDATE users SET status_emoji = ?, status_text = ? WHERE id = ?").bind(emoji.slice(0, 16) || null, text || null, user.id).run();
    return json({ status: statusOf({ status_emoji: emoji.slice(0, 16), status_text: text }) });
  }

  // ---------- the weather on the Gossip Column's strip ----------
  // New York's, for everyone: the National Weather Service's hourly forecast (public, no key), fetched by the Worker and kept for half an hour.
  // The weather service sees the Worker, never a reader. If it cannot be reached, the last copy is served.
  if (path === "/api/weather" && m === "GET") {
    let w = null; try { w = JSON.parse(await env.STORE.get("weather") || "null"); } catch {}
    if (!w || Date.now() - w.at > 30 * 60e3) {
      try {
        const r = await fetch("https://api.weather.gov/gridpoints/OKX/33,42/forecast/hourly", { headers: { "User-Agent": "(retronewsreader.com, reader@retronewsreader.com)", Accept: "application/geo+json" } });
        const p = r.ok ? (await r.json()).properties.periods[0] : null;
        if (p) { w = { at: Date.now(), temp: Number(p.temperature), unit: String(p.temperatureUnit).slice(0, 1), sky: String(p.shortForecast).slice(0, 40) }; await env.STORE.put("weather", JSON.stringify(w)); }
      } catch {}
    }
    return w ? json({ place: "New York", temp: w.temp, unit: w.unit, sky: w.sky }) : json({ error: "No weather just now." }, 502);
  }

  // ---------- invites ----------
  // An invite is one link per person: the same every time, and good for any number of friends. Whoever joins through it starts as that
  // person's friend. While accounts are by invitation it is also the only way in. Nothing is counted and nothing runs out.
  if (path === "/api/invites" && m === "POST") {
    const have = await env.DB.prepare("SELECT code FROM invites WHERE created_by = ? AND source IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(user.id).first();
    if (have) return json({ code: have.code });
    const code = rand(6);
    await env.DB.prepare("INSERT INTO invites (code, created_by) VALUES (?, ?)").bind(code, user.id).run();
    return json({ code });
  }

  // ---------- buddies ----------
  const buddyList = async () => {
    const rows = (await env.DB.prepare(`
      SELECT b.a, b.b, b.requested_by, b.status, b.grp_a, b.grp_b, u.id, u.screen_name, u.last_seen, u.tz, u.status_emoji, u.status_text, u.key_id, (SELECT pub FROM user_keys k WHERE k.id = u.key_id) AS key_pub,
             (SELECT COUNT(*) FROM messages mm WHERE mm.from_id = u.id AND mm.to_id = ? AND mm.read_at IS NULL AND mm.deleted_at IS NULL) AS unread
      FROM buddies b JOIN users u ON u.id = CASE WHEN b.a = ? THEN b.b ELSE b.a END
      WHERE b.a = ? OR b.b = ? ORDER BY u.screen_name COLLATE NOCASE`).bind(user.id, user.id, user.id, user.id).all()).results;
    // the newest message with each person, either way: what their row in the Gossip Column shows
    const lasts = new Map((await env.DB.prepare(`SELECT id, from_id, to_id, body, story, created_at, enc, k_from, k_to, (SELECT pub FROM user_keys k WHERE k.id = CASE WHEN messages.from_id = ? THEN messages.k_to ELSE messages.k_from END) AS other_pub FROM messages WHERE id IN
      (SELECT MAX(id) FROM messages WHERE (from_id = ? OR to_id = ?) AND deleted_at IS NULL GROUP BY CASE WHEN from_id = ? THEN to_id ELSE from_id END)`).bind(user.id, user.id, user.id, user.id).all()).results
      .map(l => { let title = null; try { title = l.story ? JSON.parse(l.story).title : null; } catch {} return [l.from_id === user.id ? l.to_id : l.from_id, l.enc
        ? { id: l.id, at: l.created_at, mine: l.from_id === user.id, enc: l.body, mk: l.from_id === user.id ? l.k_from : l.k_to, pub: l.other_pub }   // sealed: the browser opens it
        : { id: l.id, at: l.created_at, mine: l.from_id === user.id, story: title, text: l.body.slice(0, 120) }]; }));
    const cutoff = Date.now() - 150e3;
    return rows.map(r => ({ id: r.id, screen_name: r.screen_name, unread: r.unread, group: r.status === "accepted" ? (r.a === user.id ? r.grp_a : r.grp_b) || null : null, /* the group I filed them under; theirs for me is not sent */ last: r.status === "accepted" ? lasts.get(r.id) || null : null, tz: r.status === "accepted" ? r.tz || null : null, key: r.status === "accepted" && r.key_id ? { id: r.key_id, pub: r.key_pub } : null, mood: r.status === "accepted" ? statusOf(r) : null,   // their clock, for friends only
      status: r.status === "accepted" ? "accepted" : (r.requested_by === user.id ? "pending_out" : "pending_in"),
      online: !!r.last_seen && Date.parse(r.last_seen.replace(" ", "T") + "Z") > cutoff }));
  };
  if (path === "/api/buddies" && m === "GET") return json({ buddies: await buddyList() });
  if (path === "/api/buddies" && m === "POST") {
    const { screen_name } = await body(req);
    const other = await env.DB.prepare("SELECT id, screen_name FROM users WHERE screen_name = ? AND deleted_at IS NULL").bind(screen_name || "").first();
    if (!other) return json({ error: "No one has that screen name." }, 404);
    if (other.id === user.id) return json({ error: "That is you." }, 400);
    if (await env.DB.prepare("SELECT 1 FROM blocks WHERE blocker = ? AND blocked = ?").bind(user.id, other.id).first()) return json({ error: "You have blocked that person. Unblock them first." }, 409);
    // blocked by them: answer exactly as if the request went through, and do nothing. A blocked person is not told.
    if (await env.DB.prepare("SELECT 1 FROM blocks WHERE blocker = ? AND blocked = ?").bind(other.id, user.id).first()) return json({ buddies: await buddyList() });
    const [a, b] = pair(user.id, other.id);
    const ex = await env.DB.prepare("SELECT status, requested_by FROM buddies WHERE a = ? AND b = ?").bind(a, b).first();
    if (!ex) await env.DB.prepare("INSERT INTO buddies (a, b, requested_by) VALUES (?, ?, ?)").bind(a, b, user.id).run();
    else if (ex.status === "pending" && ex.requested_by !== user.id) await env.DB.prepare("UPDATE buddies SET status = 'accepted' WHERE a = ? AND b = ?").bind(a, b).run();
    return json({ buddies: await buddyList() });
  }
  if (path === "/api/buddies/accept" && m === "POST") {
    const { id } = await body(req); const [a, b] = pair(user.id, Number(id));
    await env.DB.prepare("UPDATE buddies SET status = 'accepted' WHERE a = ? AND b = ? AND requested_by != ?").bind(a, b, user.id).run();
    return json({ buddies: await buddyList() });
  }
  // File a friend under a group of my own naming, or (an empty name) under none. Only my side of the pair's row is written.
  if (path === "/api/buddies/group" && m === "POST") {
    const b0 = await body(req), other = Number(b0.id), [a, b] = pair(user.id, other), name = String(b0.group || "").replace(/\s+/g, " ").trim().slice(0, 24) || null;
    await env.DB.prepare(`UPDATE buddies SET ${a === user.id ? "grp_a" : "grp_b"} = ? WHERE a = ? AND b = ? AND status = 'accepted'`).bind(name, a, b).run();
    return json({ buddies: await buddyList() });
  }
  if (path === "/api/buddies/remove" && m === "POST") {
    const { id } = await body(req); const [a, b] = pair(user.id, Number(id));
    await env.DB.prepare("DELETE FROM buddies WHERE a = ? AND b = ?").bind(a, b).run();
    return json({ buddies: await buddyList() });
  }

  // ---------- messages ----------
  const isBuddy = async other => { const [a, b] = pair(user.id, other); return !!(await env.DB.prepare("SELECT 1 FROM buddies WHERE a = ? AND b = ? AND status = 'accepted'").bind(a, b).first()); };
  // A sealed message goes out as it is stored, with the two things the reader's browser needs to open it: which of its own keys it was
  // sealed for (mk) and the other person's public key at the time (pub). Messages from before sealing go out as plain text.
  const shape = (r, pubs) => r.enc
    ? { id: r.id, from: r.from_id, to: r.to_id, kind: r.kind, parent: r.parent_id ?? null, at: r.created_at, ...(r.deleted_at ? { deleted: true, body: "", story: null } : { enc: r.body, mk: r.from_id === user.id ? r.k_from : r.k_to, pub: pubs.get(r.from_id === user.id ? r.k_to : r.k_from) || null }) }
    : { id: r.id, from: r.from_id, to: r.to_id, kind: r.kind, body: r.body, story: r.story ? JSON.parse(r.story) : null, parent: r.parent_id ?? null, at: r.created_at, ...(r.deleted_at ? { deleted: true } : {}) };
  const shapeAll = async rows => {
    const ids = [...new Set(rows.flatMap(r => r.enc ? [r.k_from, r.k_to] : []).filter(Boolean))].slice(0, 90);
    const pubs = new Map(ids.length ? (await env.DB.prepare(`SELECT id, pub FROM user_keys WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results.map(k => [k.id, k.pub]) : []);
    return rows.map(r => shape(r, pubs));
  };
  const inConvo = "((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))", convo = other => [user.id, other, other, user.id];
  if (path === "/api/messages" && m === "GET") {
    const url = new URL(req.url), other = Number(url.searchParams.get("with")), after = Number(url.searchParams.get("after") || 0);
    if (!await isBuddy(other)) return json({ error: "That person is not on your Gossip Column." }, 403);
    const rows = (await env.DB.prepare(`SELECT * FROM messages WHERE ${inConvo} AND id > ? ORDER BY id DESC LIMIT 300`).bind(...convo(other), after).all()).results;
    // A thread stays whole however old its story is: a comment in this page brings the story (and comment) it answers, and a story
    // brought in that way brings the rest of what was said under it.
    const seen = new Set(rows.map(r => r.id)), take = list => list.filter(r => !seen.has(r.id) && seen.add(r.id) && rows.push(r));
    const more = async (col, ids) => ids.length ? (await env.DB.prepare(`SELECT * FROM messages WHERE ${col} IN (${ids.map(() => "?").join(",")}) AND ${inConvo}`).bind(...ids, ...convo(other)).all()).results : [];
    const older = [];
    for (let hop = 0; hop < 2; hop++) older.push(...take(await more("id", [...new Set(rows.map(r => r.parent_id).filter(p => p && !seen.has(p)))].slice(0, 90))));
    for (let hop = 0, from = older; hop < 2 && from.length; hop++) from = take(await more("parent_id", from.map(r => r.id).slice(0, 90)));
    rows.sort((a, b) => a.id - b.id);
    await env.DB.prepare("UPDATE messages SET read_at = '1' WHERE from_id = ? AND to_id = ? AND read_at IS NULL").bind(other, user.id).run();
    return json({ messages: await shapeAll(rows) });
  }
  if (path === "/api/messages" && m === "POST") {
    // A message arrives already sealed by the sender's browser: `enc` is the text and any story together, and the server cannot open it.
    // What the server still sees is who wrote to whom, when, whether it carries a story, and what it answers.
    const { to, enc, kind, parent, k_from, k_to } = await body(req);
    const other = Number(to);
    if (!await isBuddy(other)) return json({ error: "That person is not on your Gossip Column." }, 403);
    if (!b64ok(enc, 16000)) return json({ error: "Reload the page: messages are private now, and this copy of the reader is out of date." }, 400);
    const theirs = (await env.DB.prepare("SELECT key_id FROM users WHERE id = ?").bind(other).first())?.key_id;
    if (!user.key_id || Number(k_from) !== user.key_id || !theirs || Number(k_to) !== theirs) return json({ error: "A key changed. Reload the page and send it again." }, 409);
    const isStory = kind === "article";
    // A comment answers a shared story; a reply answers a comment. Both must be in this conversation, and nothing answers a reply.
    let parentId = null;
    if (parent != null) {
      if (isStory) return json({ error: "A comment is text." }, 400);
      const p = await env.DB.prepare(`SELECT id, kind, parent_id, deleted_at FROM messages WHERE id = ? AND ${inConvo}`).bind(Number(parent), ...convo(other)).first();
      if (!p) return json({ error: "That is not in this conversation." }, 400);
      if (p.deleted_at) return json({ error: "That was deleted." }, 400);
      if (p.parent_id == null && p.kind !== "article") return json({ error: "Comments go on a shared story." }, 400);
      if (p.parent_id != null) { const up = await env.DB.prepare("SELECT parent_id FROM messages WHERE id = ?").bind(p.parent_id).first(); if (!up || up.parent_id != null) return json({ error: "Replies go one level deep. Reply to the comment itself." }, 400); }
      parentId = p.id;
    }
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM messages WHERE from_id = ? AND created_at > datetime('now', '-60 seconds')").bind(user.id).first();
    if (!user.is_operator && recent.n >= LIMITS.messages_per_user_minute) return tooMany(Math.max(1, 60 - Math.floor((Date.now() - Date.parse(recent.first.replace(" ", "T") + "Z")) / 1000)));
    const r = await env.DB.prepare("INSERT INTO messages (from_id, to_id, kind, body, story, parent_id, enc, k_from, k_to) VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?)").bind(user.id, other, isStory ? "article" : "text", enc, parentId, user.key_id, theirs).run();
    const row = await env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(r.meta.last_row_id).first();
    return json({ message: (await shapeAll([row]))[0] });
  }
  if (path === "/api/poll" && m === "GET") {
    // the browser's time zone rides along with the poll: it is what a friend's clock in the Gossip Column is set by
    const zone = new URL(req.url).searchParams.get("tz") || "", tz = zone.length <= 64 && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,3}$/.test(zone) ? zone : null;
    await env.DB.prepare("UPDATE users SET last_seen = ?, tz = COALESCE(?, tz) WHERE id = ?").bind(now(), tz, user.id).run();
    const since = Number(new URL(req.url).searchParams.get("since") || 0);
    const rows = (await env.DB.prepare("SELECT * FROM messages WHERE to_id = ? AND id > ? ORDER BY id LIMIT 100").bind(user.id, since).all()).results;
    const last = (await env.DB.prepare("SELECT MAX(id) AS id FROM messages").first()).id || 0;
    // messages deleted since this page last asked (it sends back the `now` it was given), so an open conversation can drop them
    const stamp = now(), seen = new URL(req.url).searchParams.get("seen") || "";
    const gone = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(seen) ? (await env.DB.prepare("SELECT id FROM messages WHERE (from_id = ? OR to_id = ?) AND deleted_at >= ? LIMIT 200").bind(user.id, user.id, seen).all()).results.map(r => r.id) : [];
    return json({ buddies: await buddyList(), incoming: await shapeAll(rows), last, gone, now: stamp, me: shapeMe(user) });
  }
  // Delete a message of your own, for both people. The row stays as an empty marker so what was said under it keeps its place;
  // the text and the story are erased, not hidden.
  if (path === "/api/messages/delete" && m === "POST") {
    const r = await env.DB.prepare("UPDATE messages SET body = '', story = NULL, deleted_at = ? WHERE id = ? AND from_id = ? AND deleted_at IS NULL").bind(now(), Number((await body(req)).id), user.id).run();
    return r.meta.changes ? json({ ok: true }) : json({ error: "That is not yours to delete, or it is already gone." }, 404);
  }
  // ---------- blocking ----------
  // Blocking someone ends the friendship (or refuses their request) and stops them asking again. They are not told, and nothing they see changes
  // except that you are gone from their list. Messages already sent stay where they are.
  if (path === "/api/blocks" && m === "GET") return json({ blocked: (await env.DB.prepare("SELECT u.id, u.screen_name FROM blocks b JOIN users u ON u.id = b.blocked WHERE b.blocker = ? ORDER BY u.screen_name COLLATE NOCASE").bind(user.id).all()).results });
  if (path === "/api/blocks" && m === "POST") {
    const other = Number((await body(req)).id); if (!other || other === user.id || !await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(other).first()) return json({ error: "No such person." }, 404);
    const [a, b] = pair(user.id, other);
    await env.DB.batch([env.DB.prepare("INSERT OR IGNORE INTO blocks (blocker, blocked) VALUES (?, ?)").bind(user.id, other), env.DB.prepare("DELETE FROM buddies WHERE a = ? AND b = ?").bind(a, b)]);
    return json({ buddies: await buddyList() });
  }
  if (path === "/api/blocks/remove" && m === "POST") { await env.DB.prepare("DELETE FROM blocks WHERE blocker = ? AND blocked = ?").bind(user.id, Number((await body(req)).id)).run(); return json({ ok: true }); }
  return json({ error: "unknown endpoint" }, 404);
}
