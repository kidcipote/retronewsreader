// retronewsreader on Cloudflare Workers. One Worker: static page from public/, data and config in KV (STORE).
// Ports fetch.py (feed fetching, enrichment, merge) and server.py (the five API routes) to JavaScript.
// Cron: every 30 minutes, same as the launchd job on the Mac. Writes need `Authorization: Bearer <ADMIN_TOKEN>`.

import { handleApi, limit, LIMITS, sessionUser, myPubs, FRONT_PAGE } from "./social.js";
import { WINDOW_DAYS, MIN_PER_OUTLET, unitOf, headKey, segKey, newHead, counts, untaggedIn, untagged, topTopics, absorb, remember, place, dropFeeds, prune, trimVol, roll, readWindow, build, itemId } from "./archive.js";
import TAXONOMY from "../taxonomy.json";
import { ruleTags } from "./rules.js";
import FEEDS from "../feeds.json";
import CATALOG from "../catalog.json";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// What one run may spend. Workers Paid (since 2026-10-05) allows 1,000 operations per invocation (outbound requests and KV or D1 calls alike); the free
// plan allows 50, and 1,000 KV writes a day. A copy on the free plan sets the variable PLAN to "free" (wrangler.jsonc "vars") and gets the small column.
const PLANS = {
  paid: { budget: 900, feeds: 400, scrapes: 30, tags: 300, embeds: 6, minTags: 10 },
  free: { budget: 45, feeds: 15, scrapes: 3, tags: 20, embeds: 2, minTags: 5 },
};
// budget: operations a run may use, shared by feeds, KV reads and writes, page scrapes, frame checks and tagging. feeds: feeds fetched by one run (past it,
// runs take turns, longest-waiting first). scrapes: article pages fetched for a lead image. tags: stories sent to Jev by one run (a backlog is worked off over
// several runs). embeds: frame checks. minTags: scrapes never eat the last of the budget, so this many stay for Jev.
const plan = env => PLANS[env.PLAN === "free" ? "free" : "paid"];
const TAG_CONCURRENCY = 6;
const JEV_URL = "https://api.typesafe.ai/v1/systemone";

