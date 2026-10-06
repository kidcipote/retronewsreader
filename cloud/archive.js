// The story archive on the web, stored per outlet. Pure functions: no KV, no network. worker.js does the reading and writing.
//
// An OUTLET is the unit of storage: the feeds that share a `group` (the sections of one newspaper), or a single feed that has none. A story
// that runs in two sections is kept once, with `also` naming the other section, so it must live where both sections can be seen together.
// (Measured on 2026-10-05: all 89 `also` links in the archive stay inside one group.)
//
// Each outlet has a HEAD, `u:<unit>`: its newest stories, plus what a run needs to know without loading anything else:
//   items  the stories held here, newest first
//   segs   the SEALED SEGMENTS, `u:<unit>:<k>`: older stories moved out when the head passed ROLL_BYTES. Each is written once and never
//          grown. { k, from, to (ms: oldest and newest story date), n, nt (untagged), c ({feed: count}) }
//   next   the number the next segment gets
//   win    per feed, the ids of the last stories its feed showed (most recent first, WIN_IDS of them). A story whose id is here is known,
//          even when it has been sealed away, so the sealed segments never need to be read to find out what is new.
//   vol    per feed, the publication times (seconds) of its stories in the last VOL_DAYS days, and last: its newest ever. File → Stories
//          by publisher reads these instead of every story.
// A value therefore never grows with time: the head is held between SEAL_TO and ROLL_BYTES, a segment is at most about SEG_MAX, and
// `keep_days` lets whole segments go once every story in them is past it.

export const ROLL_BYTES = 1.5e6, SEAL_TO = 0.75e6, SEG_MAX = 2e6;
export const WIN_IDS = 100, VOL_DAYS = 35;
export const WINDOW_DAYS = 7;      // what /data.json sends by default: stories of the last 7 days...
export const MIN_PER_OUTLET = 30;  // ...and always at least this many of each outlet's newest, so a quiet outlet is never sent empty

export const unitOf = p => p.group ? `g.${p.group}` : `f.${p.id}`;
export const headKey = u => `u:${u}`;
export const segKey = (u, k) => `u:${u}:${k}`;
export const newHead = () => ({ v: 1, items: [], segs: [], next: 0, win: {}, vol: {}, last: {} });

const ms = i => Date.parse(i.date) || 0;
const newestFirst = (a, b) => ms(b) - ms(a);
const weight = i => (i.content || "").length + (i.summary || "").length + 600;
export const isTagged = i => Array.isArray(i.topics);
export const untagged = list => list.reduce((n, i) => n + (isTagged(i) ? 0 : 1), 0);
const tally = list => { const c = {}; for (const i of list) c[i.pub] = (c[i.pub] || 0) + 1; return c; };
export const itemId = key => key.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(-80);

// stories per feed (by the feed a story first came from), across the head and its sealed segments
export function counts(head) {
  const c = tally(head.items);
  for (const s of head.segs) for (const [p, n] of Object.entries(s.c || {})) c[p] = (c[p] || 0) + n;
  return c;
}
// What each feed in this outlet mostly covers: its three commonest main topics over its newest 200 stories (never "Other", and only ones seen at least twice).
// A topic renamed in taxonomy.json counts under its new name. A fact about the feed, not about any reader; the picker uses it to put the suggestions in the order a reader's own reading favours.
export function topTopics(head, renamed = {}) {
  const by = {};
  for (const i of head.items.slice(0, 200)) { const raw = i.topics?.[0]?.name, t = renamed[raw] || raw; if (!t || t === "Other") continue; const m = by[i.pub] ||= {}; m[t] = (m[t] || 0) + 1; }
  return Object.fromEntries(Object.entries(by).map(([p, m]) => [p, Object.entries(m).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t)]));
}
export const untaggedIn = head => untagged(head.items) + head.segs.reduce((n, s) => n + (s.nt || 0), 0);

// A story that runs in a second feed names it in `also`. Returns whether it was newly added.
export function alsoIn(item, pub) { if (item.pub !== pub && !(item.also || []).includes(pub)) { (item.also ||= []).push(pub); return true; } return false; }

function noteVol(head, pub, item, now) {
  const t = Math.floor(ms(item) / 1000); if (!t) return;
  if (t > (head.last[pub] || 0)) head.last[pub] = t;
  if (t >= now / 1000 - VOL_DAYS * 86400) (head.vol[pub] ||= []).push(t);
}
export function trimVol(head, now) {
  const from = now / 1000 - VOL_DAYS * 86400;
  for (const p of Object.keys(head.vol)) { head.vol[p] = head.vol[p].filter(t => t >= from); if (!head.vol[p].length) delete head.vol[p]; }
}

