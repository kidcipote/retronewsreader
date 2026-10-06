// A tagger that needs no outside service: keyword rules read from taxonomy.json. The Worker uses it when there is no TYPESAFE_API_KEY (Jev).
// The same as tag_rules.py (the Mac's), result for result; keep the two alike. See tag_rules.py for what it does.
const MIN_SCORE = 2;   // a story needs this many points (one word in the headline, or two in the text) to be given a topic; below it, "Other"
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (text, word) => (text.match(new RegExp(`(?<![a-z0-9])${esc(word)}(?![a-z0-9])`, "g")) || []).length;
export function ruleTags(item, taxonomy) {
  const head = (item.title || "").toLowerCase(), rest = ((item.summary || "") + " " + (item.content || "").replace(/<[^>]+>/g, " ").slice(0, 600)).toLowerCase();
  const scores = [];
  for (const [topic, words] of Object.entries(taxonomy.keywords || {})) if (topic in taxonomy.topics) {
    const s = words.reduce((n, w) => n + 3 * count(head, w.toLowerCase()) + count(rest, w.toLowerCase()), 0);
    if (s) scores.push([topic, s]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  const r3 = x => Math.round(x * 1000) / 1000;
  const topics = scores.length && scores[0][1] >= MIN_SCORE
    ? [{ name: scores[0][0], p: r3(Math.min(0.95, 0.5 + scores[0][1] / 20)) }, ...scores.slice(1).filter(([, s]) => s >= 2).slice(0, 3).map(([name, s]) => ({ name, p: r3(Math.min(0.9, 0.6 + s / 40)) }))]
    : [{ name: "Other", p: 0.5 }];
  const text = head + " " + rest, hoodOf = {};
  for (const [b, hoods] of Object.entries(taxonomy.boroughs)) for (const h of hoods) hoodOf[h] = b;
  const best = list => list.map(n => [count(text, n.toLowerCase()), n]).sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : -1))[0];
  let places = [];
  const h = best(Object.keys(hoodOf));
  if (h && h[0]) places = [{ name: h[1], p: 0.8 }, { name: hoodOf[h[1]], p: 0.8 }];
  else { const b = best(Object.keys(taxonomy.boroughs)); if (b && b[0]) places = [{ name: b[1], p: 0.8 }]; }
  return { topics, places };
}
