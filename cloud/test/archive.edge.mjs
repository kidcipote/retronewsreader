// node cloud/test/archive.edge.mjs   Edge cases of archive.js with synthetic stories.
import assert from "node:assert/strict";
import * as A from "../archive.js";
const DAY = 864e5, now = Date.parse("2026-10-05T12:00:00Z");
const story = (id, pub, ageDays, size = 4000, extra = {}) => ({ id, pub, first_seen: new Date(now).toISOString(), date: new Date(now - ageDays * DAY).toISOString(), title: id, summary: "", content: "x".repeat(size), ...extra });
const feed = (guid, link = guid) => ({ guid, link, title: guid, categories: [], summary_html: "", content_html: "" });

// 1. two sections of one outlet show the same story: one copy, with an also; and a section seen later adds its also to a held story
{
  const h = A.newHead();
  const fresh = A.absorb(h, [{ pub: "nyt", it: feed("https://x/1") }, { pub: "nyt-world", it: feed("https://x/1") }, { pub: "nyt-world", it: feed("https://x/2") }]);
  assert.equal(fresh.length, 2); assert.deepEqual(fresh[0].also, ["nyt-world"]); assert.deepEqual(fresh[1].also, []);
  for (const f of fresh) A.place(h, story(f.id, f.pub, 0, 10, f.also.length ? { also: f.also } : {}));
  A.remember(h, "nyt", [fresh[0].id]); A.remember(h, "nyt-world", fresh.map(f => f.id));
  // later run: the business section now shows story 1 too
  assert.equal(A.absorb(h, [{ pub: "nyt-business", it: feed("https://x/1") }]).length, 0);
  assert.deepEqual(h.items.find(i => i.id === fresh[0].id).also, ["nyt-world", "nyt-business"]);
  // a story sealed away is still known from the window: not added a second time
  h.items = []; assert.equal(A.absorb(h, [{ pub: "nyt", it: feed("https://x/1") }]).length, 0);
  console.log("ok  de-duplication across sections, and from the window when the story is sealed");
}
// 2. rolling: a head over ROLL_BYTES moves its oldest stories into segments; every value stays under the bounds; nothing is lost
{
  const h = A.newHead(); let n = 0;
  for (let d = 0; d < 400; d++) for (let k = 0; k < 20; k++) h.items.push(story(`s${n++}`, "busy", d * 0.5 + k / 100, 5000));
  const total = h.items.length, sealed = A.roll("f.busy", h);
  const size = l => JSON.stringify(l).length;
  assert.equal(h.items.length + sealed.reduce((a, s) => a + s.items.length, 0), total);
  assert.ok(size(h) <= A.ROLL_BYTES * 1.1, "head " + size(h)); assert.ok(Math.max(...sealed.map(s => size(s.items))) <= A.SEG_MAX * 1.1);
  assert.equal(h.segs.length, sealed.length); assert.equal(A.counts(h).busy, total);
  // rolling again with nothing new does nothing
  assert.equal(A.roll("f.busy", h).length, 0);
  // readWindow goes only as deep as the window: 7 days reads few segments
  const kv = new Map([[A.headKey("f.busy"), JSON.parse(JSON.stringify(h))], ...sealed.map(s => [s.key, s.items])]); let reads = 0;
  const get = async k => { reads++; return kv.get(k) || null; };
  const w = await A.readWindow(get, "f.busy", null, now - 7 * DAY, 30);
  assert.ok(w.every(i => Date.parse(i.date) >= now - 7 * DAY) || w.length >= 30);
  console.log(`ok  roll: ${total} stories -> head of ${h.items.length} + ${sealed.length} segments; a 7-day window read ${reads} of ${1 + sealed.length} values (${w.length} stories)`);
  // 3. keep_days: whole segments past the cutoff are dropped, the head is filtered
  const p = A.prune("f.busy", h, now - 100 * DAY);
  assert.ok(p.segs.length > 0 && h.segs.every(s => s.to >= now - 100 * DAY)); assert.ok(h.items.every(i => Date.parse(i.date) >= now - 100 * DAY));
  console.log(`ok  prune: ${p.items} head stories and ${p.segs.length} sealed segments let go`);
}
// 4. a quiet outlet is never sent empty: the newest MIN_PER_OUTLET come even if old
{
  const h = A.newHead(); for (let i = 0; i < 40; i++) h.items.push(story("q" + i, "quiet", 200 + i));
  const get = async k => k === A.headKey("f.quiet") ? h : null;
  const w = await A.readWindow(get, "f.quiet", null, now - 7 * DAY, A.MIN_PER_OUTLET);
  assert.equal(w.length, A.MIN_PER_OUTLET); console.log("ok  a quiet outlet still sends its newest", w.length);
}
// 5. a feed leaves a group: its story moves to the section that also ran it; the rest of its memory goes
{
  const h = A.newHead(); h.items.push(story("a", "nyt", 1, 10, { also: ["nyt-world"] }), story("b", "nyt", 1, 10)); h.win.nyt = ["a", "b"]; h.vol.nyt = [1];
  A.dropFeeds(h, new Set(["nyt-world"]));
  assert.deepEqual(h.items.map(i => [i.id, i.pub]), [["a", "nyt-world"]]); assert.ok(!h.win.nyt && !h.vol.nyt);
  console.log("ok  removed feed: shared story moves to the other section, its own story goes");
}