// What is new in what the feeds showed? `incoming` is [{ pub, it }] in feed order. A story the head holds only gains an `also`; one whose
// id is in a window is known and left alone; a story seen twice in one batch is one new story with an `also`. Returns the new ones as
// [{ id, pub, it, also: [feeds] }]; the caller builds the story (it knows how to clean the text) and hands it to place().
export function absorb(head, incoming, now = Date.now()) {
  const have = new Map(head.items.map(i => [i.id, i])), known = new Set(Object.values(head.win).flat()), fresh = new Map();
  for (const { pub, it } of incoming) {
    const key = it.guid || it.link; if (!key) continue;
    const id = itemId(key), ex = have.get(id);
    if (ex) { if (alsoIn(ex, pub)) noteVol(head, pub, ex, now); continue; }
    if (fresh.has(id)) { const f = fresh.get(id); if (f.pub !== pub && !f.also.includes(pub)) f.also.push(pub); continue; }
    if (known.has(id)) continue;
    fresh.set(id, { id, pub, it, also: [] });
  }
  return [...fresh.values()];
}
// Remember what a feed showed: its newest ids first, then what it showed before.
export function remember(head, pub, ids) { head.win[pub] = [...new Set([...ids, ...(head.win[pub] || [])])].slice(0, WIN_IDS); }
export function place(head, story, now = Date.now()) {
  head.items.push(story); noteVol(head, story.pub, story, now);
  for (const a of story.also || []) noteVol(head, a, story, now);
}

// A feed has gone from the registry: its stories and memory leave the head, and a story it shared with another section moves to that one.
export function dropFeeds(head, known) {
  for (const i of head.items) {
    if (i.also) i.also = i.also.filter(x => known.has(x));
    if (!known.has(i.pub) && i.also?.length) i.pub = i.also.shift();
    if (i.also && !i.also.length) delete i.also;
  }
  head.items = head.items.filter(i => known.has(i.pub));
  for (const k of ["win", "vol", "last"]) for (const p of Object.keys(head[k])) if (!known.has(p)) delete head[k][p];
}

// keep_days: stories past it leave the head, and a sealed segment goes once every story in it is past it. Returns the segment keys to delete.
export function prune(unit, head, cutoff) {
  const before = head.items.length, gone = [];
  head.items = head.items.filter(i => ms(i) >= cutoff);
  head.segs = head.segs.filter(s => { if (s.to >= cutoff) return true; gone.push(segKey(unit, s.k)); return false; });
  return { items: before - head.items.length, segs: gone };
}

// Past ROLL_BYTES, the oldest stories leave the head, in segments of about SEG_MAX, until it is back to SEAL_TO. Returns [{ key, items }]
// to be written; the head (already updated) is written after them.
export function roll(unit, head) {
  head.items.sort(newestFirst);
  let size = head.items.reduce((n, i) => n + weight(i), 0); const out = [];
  if (size <= ROLL_BYTES) return out;
  const moved = [];
  while (size > SEAL_TO && head.items.length) { const i = head.items.pop(); moved.push(i); size -= weight(i); }
  moved.reverse();
  let chunk = [], cs = 0;
  const flush = () => {
    if (!chunk.length) return; const k = head.next++;
    head.segs.push({ k, from: ms(chunk[chunk.length - 1]), to: ms(chunk[0]), n: chunk.length, nt: untagged(chunk), c: tally(chunk) });
    out.push({ key: segKey(unit, k), items: chunk }); chunk = []; cs = 0;
  };
  for (const i of moved) { chunk.push(i); cs += weight(i); if (cs >= SEG_MAX) flush(); }
  flush(); return out;
}

// What one reader is sent from one outlet: stories that belong to their feeds (`member`, or all when null) from the last `days`, and at
// least `min` of the newest. `get(key)` returns a parsed value or null. Sealed segments are read only while they can still hold something wanted.
export async function readWindow(get, unit, member, cutoff, min) {
  const head = await get(headKey(unit)); if (!head) return [];
  const out = [], take = list => { for (const i of list) if ((!member || member(i)) && (ms(i) >= cutoff || out.length < min)) out.push(i); };
  take(head.items);
  for (const s of [...head.segs].sort((a, b) => b.to - a.to)) {
    if (s.to < cutoff && out.length >= min) break;
    const seg = await get(segKey(unit, s.k)); if (seg) take(seg);
  }
  return out;
}

// Build every outlet's head and segments from a whole archive (the old single `data` value). Deterministic: the same archive gives the same keys.
export function build(archive, pubs, now = Date.now()) {
  const known = new Set(pubs.map(p => p.id)), by = new Map(pubs.map(p => [p.id, p])), units = new Map();
  const cleaned = archive.items.map(i => ({ ...i }));
  for (const i of cleaned) {   // the same tidy-up a fetch does: a story outlives a removed feed if another of its feeds is still there
    if (i.also) i.also = i.also.filter(x => known.has(x));
    if (!known.has(i.pub) && i.also?.length) i.pub = i.also.shift();
    if (i.also && !i.also.length) delete i.also;
  }
  for (const i of cleaned) { if (!known.has(i.pub)) continue; const u = unitOf(by.get(i.pub)); if (!units.has(u)) units.set(u, []); units.get(u).push(i); }
  const result = new Map();
  for (const [u, list] of units) {
    const head = newHead(); head.items = list.sort(newestFirst);
    const mine = new Map();   // per feed: its stories, newest first, whether first or also
    for (const i of head.items) for (const p of [i.pub, ...(i.also || [])]) { (mine.get(p) || mine.set(p, []).get(p)).push(i); noteVol(head, p, i, now); }
    for (const [p, l] of mine) head.win[p] = l.slice(0, WIN_IDS).map(i => i.id);
    const sealed = roll(u, head);
    result.set(u, { head, sealed });
  }
  return result;
}
