// node cloud/test/archive.check.mjs <data.json backup>   Builds the per-outlet layout from a whole archive and checks nothing is lost.
import { readFileSync } from "node:fs";
import * as A from "../archive.js";
const data = JSON.parse(readFileSync(process.argv[2], "utf8")), pubs = data.publications;
const now = Date.parse(data.generated), kv = new Map();
const built = A.build(data, pubs, now);
let biggest = 0, nSeg = 0;
for (const [u, { head, sealed }] of built) {
  for (const s of sealed) { const t = JSON.stringify(s.items); kv.set(s.key, t); biggest = Math.max(biggest, t.length); nSeg++; }
  const t = JSON.stringify(head); kv.set(A.headKey(u), t); biggest = Math.max(biggest, t.length);
}
console.log(`${built.size} outlets, ${nSeg} sealed segments, ${kv.size} values, largest ${(biggest / 1e6).toFixed(2)} MB`);
const get = async k => kv.has(k) ? JSON.parse(kv.get(k)) : null;
// 1. nothing lost: for every feed, the same story ids as the old archive (pub or also)
const want = new Map(); for (const i of data.items) for (const p of [i.pub, ...(i.also || [])]) (want.get(p) || want.set(p, new Set()).get(p)).add(i.id);
const got = new Map(); let total = 0;
for (const [u, { head }] of built) for (const k of [A.headKey(u), ...head.segs.map(s => A.segKey(u, s.k))]) {
  const v = await get(k), items = v.items || v; total += items.length;
  for (const i of items) for (const p of [i.pub, ...(i.also || [])]) (got.get(p) || got.set(p, new Set()).get(p)).add(i.id);
}
let bad = 0; for (const [p, s] of want) { const g = got.get(p) || new Set(); if (g.size !== s.size || [...s].some(x => !g.has(x))) { bad++; console.log("MISMATCH", p, s.size, g.size); } }
console.log(`feeds compared: ${want.size}; mismatches: ${bad}; stories held: ${total} (old archive: ${data.items.length})`);
// 2. a reader's window
const mem = new Map(pubs.map(p => [p.id, A.unitOf(p)]));
for (const days of [7, 30]) {
  let n = 0, bytes = 0;
  for (const u of new Set(mem.values())) { const l = await A.readWindow(get, u, null, now - days * 864e5, A.MIN_PER_OUTLET); n += l.length; bytes += JSON.stringify(l).length; }
  console.log(`all feeds, ${days} days: ${n} stories, ${(bytes / 1e6).toFixed(1)} MB`);
}
