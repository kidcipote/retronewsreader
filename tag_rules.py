"""A tagger that needs no outside service: keyword rules read from taxonomy.json.

Used by fetch.py when there is no TYPESAFE_API_KEY (Jev). It fills the same two fields Jev does, so the page cannot tell the difference:
    topics  [{name, p}]   the first is the story's main topic, up to three more follow
    places  [{name, p}]   a neighborhood and its borough, or just a borough
`taxonomy.json` holds the lists (topics, boroughs and their neighborhoods) and, for this tagger, `keywords`: for each topic, the words and
phrases that point to it. Edit them freely. A story with no match is filed under "Other". cloud/rules.js does the same in the Worker; keep the two alike.
"""
import re

MIN_SCORE = 2   # a story needs this many points (one word in the headline, or two in the text) to be given a topic; below it, "Other"


def _count(text, word):
    return len(re.findall(r"(?<![a-z0-9])" + re.escape(word) + r"(?![a-z0-9])", text))


def rule_tags(item, taxonomy):
    head = (item.get("title") or "").lower()
    rest = ((item.get("summary") or "") + " " + re.sub(r"<[^>]+>", " ", item.get("content") or "")[:600]).lower()
    scores = {}
    for topic, words in (taxonomy.get("keywords") or {}).items():
        if topic in taxonomy["topics"]:
            s = sum(3 * _count(head, w.lower()) + _count(rest, w.lower()) for w in words)
            if s:
                scores[topic] = s
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    r3 = lambda x: round(x * 1000) / 1000
    if ranked and ranked[0][1] >= MIN_SCORE:
        topics = [{"name": ranked[0][0], "p": r3(min(0.95, 0.5 + ranked[0][1] / 20))}]
        topics += [{"name": n, "p": r3(min(0.9, 0.6 + s / 40))} for n, s in ranked[1:] if s >= 2][:3]
    else:
        topics = [{"name": "Other", "p": 0.5}]
    text = head + " " + rest
    best, hood_of = None, {}
    for borough, hoods in taxonomy["boroughs"].items():
        for h in hoods:
            hood_of[h] = borough
    hits = sorted(((_count(text, h.lower()), h) for h in hood_of), reverse=True)
    places = []
    if hits and hits[0][0]:
        places = [{"name": hits[0][1], "p": 0.8}, {"name": hood_of[hits[0][1]], "p": 0.8}]
    else:
        bh = sorted(((_count(text, b.lower()), b) for b in taxonomy["boroughs"]), reverse=True)
        if bh and bh[0][0]:
            places = [{"name": bh[0][1], "p": 0.8}]
    return {"topics": topics, "places": places}