// ---------- text helpers (mirror fetch.py) ----------
const unescapeHtml = s => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…", raquo: "»", laquo: "«" }[e.toLowerCase()] ?? m;
});
const stripTags = s => unescapeHtml(scrub(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
// ---- scrub: the catch-all for what a feed leaves in a story's text that is not the story ----
// Feeds are written by many hands and break in many small ways. Rather than fix each as it is noticed, every title, summary and story text
// goes through this one step, in both fetchers (scrub() in fetch.py is the twin) and, for what is already stored, in the page (app.js).
// It removes: CDATA marks, written out or escaped; XML declarations, doctypes and comments; control and zero-width characters;
// WordPress shortcodes ([caption], [embed]); and stray marks left at the very start (]]>, -->, >). It repairs: text escaped twice
// (&amp;amp;, or a whole story whose tags show as words) and the commonest mis-decoded characters ("â€™" for ’, "Ã©" for é).
// It is deliberately cautious: each repair fires only on a pattern that is never right as written. To add a case, add a line here and in fetch.py.
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
const sanitize = s => scrub(s)
  .replace(/<(script|style|iframe|object|embed|form)[^>]*>[\s\S]*?<\/\1>/gi, "")
  .replace(/<(script|style|iframe|object|embed|form)[^>]*\/?>/gi, "")
  .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
  .replace(/javascript:/gi, "").trim();
const CDATA_RE = /(<!\[CDATA\[[\s\S]*?\]\]>)/;
// XML text nodes carry markup as entities (&lt;p&gt;); CDATA carries it literally. Return the literal form either way. A node can mix the
// two (O Globo wraps a story's picture in CDATA and follows it with plain text): each CDATA section is taken as written and the text
// around it is unescaped, so no "<![CDATA[" or "]]>" is ever left in a story.
const cdata = s => s.includes("<![CDATA[") ? s.split(CDATA_RE).map(part => part.startsWith("<![CDATA[") ? part.slice(9, -3) : unescapeHtml(part)).join("").replace(/<!\[CDATA\[|\]\]>/g, "").trim() : unescapeHtml(s).replace(/<!\[CDATA\[|\]\]>/g, "");   // (the last replace: a feed that wrapped its text twice)
const firstImg = h => (String(h || "").match(/<img[^>]+src=["']([^"']+)/i) || [])[1] || null;

// ---------- minimal RSS 2.0 / Atom parser (regex; Workers have no XML DOM) ----------
function tag(block, name) {
  // first <name ...>text</name>; name may carry a namespace prefix
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? cdata(m[1]).trim() : "";
}
function attr(block, name, a) {
  const m = block.match(new RegExp(`<${name}\\b([^>]*)>`, "i"));
  if (!m) return "";
  const v = m[1].match(new RegExp(`\\b${a}=["']([^"']+)`, "i"));
  return v ? v[1] : "";
}
function parseDate(s) { const t = Date.parse((s || "").trim()); return Number.isFinite(t) ? new Date(t) : null; }
function parseFeed(xml) {
  const items = [];
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 2000)) && !/<rss[\s>]/i.test(xml.slice(0, 2000));
  if (!isAtom) {
    for (const [, it] of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
      const content = tag(it, "content:encoded"), desc = tag(it, "description");
      let image = null;
      for (const n of ["media:content", "media:thumbnail", "enclosure"]) {
        const u = attr(it, n, "url"), t = attr(it, n, "type") || attr(it, n, "medium");
        if (u && (/image/.test(t) || !t || /\.(jpe?g|png|webp|gif)/i.test(u))) { image = u; break; }
      }
      items.push({
        title: stripTags(tag(it, "title")), link: tag(it, "link") || tag(it, "guid"), guid: tag(it, "guid") || tag(it, "link"),
        date: parseDate(tag(it, "pubDate") || tag(it, "dc:date")), author: stripTags(tag(it, "dc:creator") || tag(it, "author")),
        categories: [...it.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)].map(m => stripTags(cdata(m[1]))).filter(Boolean),
        summary_html: desc, content_html: content || desc, image: image || firstImg(content) || firstImg(desc),
      });
    }
  } else {
    for (const [, it] of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
      let link = "";
      for (const [, attrs] of it.matchAll(/<link\b([^>]*)\/?>/gi)) { const rel = (attrs.match(/\brel=["']([^"']+)/i) || [, "alternate"])[1]; if (rel === "alternate") { link = (attrs.match(/\bhref=["']([^"']+)/i) || [])[1] || ""; break; } }
      const content = tag(it, "content"), summary = tag(it, "summary");
      items.push({
        title: stripTags(tag(it, "title")), link, guid: tag(it, "id") || link,
        date: parseDate(tag(it, "published") || tag(it, "updated")), author: stripTags((it.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/i) || [])[1] || ""),
        categories: [...it.matchAll(/<category\b[^>]*\bterm=["']([^"']+)/gi)].map(m => m[1]),
        summary_html: summary, content_html: content || summary, image: firstImg(content) || firstImg(summary),
      });
    }
  }
  return items;
}
const looksLikeFeed = s => { const h = s.slice(0, 3000).trimStart().toLowerCase(); return h.startsWith("<?xml") || h.includes("<rss") || h.includes("<feed") || h.includes("<rdf:rdf"); };
function feedTitle(xml) { const m = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m ? stripTags(cdata(m[1])) : ""; }

// ---------- network ----------
async function get(url, { timeout = 15000, accept = "*/*" } = {}) {
  N.f++;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: AbortSignal.timeout(timeout), redirect: "follow", cf: { cacheTtl: 0 } });
  if (!r.ok) { const e = new Error(`http ${r.status}`); e.status = r.status; throw e; }
  Object.defineProperty(r, "text", { value: () => decodeBody(r) });
  return r;
}
// fetch's own text() reads everything as UTF-8; a feed or page may say otherwise (Folha's feeds are ISO-8859-1, declared only in <?xml ... ?>)
async function decodeBody(r) {
  const buf = new Uint8Array(await r.arrayBuffer()), head = new TextDecoder().decode(buf.subarray(0, 1024));
  const cs = ((r.headers.get("content-type") || "").match(/charset=["']?([\w.:-]+)/i) || head.match(/<\?xml[^>]*encoding=["']([\w.:-]+)/i) || head.match(/<meta[^>]+charset=["']?([\w.:-]+)/i) || [])[1];
  try { return new TextDecoder(cs || "utf-8").decode(buf); } catch { return new TextDecoder().decode(buf); }
}
const OUTLET_MARK = /logo|placeholder|favicon|default[-_]?(?:share|image|og)|share[-_]?default/i;
async function ogMeta(url) {
  try {
    const page = (await (await get(url, { timeout: 10000, accept: "text/html" })).text()).slice(0, 200000);
    const out = {};
    for (const [prop, key] of [["og:image", "image"], ["og:description", "description"]]) {
      const m = page.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)`, "i")) || page.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"));
      if (m) out[key] = unescapeHtml(m[1]);
    }
    if (out.image && OUTLET_MARK.test(out.image)) delete out.image;   // the outlet's own logo, which a live blog or a bare page names as its picture
    return out;
  } catch { return {}; }
}
async function embeddable(url) {
  try {
    const r = await get(url, { timeout: 10000, accept: "text/html" });
    const xfo = (r.headers.get("x-frame-options") || "").toUpperCase(), csp = r.headers.get("content-security-policy") || "";
    if (xfo.includes("DENY") || xfo.includes("SAMEORIGIN")) return false;
    const m = csp.match(/frame-ancestors\s+([^;]+)/i);
    if (m) { const src = new Set(m[1].split(/\s+/).map(x => x.replace(/'/g, "").toLowerCase())); return ["*", "http:", "https:"].some(x => src.has(x)); }
    return true;
  } catch { return null; }
}

// ---------- where to pay an outlet (mirror find_support in fetch.py) ----------
// For any publication, with nothing written down in advance: read its home page, collect the links that look like ways to give it money,
// and let Jev pick the one where a reader can donate, join or subscribe (not a free newsletter, a login or a gift page).
// Returns { url, label }, or { none: "blocked" | "notfound" } so the page can say why there is no link. No guessing either way.
const SUPPORT_WORDS = /donat|support|subscri|member|join|contribut|sustain|give/i, SUPPORT_NOT = /log ?in|sign ?in|newsletter|podcast|gift|manage|account|customer|help|faq|unsubscribe|advertis|privacy|terms|rss/i;
// Where the money goes matters more than any other link the reader shows. Rules:
//  - https only, always.
//  - The page always shows the destination's address beside the link.
//  - One mechanical rule for every feed a reader added (`unvetted`), the operator's own included: the link is used only if it stays on the
//    outlet's own site or goes to one of the giving and membership services newsrooms commonly use. Nobody's judgement is involved.
//  - The starter catalog was assembled by hand, so for those outlets the link their home page gives is used wherever it leads
//    (newsrooms often take money through a parent organization or a sister address).
const GIVING_PLATFORMS = /(^|\.)(donorbox\.org|givebutter\.com|fundjournalism\.org|actblue\.com|fundrazr\.com|presspatron\.com|patreon\.com|substack\.com|memberful\.com|classy\.org|networkforgood\.com|givecampus\.com|paypal\.com|ko-fi\.com|buymeacoffee\.com|ghost\.io|beehiiv\.com)$/i;
// The part of an address that identifies one site. Usually the last two labels (nytimes.com), but three where a country puts a category
// before its code (folha.uol.com.br -> uol.com.br, bbc.co.uk): otherwise every Brazilian outlet would count as one site called "com.br".
// On a hosting service each subdomain is somebody else's site (one.substack.com and two.substack.com), so the whole name counts.
const HOSTED = /\.(substack\.com|beehiiv\.com|ghost\.io|wordpress\.com|blogspot\.com|medium\.com|tumblr\.com|github\.io|pages\.dev|netlify\.app)$/i;
export const siteOf = h => { if (HOSTED.test(h)) return h.toLowerCase().replace(/^www\./, ""); const p = h.toLowerCase().replace(/^www\./, "").split("."); return p.slice(p.length >= 3 && p[p.length - 1].length === 2 && /^(com|co|org|net|gov|edu|ac|jus|leg|mil|ne|or)$/.test(p[p.length - 2]) ? -3 : -2).join("."); };
function supportAllowed(url, home, strict) {
  let u, o; try { u = new URL(url); o = new URL(home); } catch { return false; }
  if (u.protocol !== "https:") return false;
  return !strict || siteOf(u.hostname) === siteOf(o.hostname) || GIVING_PLATFORMS.test(u.hostname);
}
const supportLabel = t => /donat|contribut|give|sustain/i.test(t) ? "Donate" : /member|join/i.test(t) ? "Become a member" : "Subscribe";
async function findSupport(home, env, strict = false) {
  let origin; try { origin = new URL(home).origin; } catch { return { none: "notfound" }; }
  let page; try { page = (await (await get(origin + "/", { timeout: 10000, accept: "text/html" })).text()).slice(0, 700000); }
  catch {
    // The home page refused (the Times does this) but the outlet's own pay page may still answer. Try the usual addresses and accept one only
    // if it really exists on the same site and its title is about paying: nothing is assumed.
    for (const path of ["/subscribe", "/donate", "/membership"]) try {
      const r = await get(origin + path, { timeout: 8000, accept: "text/html" }), title = feedTitle((await r.text()).slice(0, 20000));
      if (siteOf(new URL(r.url).hostname) === siteOf(new URL(origin).hostname) && SUPPORT_WORDS.test(title + " " + r.url)) return { url: r.url.split("?")[0], label: supportLabel(path + " " + title) };
    } catch {}
    return { none: "blocked" };
  }
  if (/\.substack\.com$/.test(new URL(origin).hostname) || /substackcdn\.com/.test(page.slice(0, 30000))) return { url: origin + "/subscribe", label: "Subscribe" };
  const cands = [], seen = new Set();
  for (const m of page.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = stripTags(m[2]).slice(0, 60); let href; try { href = new URL(unescapeHtml(m[1]), origin).href; } catch { continue; }
    if (seen.has(href) || !supportAllowed(href, origin, strict) || !SUPPORT_WORDS.test(text + " " + href)) continue;
    if (SUPPORT_NOT.test(text + " " + href) && !/donat|member/i.test(text)) continue;
    seen.add(href); cands.push({ href, text }); if (cands.length >= 30) break;
  }
  if (!cands.length) return { none: "notfound" };
  // A link that plainly says Donate or Membership is trusted as it stands. Jev settles the rest (is this "Subscribe" a paid one?),
  // and if it finds nothing, the plain one still counts: outlets often take donations on a different address from their own.
  const plain = cands.find(c => /^(donate|give|become a member|membership|join us|support us)\b/i.test(c.text)) || null;
  let pick = plain || cands.find(c => /donat|member|subscri/i.test(c.text)) || null;
  if (env.TYPESAFE_API_KEY) try {
    const criteria = Object.fromEntries(cands.map((c, i) => ["c" + i, `"${c.text}" -> ${c.href}`])); criteria.none = "None of these is a way to pay the outlet";
    const r = await fetch(JEV_URL, { method: "POST", headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ model: "jev-latest", state: { outlet: origin }, questions: { pay: { type: "choice", instructions: "These are links from a news outlet's home page. Which one is where a reader goes to give the outlet money: to donate, become a paying member, or buy a subscription? Not a free newsletter sign-up, a login, a gift, or a store.", criteria } } }) });
    if (r.ok) { const a = (await r.json()).answers.pay; pick = a.choice !== "none" && (a.probabilities.none || 0) < 0.4 ? cands[Number(a.choice.slice(1))] : plain; }   // several good links split the vote between them, so the test is that "none" lost
  } catch {}
  return pick ? { url: pick.href, label: supportLabel(pick.text + " " + pick.href) } : { none: "notfound" };
}
// Checks up to `max` publications that have not been checked yet and records the answer on the registry entry. Sections of one outlet share it.
async function supportPass(env, pubs, max) {
  const day = new Date().toISOString().slice(0, 10), todo = [];
  for (const p of pubs) {
    if (p.support_checked) continue;
    const sib = pubs.find(q => q !== p && q.support_checked && q.group && q.group === p.group);
    if (sib) { p.support = sib.support || null; p.support_why = sib.support_why; p.support_checked = sib.support_checked; todo.changed = true; continue; }
    if (todo.length < max && !todo.some(q => q.group && q.group === p.group)) todo.push(p);
  }
  await Promise.all(todo.map(async p => { const r = await findSupport(p.home, env, !!p.unvetted); p.support = r.url ? r : null; p.support_why = r.url ? "" : r.none; p.support_checked = day; }));
  for (const p of pubs) if (!p.support_checked) { const sib = todo.find(q => q.group && q.group === p.group); if (sib) { p.support = sib.support; p.support_why = sib.support_why; p.support_checked = day; } }
  if (!todo.length && !todo.changed) return 0;
  // someone may have added a feed meanwhile: write the answers onto the newest copy of the registry, not over it
  const cfg = JSON.parse(await env.STORE.get("config") || "{}"), by = new Map(pubs.map(p => [p.id, p]));
  for (const q of cfg.publications || []) { const p = by.get(q.id); if (p?.support_checked) { q.support = p.support || null; q.support_why = p.support_why || ""; q.support_checked = p.support_checked; } }
  await env.STORE.put("config", JSON.stringify(cfg));
  return todo.length;
}

// ---------- tagging (Jev; mirror tag_stories in fetch.py) ----------
// One request per story: a Choice for the primary topic, a Noul per topic for secondary ones,
// a Choice over boroughs + none, a Choice over neighborhoods + none. The lists are fixed in taxonomy.json.
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
function jevQuestions() {
  const topics = TAXONOMY.topics, q = { topic: { type: "choice", instructions: "Which topic is this news story primarily about?", criteria: topics } };
  for (const [name, desc] of Object.entries(topics)) if (name !== "Other") q["t_" + slug(name)] = { type: "noul", instructions: `Is a substantial part of this news story about ${name} (${desc})?` };
  q.borough = { type: "choice", instructions: "Which New York City borough is this story set in or mainly about?",
    criteria: { ...Object.fromEntries(Object.keys(TAXONOMY.boroughs).map(b => [b, null])), none: "No single borough: the whole city, several boroughs, or somewhere outside New York City" } };
  q.neighborhood = { type: "choice", instructions: "Which New York City neighborhood is this story set in or mainly about?",
    criteria: { ...Object.fromEntries(Object.entries(TAXONOMY.boroughs).flatMap(([b, ns]) => ns.map(n => [n, `in ${b}`]))), none: "No specific neighborhood on this list, or outside New York City" } };
  return q;
}
function readTags(answers) {
  const r3 = x => Math.round(x * 1000) / 1000, t = answers.topic;
  const extra = Object.keys(TAXONOMY.topics).filter(n => n !== t.choice && answers["t_" + slug(n)]?.noul >= TAXONOMY.secondary_threshold)
    .map(n => ({ name: n, p: r3(answers["t_" + slug(n)].noul) })).sort((a, b) => b.p - a.p).slice(0, 3);
  const places = [];
  for (const k of ["borough", "neighborhood"]) { const a = answers[k], p = a.probabilities[a.choice]; if (a.choice !== "none" && p >= TAXONOMY.place_threshold) places.push({ name: a.choice, p: r3(p) }); }
  return { topics: [{ name: t.choice, p: r3(t.probabilities[t.choice]) }, ...extra], places };
}
async function tagOne(item, pubName, env, questions) {
  N.f++;
  const state = { publication: pubName, headline: item.title, summary: item.summary || "", opening_text: stripTags(item.content).slice(0, 600), publisher_categories: item.categories || [] };
  const r = await fetch(JEV_URL, { method: "POST", headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions }), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`jev http ${r.status}`);
  return readTags((await r.json()).answers);
}
// Tags up to `limit` items that have no `topics` yet, newest first, in place. No retries: a failure stays untagged and the next run picks it up.
async function tagStories(items, pubNames, env, limit) {
  const untagged = items.filter(i => !Array.isArray(i.topics)).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  if (!untagged.length) return { tagged: 0, left: 0, note: "tagged 0 stories" };
  if (!env.TYPESAFE_API_KEY) {   // no Jev key: tag by the keyword rules in taxonomy.json
    const some = untagged.slice(0, 100); for (const it of some) Object.assign(it, ruleTags(it, TAXONOMY));
    return { tagged: some.length, left: untagged.length - some.length, note: `tagged ${some.length} stories by keyword rules (no TYPESAFE_API_KEY)` };
  }
  const todo = untagged.slice(0, Math.max(0, limit)), questions = jevQuestions();
  let next = 0, tagged = 0, firstError = "";
  await Promise.all(Array.from({ length: Math.min(TAG_CONCURRENCY, todo.length) }, async () => {
    while (next < todo.length) {
      const it = todo[next++];
      try { Object.assign(it, await tagOne(it, pubNames.get(it.pub) || it.pub, env, questions)); tagged++; } catch (e) { firstError ||= e.message || e.name; }
    }
  }));
  const failed = todo.length - tagged;
  return { tagged, left: untagged.length - tagged, note: `tagged ${tagged} stories` + (failed ? `; ${failed} failed (${firstError})` : "") + (untagged.length - tagged ? `; ${untagged.length - tagged} still untagged` : "") };
}
// ---------- the archive, per outlet (see archive.js) ----------
// Every KV operation of a run goes through these, so a run can say what it cost (Workers allow 1,000 operations and outbound requests per invocation).
const N = { r: 0, w: 0, d: 0, f: 0 };
const resetOps = () => { N.r = N.w = N.d = N.f = 0; };
const opsNote = () => `kv ${N.r} reads, ${N.w} writes, ${N.d} deletes; ${N.f} outbound requests`;
const kvJson = async (env, key) => { N.r++; return JSON.parse(await env.STORE.get(key) || "null"); };
const kvPut = (env, key, value) => { N.w++; return env.STORE.put(key, JSON.stringify(value)); };
const kvDel = (env, keys) => Promise.all(keys.map(k => { N.d++; return env.STORE.delete(k); }));
const pool = async (list, size, fn) => { const out = []; let next = 0; await Promise.all(Array.from({ length: Math.min(size, list.length) }, async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); } })); return out; };
const hashIds = ids => { let h = 2166136261; for (const c of ids.join("\n")) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36) + ids.length; };

// Writes one outlet: its sealed segments, then its head. Keys of segments let go (keep_days) are deleted.
const saveUnit = (env, unit, head, sealed, gone = []) => Promise.all([...sealed.map(s => kvPut(env, s.key, s.items)), kvDel(env, gone), kvPut(env, headKey(unit), head)]);

// From the old single `data` value to one head per outlet. Safe to run twice (the second time it sees the new layout and stops), and it
// leaves `data` and the `items:<id>` pieces in place: the new layout only becomes the live one when `meta` says v:2, which is written last.
async function migrate(env) {
  const have = await kvJson(env, "meta"); if (have?.v === 2) return "already in the per-outlet layout";
  const data = await kvJson(env, "data"), cfg = await kvJson(env, "config") || {}, pubs = cfg.publications || [];
  if (!data) { await kvPut(env, "meta", { v: 2, generated: null, publications: [], wh: {}, tag: {} }); return "no archive yet: started empty in the per-outlet layout"; }
  const built = build(data, pubs), tag = {}; let held = 0, segs = 0;
  for (const [u, { head, sealed }] of built) { held += head.items.length + sealed.reduce((n, s) => n + s.items.length, 0); segs += sealed.length; }
  const expect = data.items.filter(i => pubs.some(p => p.id === i.pub || (i.also || []).includes(p.id))).length;
  if (held !== expect) throw new Error(`migration would keep ${held} stories of ${expect}: stopped before writing anything`);
  await pool([...built], 6, async ([u, { head, sealed }]) => { await saveUnit(env, u, head, sealed); if (untaggedIn(head)) tag[u] = untaggedIn(head); });
  await kvPut(env, "meta", { v: 2, generated: data.generated, publications: data.publications, wh: {}, tag });
  return `moved ${held} stories into ${built.size} outlets (${segs} sealed segments)`;
}

// Backfill and the scheduled tagging run (POST /refresh?retag=1): fetches no feeds and spends the budget on stories without tags, found from
// `meta.tag` (which outlets still have some), so a run with nothing to do reads `meta` and stops.
async function runRetag(env) {
  const t0 = Date.now(); resetOps();
  let meta = await kvJson(env, "meta"); if (meta?.v !== 2) { await migrate(env); meta = await kvJson(env, "meta"); }
  const flagged = Object.keys(meta.tag || {}).slice(0, 150);
  if (!flagged.length) return { ok: true, seconds: 0, tagged: 0, untagged: 0, output: "nothing to tag" };
  const heads = new Map(await pool(flagged, 8, async u => [u, await kvJson(env, headKey(u))]));
  const parts = [];   // { unit, head, seg (a segment entry, or null for the head itself), items }
  for (const [u, head] of heads) if (head) { parts.push({ unit: u, head, seg: null, items: head.items }); }
  await pool([...heads].filter(([, h]) => h).flatMap(([u, head]) => head.segs.filter(s => s.nt > 0).map(s => ({ u, head, s }))), 8, async ({ u, head, s }) => {
    const items = await kvJson(env, segKey(u, s.k)); if (items) parts.push({ unit: u, head, seg: s, items });
  });
  const before = new Map(parts.map(p => [p, untagged(p.items)]));
  const names = new Map(meta.publications.map(p => [p.id, p.name]));
  const r = await tagStories(parts.flatMap(p => p.items), names, env, plan(env).budget - 2 * parts.length - N.f - 10);
  const touched = new Set();
  await pool(parts.filter(p => untagged(p.items) !== before.get(p)), 8, async p => {
    if (p.seg) { p.seg.nt = untagged(p.items); await kvPut(env, segKey(p.unit, p.seg.k), p.items); }
    touched.add(p.unit);
  });
  await pool([...touched], 8, async u => kvPut(env, headKey(u), heads.get(u)));
  const tag = { ...meta.tag }; for (const u of flagged) { const h = heads.get(u); const n = h ? untaggedIn(h) : 0; if (n) tag[u] = n; else delete tag[u]; }
  if (JSON.stringify(tag) !== JSON.stringify(meta.tag || {})) await kvPut(env, "meta", { ...meta, tag });
  return { ok: true, seconds: +((Date.now() - t0) / 1000).toFixed(1), tagged: r.tagged, untagged: Object.values(tag).reduce((a, b) => a + b, 0), output: `${r.note}; ${opsNote()}` };
}

// Re-tag stories that already have tags (POST /refresh?redo=7&dry=1): used after taxonomy.json changes, for the last N days only (heads, not sealed
// segments). Each story that Jev has answered for gets `tx` = TAXONOMY.version, so a run only takes the ones not yet done and the next call carries on.
// A failure leaves the old tags as they were. It writes by re-reading each head just before and changing only those stories' tags, so a head a fetch
// wrote meanwhile is never overwritten. At most `max` stories and about 100 seconds a run, inside the 180-second lock.
async function runRedo(env, days, max, dry) {
  const t0 = Date.now(); resetOps();
  const meta = await kvJson(env, "meta"); if (meta?.v !== 2) return { ok: false, error: "archive is not in the per-outlet layout" };
  if (!TAXONOMY.version) return { ok: false, error: "taxonomy.json has no version to stamp stories with" };
  const units = [...new Set(meta.publications.map(unitOf))], cutoff = Date.now() - days * 864e5, stamp = TAXONOMY.version;
  const heads = new Map(await pool(units, 8, async u => [u, await kvJson(env, headKey(u))]));
  const all = []; for (const [u, h] of heads) if (h) for (const it of h.items) if (Date.parse(it.date) >= cutoff && it.tx !== stamp) all.push({ u, it });
  all.sort((a, b) => Date.parse(b.it.date) - Date.parse(a.it.date));
  if (dry) return { ok: true, dry: true, remaining: all.length, output: `${all.length} stories in the last ${days} days still to re-tag; ${opsNote()}` };
  if (!env.TYPESAFE_API_KEY) return { ok: false, error: "no TYPESAFE_API_KEY" };
  const todo = all.slice(0, max), names = new Map(meta.publications.map(p => [p.id, p.name])), questions = jevQuestions(), done = new Map();
  let next = 0, failed = 0, firstError = "";
  await Promise.all(Array.from({ length: Math.min(TAG_CONCURRENCY, todo.length) }, async () => {
    while (next < todo.length && Date.now() - t0 < 100000) {
      const { u, it } = todo[next++];
      try { const t = await tagOne(it, names.get(it.pub) || it.pub, env, questions); done.set(it.id, { u, tags: { ...t, tx: stamp } }); } catch (e) { failed++; firstError ||= e.message || e.name; }
    }
  }));
  const byUnit = new Map(); for (const [id, d] of done) { if (!byUnit.has(d.u)) byUnit.set(d.u, new Map()); byUnit.get(d.u).set(id, d.tags); }
  let applied = 0;
  await pool([...byUnit], 8, async ([u, tags]) => {
    const head = await kvJson(env, headKey(u)); if (!head) return;
    let n = 0; for (const it of head.items) { const t = tags.get(it.id); if (t) { Object.assign(it, t); n++; } }
    if (n) { await kvPut(env, headKey(u), head); applied += n; }
  });
  const remaining = all.length - applied;
  return { ok: true, retagged: applied, failed, remaining, output: `re-tagged ${applied} of ${todo.length} tried` + (failed ? `; ${failed} failed (${firstError})` : "") + `; ${remaining} left in the last ${days} days; ${opsNote()}` };
}

// ---------- the fetch run (mirror fetch.py main) ----------
// `only` (a list of publication ids) fetches just those feeds and leaves everything else in the archive as it is: used the moment
// someone adds a feed, so its stories are there in seconds, not at the next half-hourly run.
// Every fetch publishes at once: a story is never kept from readers to wait for its tags. (Holding the pieces back for the tagging run
// was tried on 2026-10-04 to save KV writes and taken out the same day: stories then depended on a second scheduled run to be seen at
// all, and schedules fire late.)
//
// What a run reads and writes: every followed feed is fetched, but a feed whose window of stories is the one it showed last time (`meta.wh`,
// a hash of the ids) is done with there and then. For the rest, the run reads only that outlet's head, merges, tags, and writes it back (and,
// when the head has grown past its size, one sealed segment). Nothing else in the archive is touched. If more outlets have news than the
// run has operations for, the rest keep their old hash and come up in the next run (the feeds still show the same stories then).
async function runFetch(env, { recheck = false, only = null } = {}) {
  const t0 = Date.now(), log = [], L = plan(env); resetOps();
  const cfg = await kvJson(env, "config") || {}, pubs = cfg.publications || [];
  let meta = await kvJson(env, "meta"); if (meta?.v !== 2) { log.push(await migrate(env)); meta = await kvJson(env, "meta"); }
  const prev = new Map((meta.publications || []).map(p => [p.id, p])), wh = { ...meta.wh }, unitOfId = new Map(pubs.map(p => [p.id, unitOf(p)]));
  const prevFetched = id => prev.get(id)?.fetched_at || "";
  // Every feed somebody follows is fetched on every run, up to L.feeds; past that, a run takes the ones that have waited longest and
  // the rest come up in the next runs (`fetched_at` on each publication is what the turn-taking reads). A feed nobody follows any more is
  // not fetched at all: it keeps its stories and its last status, and is picked up again within a run of someone following it.
  let followed = null; if (!only && env.DB) try { followed = new Set([...FRONT_PAGE, ...(await env.DB.prepare("SELECT DISTINCT pub_id FROM user_pubs").all()).results.map(r => r.pub_id)]); } catch {}
  const toFetch = (only ? pubs.filter(p => only.includes(p.id)) : pubs.filter(p => !followed || followed.has(p.id)).sort((a, b) => prevFetched(a.id).localeCompare(prevFetched(b.id)))).slice(0, L.feeds);
  const fetchedNow = new Set(toFetch.map(p => p.id));
  log.push(`fetching ${toFetch.length} of ${pubs.length} feeds${followed ? ` (${pubs.filter(p => !followed.has(p.id)).length} have no followers)` : ""}`);

  const results = await Promise.all(toFetch.map(async p => {
    try {
      const xml = await (await get(p.feed)).text();
      const items = parseFeed(xml).slice(0, cfg.max_per_publication || 25);
      log.push(`  ${p.name}: ok, ${items.length} items`);
      return { pub: p, status: "ok", items, h: hashIds(items.map(it => itemId(it.guid || it.link || "")).filter(Boolean)) };
    } catch (e) { log.push(`  ${p.name}: ${e.status ? "http " + e.status : "error: " + e.name}`); return { pub: p, status: e.status ? `http ${e.status}` : `error: ${e.name}`, items: [] }; }
  }));
  const resultOf = new Map(results.map(r => [r.pub.id, r]));

  // which outlets have something to look at: a changed window, or a feed that has left the registry
  const known = new Set(pubs.map(p => p.id));
  const gone = [...(meta.publications || []).filter(p => !known.has(p.id)), ...(meta.dropped || [])];
  const goneUnits = [...new Set(gone.map(g => unitOf(g)))];
  const changed = results.filter(r => r.status === "ok" && r.h !== wh[r.pub.id]);
  const wanted = [...new Set([...goneUnits, ...changed.map(r => unitOfId.get(r.pub.id))])];
  const prevEmbed = new Map((meta.publications || []).map(p => [p.id, p.embeddable]));
  const embedNow = toFetch.filter(p => prevEmbed.get(p.id) === undefined || recheck).slice(0, L.embeds);   // only feeds fetched this run, and only a few: the rest wait their turn
  let budget = L.budget - N.f - embedNow.length - N.r - 6;   // what is left of the operations after the feeds and the frame checks; 6 for meta, config and the lock
  const dirty = wanted.slice(0, Math.max(0, Math.floor((budget - L.minTags) / 2)));   // each outlet costs a read and a write
  const dirtySet = new Set(dirty); budget -= dirty.length * 2;
  if (dirty.length < wanted.length) log.push(`${wanted.length - dirty.length} outlets wait for the next run (out of operations)`);
  // where to pay each outlet: a few unchecked publications per run (two requests each), new feeds first
  const supportMax = Math.max(0, Math.min(only ? 4 : 2, Math.floor((budget - L.minTags) / 2)));
  const checked = await supportPass(env, only ? [...toFetch, ...pubs.filter(p => !toFetch.includes(p))] : pubs, supportMax);
  budget -= checked * 2; if (checked) log.push(`looked up where to support ${checked} outlets`);

  const heads = new Map(await pool(dirty, 8, async u => [u, await kvJson(env, headKey(u)) || newHead()]));
  const mine = r => dirtySet.has(unitOfId.get(r.pub.id));
  const fresh = [];   // { unit, id, pub, it, also }
  for (const u of dirty) {
    dropFeeds(heads.get(u), known);
    const incoming = changed.filter(r => unitOfId.get(r.pub.id) === u).flatMap(r => r.items.map(it => ({ pub: r.pub.id, it })));
    for (const f of absorb(heads.get(u), incoming)) fresh.push({ unit: u, ...f });
  }
  log.push(`${changed.filter(mine).reduce((n, r) => n + r.items.length, 0)} items in changed feeds, ${fresh.length} new`);

  if (cfg.fetch_article_pages !== false) {
    const need = fresh.filter(f => !f.it.image).slice(0, Math.max(0, Math.min(L.scrapes, budget - L.minTags)));
    budget -= need.length;
    const metas = await Promise.all(need.map(f => ogMeta(f.it.link)));
    need.forEach((f, i) => { f.it.image = metas[i].image || null; if (!stripTags(f.it.summary_html) && metas[i].description) f.it.summary_html = metas[i].description; });
    log.push(`scraped ${need.length} pages for lead images`);
  }

  const nowIso = new Date().toISOString();
  for (const f of fresh) {
    const { it } = f, head = heads.get(f.unit), d = it.date || new Date(), summary = stripTags(it.summary_html);
    place(head, { id: f.id, first_seen: nowIso, pub: f.pub, title: it.title, link: it.link, date: d.toISOString(), author: it.author,
      categories: it.categories.slice(0, 6), summary: summary.slice(0, 320) + (summary.length > 320 ? "…" : ""), content: sanitize(it.content_html),
      // an image address lifted out of HTML or a feed attribute still has its & written as &amp;: put it back, or an outlet that signs its image addresses refuses it
      image: it.image ? unescapeHtml(it.image) : it.image, ...(f.also.length ? { also: f.also } : {}) });
  }
  for (const r of changed.filter(mine)) remember(heads.get(unitOfId.get(r.pub.id)), r.pub.id, r.items.map(it => itemId(it.guid || it.link || "")).filter(Boolean));
  const gonePrune = [];
  if (cfg.keep_days) {
    const cutoff = Date.now() - cfg.keep_days * 86400e3; let n = 0;
    for (const u of dirty) { const p = prune(u, heads.get(u), cutoff); n += p.items; gonePrune.push(...p.segs.map(k => [u, k])); }
    if (n || gonePrune.length) log.push(`pruned ${n} items and ${gonePrune.length} sealed segments older than ${cfg.keep_days} days`);
  }
  for (const u of dirty) trimVol(heads.get(u), Date.now());
  const names = new Map(pubs.map(p => [p.id, p.name]));
  log.push((await tagStories(dirty.flatMap(u => heads.get(u).items), names, env, Math.min(budget, L.tags))).note);

  // frame policy: reuse the previous answer unless missing, to stay inside the subrequest budget
  const embed = {};
  await Promise.all(pubs.map(async p => {
    if (!embedNow.includes(p)) { embed[p.id] = prevEmbed.get(p.id); return; }   // known already, or not this run's turn (stays unknown until it is)
    const sample = resultOf.get(p.id)?.items[0]; embed[p.id] = sample ? !!(await embeddable(sample.link)) : undefined;
  }));

  // write: each outlet's sealed segments and head; an outlet with no feeds left is deleted
  const tag = { ...meta.tag }, counted = new Map(), tops = new Map(); let sealedN = 0;
  await pool(dirty, 8, async u => {
    const head = heads.get(u), hasFeeds = pubs.some(p => unitOfId.get(p.id) === u);
    if (!hasFeeds) { await kvDel(env, [headKey(u), ...head.segs.map(s => segKey(u, s.k))]); delete tag[u]; return; }
    const sealed = roll(u, head); sealedN += sealed.length;
    await saveUnit(env, u, head, sealed, gonePrune.filter(([x]) => x === u).map(([, k]) => k));
    counted.set(u, counts(head)); tops.set(u, topTopics(head, TAXONOMY.renamed)); const nt = untaggedIn(head); if (nt) tag[u] = nt; else delete tag[u];
  });
  for (const r of changed.filter(mine)) wh[r.pub.id] = r.h;
  for (const id of Object.keys(wh)) if (!known.has(id)) delete wh[id];
  const nowStamp = nowIso;
  const publications = pubs.map(p => ({ ...p, status: resultOf.get(p.id)?.status ?? prev.get(p.id)?.status ?? "fetching now",
    top: tops.has(unitOfId.get(p.id)) ? tops.get(unitOfId.get(p.id))[p.id] || [] : prev.get(p.id)?.top,
    count: counted.has(unitOfId.get(p.id)) ? counted.get(unitOfId.get(p.id))[p.id] || 0 : prev.get(p.id)?.count || 0,
    fetched_at: fetchedNow.has(p.id) ? nowStamp : prevFetched(p.id) || undefined, ...(embed[p.id] === undefined ? {} : { embeddable: !!embed[p.id] }) }));
  await kvPut(env, "meta", { v: 2, generated: nowIso, publications, wh, tag });
  log.push(`wrote ${dirty.length} outlets (${fresh.length} stories added${sealedN ? `, ${sealedN} segments sealed` : ""}); ${opsNote()}`);
  return { ok: true, seconds: +((Date.now() - t0) / 1000).toFixed(1), added: fresh.length, output: log.join("\n") };
}

// Newly added feeds are fetched and tagged straight away. If a run is already going, the scheduled one will pick them up.
async function fetchNow(env, ids) {
  if (!ids.length || await env.STORE.get("lock")) return;
  await env.STORE.put("lock", "1", { expirationTtl: 180 });
  try { const r = await runFetch(env, { only: ids }); console.log(r.output); } catch (e) { console.error("immediate fetch failed", e); }
  finally { await env.STORE.delete("lock"); }
}

// ---------- feed discovery (mirror server.probe) ----------
async function probe(url) {
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  let r; try { r = await get(url); } catch (e) { return { error: e.status ? `site answered HTTP ${e.status}` : `could not reach it (${e.name})` }; }
  const body = await r.text();
  const base = new URL(url).origin;
  if (looksLikeFeed(body)) { const n = parseFeed(body).length; return n ? { feed: url, title: feedTitle(body), items: n, home: base } : { error: "looks like a feed but has no items" }; }
  const siteTitle = feedTitle(body), html = body.slice(0, 400000), cands = [];
  for (const m of html.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*href=["']([^"']+)/gi)) cands.push(new URL(m[1], url).href);
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*type=["']application\/(?:rss|atom)\+xml["']/gi)) cands.push(new URL(m[1], url).href);
  for (const p of ["/feed/", "/feed", "/rss/", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml", "/feeds/posts/default"]) cands.push(base + p);
  const tried = [];
  for (const c of [...new Set(cands)].slice(0, 12)) {
    tried.push(c);
    try { const t = await (await get(c, { timeout: 10000 })).text(); if (looksLikeFeed(t)) { const n = parseFeed(t).length; if (n) return { feed: c, title: feedTitle(t) || siteTitle, items: n, home: base }; } } catch {}
  }
  return { error: "no feed found", tried: tried.slice(0, 6), title: siteTitle };
}

// ---------- finding an outlet's feeds (the wizard behind Your feeds) ----------
// Nothing about any outlet is written down in advance. A lookup follows the trail the site leaves: the feeds its home page advertises,
// then its own page of feeds if it has one. Jev ranks what was found (which are real sections, which is the main one, which is about
// New York), the best are fetched to confirm they work and to show a preview, and the answer is remembered for a week.
const baseDomain = siteOf;
const FEEDISH = /\.(xml|rss|atom)(\?|$)|\/(feed|rss|atom)\/?(\?|$)|^https?:\/\/(rss|feeds)\./i;
const DISCOVER_CHECK = 24;   // candidate feeds fetched per lookup: the lookup shares the 50-request budget of one call
function peekFeed(xml) {
  if (!looksLikeFeed(xml)) return null;
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || []; if (!blocks.length) return null;
  const date = b => parseDate(tag(b, "pubDate") || tag(b, "dc:date") || tag(b, "published") || tag(b, "updated"));
  const first = date(blocks[0]), last = date(blocks[blocks.length - 1]), days = first && last ? Math.max(0.5, (first - last) / 86400e3) : null;
  return { title: feedTitle(xml), items: blocks.length, latest: stripTags(tag(blocks[0], "title")).slice(0, 120), when: first ? first.toISOString() : null, perDay: days ? Math.round(blocks.length / days * 10) / 10 : null };
}
async function discover(url, env) {
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  let u; try { u = new URL(url); } catch { return { error: "that is not a web address" }; }
  // `host` is the outlet as typed (folha.uol.com.br); `base` is the wider site it belongs to (uol.com.br). Feeds may live anywhere on the
  // wider site, but the outlet itself, and what is remembered about it, is the host: Folha and UOL's other papers are different outlets.
  const home = u.origin, host = u.hostname.toLowerCase().replace(/^www\./, ""), base = baseDomain(host);
  const bare = u.pathname === "/" && !u.search;   // a whole site, as opposed to the address of one particular feed or page
  const cached = bare && await env.STORE.get(`disc:${host}`); if (cached) return JSON.parse(cached);
  // Some outlets refuse their home page to anything automated yet leave their feeds, and even their page of feeds, open: carry on without it.
  let page = "", refused = "", reached = true; try { page = (await (await get(url, { accept: "text/html,application/xml" })).text()).slice(0, 500000); } catch (e) { refused = e.status ? `the site answered HTTP ${e.status}` : "could not reach the site"; reached = !!e.status; }
  const own = h => { try { return baseDomain(new URL(h).hostname) === base; } catch { return false; } };
  const cands = new Map();   // feed address -> the label the site gives it
  const add = (href, label, from) => { try { const f = new URL(unescapeHtml(href), from).href, l = stripTags(label || "").slice(0, 80);
    if (own(f) && !cands.has(f) && !/comment|coment[aá]rio/i.test(f + " " + l)) cands.set(f, l); } catch {} };   // a site's feed of reader comments is not a section
  if (looksLikeFeed(page)) cands.set(url, "");
  for (const [t] of page.matchAll(/<link\b[^>]*>/gi)) if (/type=["']application\/(rss|atom)\+xml["']/i.test(t)) add((t.match(/href=["']([^"']+)/i) || [])[1] || "", (t.match(/title=["']([^"']+)/i) || [])[1], home);
  // Sites built on Arc (Estadão, El Universal, La Nación) all serve a general feed at the same address, advertised or not; what they do advertise can be years stale
  if (/\/pf\/resources\/|arcpublishing/i.test(page)) add(home + "/arc/outboundfeeds/rss/?outputType=xml", "", home);
  // feeds of this outlet the reader already follows are candidates too: for an outlet that blocks everything else, they are all there is
  const sameOutlet = p => { if (p.group) return p.group === host; try { const h = new URL(p.home).hostname.replace(/^www\./, ""); return h === host || (base === host && baseDomain(h) === base); } catch { return false; } };
  for (const p of JSON.parse(await env.STORE.get("config") || "{}").publications || []) if (sameOutlet(p)) cands.has(p.feed) || cands.set(p.feed, p.section || "");
  const main = [...cands.keys()][0] || null;
  const idx = [], listed = cands.size; let indexed = 0;
  // a page of feeds is linked as /rss, /feeds, or a site's own /feed (Folha's www1.folha.uol.com.br/feed); /author/x/feed and the like are single feeds, not pages of them
  for (const m of page.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) if (/^(rss|rss feeds?|feeds?)$/i.test(stripTags(m[2])) || /\/(rss|feeds)(\/|\.html?)?$|rss\/index/i.test(m[1]) || /^(https?:)?(\/\/[^/]+)?\/feed\/?$/i.test(m[1])) { try { const h = new URL(unescapeHtml(m[1]), home).href; if (own(h) && !idx.includes(h)) idx.push(h); } catch {} }
  if (!idx.length) idx.push(home + "/rss", home + "/feeds");
  await Promise.all(idx.slice(0, 2).map(async h => { try {
    const t = (await (await get(h, { timeout: 10000, accept: "text/html" })).text()).slice(0, 700000);
    if (looksLikeFeed(t)) { if (!cands.has(h)) cands.set(h, ""); return; }
    for (const m of t.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) if (FEEDISH.test(m[1])) { add(m[1], m[2], h); indexed++; }
  } catch {} }));
  // the usual addresses are guessed whenever the home page named no feed, even if a guessed /rss answered: Chilango's /rss stopped in 2019, its /feed/ is current
  if (!listed && !refused) for (const p of ["/feed/", "/feed", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml"]) cands.has(home + p) || cands.set(home + p, "");
  if (!cands.size) return { error: refused || "no feed found", blocked: !!refused && reached };
  let list = [...cands].slice(0, 110).map(([feed, label], i) => ({ feed, label, key: "c" + i, score: 0.5 }));
  // rank before fetching: a big outlet lists far more feeds than one lookup can check
  let nyc = null, lead = main;
  if (env.TYPESAFE_API_KEY && list.length > 1) try {
    const options = Object.fromEntries(list.map(c => [c.key, null]));
    const questions = { lead: { type: "choice", instructions: "Which of `feeds` is the outlet's main, general feed (its home page or top stories)?", criteria: { ...options, none: "None of them is a general feed" } },
      nyc: { type: "choice", instructions: "Which of `feeds` is specifically about New York City or its region?", criteria: { ...options, none: "None of them" } } };
    for (const c of list) questions[c.key] = { type: "noul", instructions: `Is feed \`${c.key}\` in \`feeds\` one of the outlet's main news sections that a general reader might follow (such as its top stories, World, U.S., Politics, a city or region, Business, Technology, Arts, Sports, Opinion), and not a narrow sub-topic, a single columnist or blog, a podcast, video, or a regional sub-edition?` };
    const r = await fetch(JEV_URL, { method: "POST", headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ model: "jev-latest", state: { outlet: base, feeds: Object.fromEntries(list.map(c => [c.key, { label: c.label, address: c.feed }])) }, questions }) });
    if (r.ok) {
      const a = (await r.json()).answers;
      for (const c of list) if (a[c.key]) c.score = a[c.key].noul;
      const pick = q => a[q] && a[q].choice !== "none" && a[q].probabilities[a[q].choice] >= 0.5 ? list.find(c => c.key === a[q].choice)?.feed : null;
      nyc = pick("nyc"); lead = pick("lead") || main;
    }
  } catch {}
  if (looksLikeFeed(page)) { lead = url; nyc = null; }   // a feed's own address was pasted: that is the one being asked for
  const must = new Set([main, lead, nyc].filter(Boolean));
  list = [...list.filter(c => must.has(c.feed)), ...list.filter(c => !must.has(c.feed)).sort((x, y) => y.score - x.score)].slice(0, DISCOVER_CHECK);
  const known = (JSON.parse(await env.STORE.get("config") || "{}").publications || []).find(sameOutlet);
  const siteName = known?.name || unescapeHtml((page.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i) || [])[1] || feedTitle(page).split(/\s+[-|–—:]\s+/)[0] || base).slice(0, 40);
  const clean = t => { const x = String(t || "").replace(/\s*[»>]\s*(rss\s+)?feed\s*$/i, "").split(/\s+[>»]\s+/).pop().replace(/^\S+\.(com|org|net|nyc|co|news)\s+/i, "").replace(/\s*\([^)]*\)\s*$/, "").replace(/^(rss\s+)?feed\s+(rss\s+)?(para|de|do|da|for|of)\s+((o|a|os|as|the)\s+)?/i, "").replace(new RegExp(`\\s*[-|–—:]\\s*${siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "").trim(); return x.slice(0, 40); };
  const feeds = (await Promise.all(list.map(async c => { try {
    const pk = peekFeed(await (await get(c.feed, { timeout: 10000 })).text()); if (!pk) return null;
    // (below) the outlet's general feed is called "All stories", not a section named after the outlet
    if (pk.when && Date.now() - Date.parse(pk.when) > 90 * 86400e3) return null;   // a feed nobody has posted to in three months
    const t = clean(c.label) || clean(pk.title); return { feed: c.feed, title: !t || t.toLowerCase() === siteName.toLowerCase() ? "All stories" : t, latest: pk.latest, when: pk.when, perDay: pk.perDay, score: Math.round(c.score * 100) / 100, suggested: c.feed === lead || c.feed === nyc, nyc: c.feed === nyc };
  } catch { return null; } }))).filter(Boolean);
  // the same feed offered twice (RSS and Atom, or two addresses) shows once
  const dup = new Set(); for (let i = feeds.length - 1; i >= 0; i--) { const k = `${feeds[i].latest}|${feeds[i].when}`; if (feeds.some((f, j) => j < i && `${f.latest}|${f.when}` === k)) dup.add(i); }
  for (const i of [...dup].sort((x, y) => y - x)) feeds.splice(i, 1);
  if (!feeds.length) return { error: refused || "no working feed found there" };
  if (!feeds.some(f => f.suggested)) feeds[0].suggested = true;
  feeds.sort((x, y) => (y.suggested - x.suggested) || (y.score - x.score));
  // partial: the outlet refused its home page and offered no page of feeds, so the list is only what the reader already knew
  const out = { site: { name: siteName, home, host }, feeds, checked: list.length, found: cands.size, partial: !!refused && !indexed && !looksLikeFeed(page) };
  if (bare) await env.STORE.put(`disc:${host}`, JSON.stringify(out), { expirationTtl: 7 * 86400 });
  return out;
}

// ---------- a name instead of an address ("New York Timed") ----------
// Wikipedia's search finds pages near the name, Wikidata gives each one's official site, and Jev picks which of them is the news outlet
// the person meant. The result is only ever offered as "Did you mean": nothing is added until the person confirms the site.
// Covers established outlets; a small newsletter with no Wikipedia page will not be found this way.
async function resolveName(q, env) {
  const wiki = async url => (await fetch(url, { headers: { "User-Agent": "RetroNewsreader/1.0 (https://retronewsreader.com)" }, signal: AbortSignal.timeout(8000) })).json();
  try {
    const search = t => wiki("https://en.wikipedia.org/w/api.php?format=json&action=query&list=search&srlimit=6&srinfo=suggestion&srsearch=" + encodeURIComponent(t));
    const [a, b] = await Promise.all([search(q), search(q + " newspaper OR news OR magazine")]);
    // a misspelling: Wikipedia offers its own correction ("wall street jurnal" -> "wall street journal"); search again with that, and put it first
    const fixed = a.query.searchinfo?.suggestion || b.query.searchinfo?.suggestion, c = fixed ? await search(fixed.replace(/ newspaper or news or magazine$/i, "")) : null;
    const titles = [...new Set([...(c?.query.search || []), ...a.query.search, ...b.query.search].map(h => h.title))].slice(0, 12); if (!titles.length) return [];
    const pp = await wiki("https://en.wikipedia.org/w/api.php?format=json&action=query&prop=pageprops&ppprop=wikibase_item&redirects=1&titles=" + encodeURIComponent(titles.join("|")));
    const pages = Object.values(pp.query.pages).filter(x => x.pageprops?.wikibase_item); if (!pages.length) return [];
    const wd = await wiki("https://www.wikidata.org/w/api.php?format=json&action=wbgetentities&props=claims|descriptions&languages=en&ids=" + pages.map(x => x.pageprops.wikibase_item).join("|"));
    const cands = pages.map(x => { const e = wd.entities[x.pageprops.wikibase_item], site = e?.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
      let host = ""; try { host = new URL(site).hostname.replace(/^www\./, ""); } catch {}
      return host && /^https?:/.test(site) ? { name: x.title, host, desc: e.descriptions?.en?.value || "" } : null; }).filter(Boolean);
    if (!cands.length) return [];
    const newsy = c => /news|paper|magazine|journal|publication|media|website|blog|broadcast|radio/i.test(c.desc);
    let first = null;
    if (env.TYPESAFE_API_KEY) try {
      const criteria = Object.fromEntries(cands.map((c, i) => ["c" + i, `${c.name}: ${c.desc || "no description"} (${c.host})`])); criteria.none = "None of these is a news outlet matching what was typed";
      const r = await fetch(JEV_URL, { method: "POST", headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ model: "jev-latest", state: { typed: q }, questions: { meant: { type: "choice", instructions: "Someone typed `typed` (possibly misspelled) as the name of a news outlet they want to follow. Which of these is the news outlet they most likely meant?", criteria } } }) });
      if (r.ok) { const m = (await r.json()).answers.meant; if (m.choice !== "none" && (m.probabilities.none || 0) < 0.4) first = cands[Number(m.choice.slice(1))]; else return []; }
    } catch {}
    // with Jev's pick, offer just that one: runners-up from a search are mostly unrelated pages. Without Jev, offer the few that are described as news.
    return (first ? [first] : cands.filter(newsy).slice(0, 3)).map(({ name, host }) => ({ name, host, from: "Wikipedia" }));
  } catch { return []; }
}

// ---------- HTTP ----------
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const authed = (req, env) => env.ADMIN_TOKEN && req.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`;

// One address. The older ones send a reader's pages to it; everything else (data, the API, the page's own files) is answered where it
// arrives, so an open tab and the maintenance scripts keep working. The four pages are listed in wrangler.jsonc (run_worker_first) too.
const HOME = "retronewsreader.com", MOVED = new Set(["www.retronewsreader.com", "rnr.copa.systems", "nyc-feed-reader.copa-systems.workers.dev"]);
const PAGES = new Set(["/", "/index.html", "/privacy", "/terms", "/ai"]);
// Short addresses for tagged invite links, typed from somewhere a link cannot be tapped (an Instagram caption). Each leads to the invite
// link in the database with that tag. A new one is a line here, its path in wrangler.jsonc (run_worker_first), and a row in `invites`.
const TAGGED = { "/ig": "instagram" };
let seeded = false;   // once per isolate: the starting feeds go in if storage has no registry yet
async function seed(env) { if (seeded) return; seeded = true; if (!(await env.STORE.get("config"))) await env.STORE.put("config", JSON.stringify(FEEDS)); }
export default {
  async fetch(req, env, ctx) {
    await seed(env);
    const url = new URL(req.url), path = url.pathname;
    if (TAGGED[path] && req.method === "GET") {
      const row = env.DB ? await env.DB.prepare("SELECT code FROM invites WHERE source = ? ORDER BY created_at DESC LIMIT 1").bind(TAGGED[path]).first().catch(() => null) : null;
      return new Response(null, { status: 302, headers: { Location: `${MOVED.has(url.hostname) ? "https://" + HOME : url.origin}/${row ? "#invite=" + row.code : ""}`, "Cache-Control": "no-store" } });
    }
    if (PAGES.has(path) && MOVED.has(url.hostname) && req.method === "GET") return Response.redirect(`https://${HOME}${path === "/index.html" ? "/" : path}${url.search}`, 301);
    if (path.startsWith("/api/")) {
      if (!env.DB) return json({ error: "chat is not set up on this deployment" }, 501);
      try { return await handleApi(req, env, path, ctx, { probe, discover, resolveName, siteOf, catalog: CATALOG.publications, fetchNow: ids => ctx.waitUntil(fetchNow(env, ids)),
        refresh: async () => { if (await env.STORE.get("lock")) return { ok: false, error: "a refresh is already running" }; await env.STORE.put("lock", "1", { expirationTtl: 180 }); try { return await runFetch(env); } catch (e) { return { ok: false, error: `${e.name}: ${e.message}` }; } finally { ctx.waitUntil(env.STORE.delete("lock")); } } }); } catch (e) { return json({ error: `${e.name}: ${e.message}` }, 500); }
    }
    if (req.method === "GET" && path === "/data.json") {
      // Signed on: that person's publications. Signed off: the front page. Nobody is sent a publication they do not follow.
      // The last WINDOW_DAYS days (`?days=` asks for more, up to a year) and at least the newest MIN_PER_OUTLET stories of each outlet.
      // Each outlet is read from its own head (and, only when the window reaches back that far, its sealed segments): see archive.js.
      const meta = JSON.parse(await env.STORE.get("meta") || "null"), empty = '{"generated":null,"publications":[],"items":[]}', head = { "Content-Type": "application/json", "Cache-Control": "private, no-store" };
      if (!meta) return new Response(empty, { headers: head });
      const user = env.DB ? await sessionUser(req, env).catch(() => null) : null;
      let ids = user ? await myPubs(env, user.id) : FRONT_PAGE; if (!ids.length) ids = FRONT_PAGE;
      const known = new Map(meta.publications.map(p => [p.id, p])), pubs = ids.map(id => known.get(id)).filter(Boolean);
      if (pubs.length < ids.length) {   // on the list but not fetched yet: show it as on its way
        const reg = new Map((JSON.parse(await env.STORE.get("config") || "{}").publications || []).map(p => [p.id, p]));
        for (const id of ids) if (!known.has(id) && reg.has(id)) pubs.push({ ...reg.get(id), status: "fetching now", count: 0, embeddable: false });
      }
      if (meta.v !== 2) {   // before the move to the per-outlet layout (migrate): the pieces of the old one
        const pieces = (await Promise.all(ids.filter(id => known.has(id)).map(id => env.STORE.get(`items:${id}`)))).filter(c => c && c.length > 2).map(c => c.slice(1, -1));
        return new Response(`{"generated":${JSON.stringify(meta.generated)},"publications":${JSON.stringify(pubs)},"items":[${pieces.join(",")}]}`, { headers: head });
      }
      const days = Math.min(400, Math.max(1, Number(url.searchParams.get("days")) || WINDOW_DAYS)), cutoff = Date.now() - days * 864e5;
      const mine = new Set(ids.filter(id => known.has(id))), units = [...new Set([...mine].map(id => unitOf(known.get(id))))];
      const member = i => mine.has(i.pub) || (i.also || []).some(x => mine.has(x));
      const pieces = (await pool(units, 4, async u => {   // a few at a time: each head is parsed, filtered and let go before the next
        const list = await readWindow(async k => { const t = await env.STORE.get(k); return t ? JSON.parse(t) : null; }, u, member, cutoff, MIN_PER_OUTLET);
        return list.length ? JSON.stringify(list).slice(1, -1) : "";
      })).filter(Boolean);
      return new Response(`{"generated":${JSON.stringify(meta.generated)},"publications":${JSON.stringify(pubs)},"items":[${pieces.join(",")}]}`, { headers: head });
    }
    // A story whose feed gave no picture, and that the fetch's page budget did not reach: the page asks once, when a reader opens the story.
    // Only a stored story's own link is ever looked at, and the answer is kept at the edge for a week, so one story costs one page fetch.
    if (req.method === "GET" && path === "/picture") {
      const pub = url.searchParams.get("pub") || "", id = url.searchParams.get("id") || "", key = new Request(`${url.origin}/picture?pub=${encodeURIComponent(pub)}&id=${encodeURIComponent(id)}`);
      const hit = await caches.default.match(key); if (hit) return hit;
      let it = null;
      if (/^[\w.-]{1,80}$/.test(pub)) {
        const meta = JSON.parse(await env.STORE.get("meta") || "null"), p = meta?.publications.find(x => x.id === pub);
        if (meta?.v !== 2) it = JSON.parse(await env.STORE.get(`items:${pub}`) || "[]").find(i => String(i.id) === id);
        else if (p) {   // the head first; the sealed segments, newest first, only if it is not there (a reader opens recent stories, so rarely)
          const h = JSON.parse(await env.STORE.get(headKey(unitOf(p))) || "null");
          it = h?.items.find(i => i.id === id) || null;
          for (const s of it || !h ? [] : [...h.segs].sort((a, b) => b.to - a.to).slice(0, 6)) { it = JSON.parse(await env.STORE.get(segKey(unitOf(p), s.k)) || "[]").find(i => i.id === id); if (it) break; }
        }
      }
      if (!it) return json({ image: null }, 404);
      let image = it.image || (await ogMeta(it.link)).image || null; if (image && !/^https:\/\//i.test(image)) image = null;
      const res = new Response(JSON.stringify({ image }), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=604800" } });
      ctx.waitUntil(caches.default.put(key, res.clone())); return res;
    }
    if (req.method === "GET" && path === "/status") {
      const meta = JSON.parse(await env.STORE.get("meta") || "null"), running = !!(await env.STORE.get("lock"));
      return json({ running, data_mtime: meta ? Date.parse(meta.generated) / 1000 : null, cloud: true });
    }
    // The registry as the public sees it is the starter set. Feeds that readers added are theirs: only the operator's token lists them all.
    if (req.method === "GET" && path === "/publications") { const cfg = JSON.parse(await env.STORE.get("config") || '{"publications":[]}'); return json(authed(req, env) ? { ...cfg, complete: true } : { ...cfg, publications: (cfg.publications || []).filter(p => !p.unvetted) }); }
    if (req.method === "GET" && path === "/reports") { if (!authed(req, env)) return json({ error: "token required" }, 401); return json({ reports: (await env.DB.prepare("SELECT r.id, r.kind, r.target, r.note, r.created_at, u.screen_name AS reported_by FROM reports r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 200").all()).results }); }
    if (req.method === "POST") {
      if (!authed(req, env)) return json({ ok: false, error: env.ADMIN_TOKEN ? "token required" : "ADMIN_TOKEN secret is not set on this Worker" }, 401);
      if (path === "/refresh") {
        if (await env.STORE.get("lock")) return json({ ok: false, error: "a refresh is already running" }, 409);
        await env.STORE.put("lock", "1", { expirationTtl: 180 });
        try { if (url.searchParams.get("support") === "1") { const cfg = JSON.parse(await env.STORE.get("config") || "{}"), n = await supportPass(env, cfg.publications || [], 20); return json({ ok: true, checked: n, unchecked: (cfg.publications || []).filter(p => !p.support_checked).length, found: (cfg.publications || []).filter(p => p.support).map(p => `${p.id}: ${p.support.label} ${p.support.url}`) }); }
          if (url.searchParams.get("migrate") === "1") { resetOps(); return json({ ok: true, output: await migrate(env), ops: opsNote() }); }
          if (url.searchParams.get("redo")) return json(await runRedo(env, Math.min(30, +url.searchParams.get("redo") || 7), 120, url.searchParams.get("dry") === "1"));
          return json(url.searchParams.get("retag") === "1" ? await runRetag(env) : await runFetch(env, { recheck: url.searchParams.get("recheck") === "1" })); }
        catch (e) { return json({ ok: false, error: `${e.name}: ${e.message}` }, 500); }
        finally { ctx.waitUntil(env.STORE.delete("lock")); }
      }
      if (path === "/probe") {
        let body; try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
        if (!body.url) return json({ error: "no url" }, 400);
        const wait = await limit(env, "probe", "admin", LIMITS.probe_per_token_minute, 60);   // each lookup fans out to a dozen fetches
        if (wait) return json({ error: `Too many lookups. Try again in ${wait} seconds.` }, 429);
        return json(await probe(String(body.url).trim()));
      }
      if (path === "/publications") {
        let pubs, complete; try { const b = await req.json(); pubs = b.publications; complete = b.complete === true; } catch { return json({ ok: false, error: "bad JSON" }, 400); }
        if (!Array.isArray(pubs) || !pubs.length) return json({ ok: false, error: "publications must be a non-empty list" }, 400);
        const ids = pubs.map(p => p.id); if (new Set(ids).size !== ids.length) return json({ ok: false, error: "duplicate ids" }, 400);
        for (const p of pubs) for (const k of ["id", "name", "short", "color", "ink", "home", "feed"]) if (typeof p[k] !== "string" || !p[k]) return json({ ok: false, error: `${p.id || "?"}: missing ${k}` }, 400);
        const cfg = JSON.parse(await env.STORE.get("config") || "{}"), before = cfg.publications || [];
        cfg.publications = pubs.map(p => ({ ...Object.fromEntries(["id", "name", "short", "color", "ink", "home", "feed"].map(k => [k, p[k]])), ...(p.group ? { group: String(p.group), section: String(p.section || "") } : {}), ...(p.unvetted ? { unvetted: true } : {}), ...(p.support_checked ? { support: p.support || null, support_why: p.support_why || "", support_checked: p.support_checked } : {}), tags: (Array.isArray(p.tags) ? p.tags : []).map(t => String(t).trim()).filter(Boolean).slice(0, 12) }));
        // Unless the dialog was loaded with the operator's token (and so saw everything), feeds that readers added are not part of what was
        // sent: keep them, or saving the list would silently remove other people's feeds.
        if (!complete) { const sent = new Set(cfg.publications.map(p => p.id)); cfg.publications.push(...before.filter(p => p.unvetted && !sent.has(p.id))); }
        await env.STORE.put("config", JSON.stringify(cfg));
        return json({ ok: true, count: pubs.length });
      }
      return json({ ok: false, error: "unknown endpoint" }, 404);
    }
    return env.ASSETS.fetch(req);
  },
  // Two schedules (wrangler.jsonc). On the hour and half hour: fetch the feeds, which with many feeds uses most of the run's 1,000
  // operations and leaves some for tagging. At 2, 17, 32 and 47 past: a run that fetches nothing and spends its allowance on Jev. The one
  // two minutes after each fetch tags what it brought; the later one catches up anything still waiting. A tagging run with nothing to do
  // costs two reads (the lock and `meta`) and no writes, and takes no lock.
  async scheduled(event, env, ctx) {
    await seed(env);
    if (await env.STORE.get("lock")) return;
    const fetching = event.cron === "*/30 * * * *";
    if (!fetching) { const meta = JSON.parse(await env.STORE.get("meta") || "null"); if (meta?.v === 2 && !Object.keys(meta.tag || {}).length) return; }
    await env.STORE.put("lock", "1", { expirationTtl: 180 });
    try { const r = fetching ? await runFetch(env) : await runRetag(env); console.log(r.output); }
    catch (e) { console.error("fetch run failed", e); }
    finally { await env.STORE.delete("lock"); }
  },
};
