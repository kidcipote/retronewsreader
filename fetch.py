#!/opt/homebrew/opt/python@3.11/bin/python3.11
"""Fetch every feed in feeds.json, enrich new items, merge into data.json.

Each run ADDS what is new and keeps everything already seen, so data.json grows
into an archive. Items older than keep_days (feeds.json) are pruned.

    python3.11 fetch.py            # merge new items into data.json
    python3.11 fetch.py --fresh    # ignore the existing archive and start over
    python3.11 fetch.py --retag    # fetch nothing; tag every archived story that has no topics yet

New stories are tagged by Jev (TypeSafe AI) against the fixed lists in taxonomy.json: each item gets
`topics` and `places`, both [{name, p}]. The key is TYPESAFE_API_KEY, from the environment or cloud/.dev.vars;
without it tagging is skipped and stories file under "Other".

Standard library only. (Homebrew python@3.14 on this Mac is missing pyexpat; 3.11 works.)
"""
import json, os, re, sys, html, time
import urllib.request, urllib.error
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

HERE = Path(__file__).parent
CONFIG = json.loads((HERE / "feeds.json").read_text())
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

NS = {
    "content": "http://purl.org/rss/1.0/modules/content/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "media": "http://search.yahoo.com/mrss/",
    "atom": "http://www.w3.org/2005/Atom",
}


def get(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------- text helpers ----------

# ---- scrub: the catch-all for what a feed leaves in a story's text that is not the story ----
# Every title, summary and story text goes through this one step (scrub() in cloud/worker.js is the twin, and app.js runs the same on what is
# already stored). It removes CDATA marks, written out or escaped; XML declarations, doctypes and comments; control and zero-width
# characters; WordPress shortcodes; and stray marks left at the very start (]]>, -->, >). It repairs text escaped twice and the commonest
# mis-decoded characters. Each repair fires only on a pattern that is never right as written. To add a case, add a line here and in the twin.
MOJIBAKE = [("â€™", "’"), ("â€˜", "‘"), ("â€œ", "“"), ("â€\u009d", "”"), ("â€“", "–"), ("â€”", "—"), ("â€¦", "…"), ("Â ", " ")]


def scrub(s):
    s = s or ""
    if not s:
        return s
    s = re.sub(r"<!\[CDATA\[|\]\]>|&lt;!\[CDATA\[|\]\]&gt;", "", s)
    s = re.sub(r"<\?xml.*?\?>|<!DOCTYPE[^>]*>|<!--.*?-->", "", s, flags=re.S | re.I)
    s = re.sub("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f﻿​⁠]", "", s)
    s = re.sub(r"&amp;(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);", r"&\1;", s, flags=re.I)
    if not re.search(r"<[a-z][^>]*>", s, re.I) and re.search(r"&lt;/?(p|a|br|div|img|strong|em|span|h[1-6]|ul|li|figure|blockquote)\b[^&]*&gt;", s, re.I):
        s = re.sub(r"&#0?39;", "'", s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')).replace("&amp;", "&")
    s = re.sub(r"\[/?(caption|embed|gallery|video|audio|playlist|vc_\w+)[^\]]*\]", "", s, flags=re.I)
    for bad, good in MOJIBAKE:
        s = s.replace(bad, good)
    if len(re.findall("[ÂÃ][\x80-\xbf]", s)) >= 3:   # UTF-8 read as Latin-1 ("Ã©" for "é"), only when plainly systematic
        def fix(m):
            try:
                return m.group(0).encode("latin-1").decode("utf-8")
            except Exception:
                return m.group(0)
        s = re.sub("[ÂÃ][\x80-\xbf]", fix, s)
    return re.sub(r"^(?:\s|<br\s*/?>|&nbsp;|>|-->|\]|&gt;)+", "", s, flags=re.I).strip()


def strip_tags(s):
    s = re.sub(r"<[^>]+>", " ", scrub(s))
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def sanitize(s):
    """Keep article HTML but drop anything executable or embedded."""
    s = scrub(s)
    s = re.sub(r"<(script|style|iframe|object|embed|form)[^>]*>.*?</\1>", "", s, flags=re.S | re.I)
    s = re.sub(r"<(script|style|iframe|object|embed|form)[^>]*/?>", "", s, flags=re.I)
    s = re.sub(r"\son\w+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)", "", s, flags=re.I)
    s = re.sub(r"javascript:", "", s, flags=re.I)
    return s.strip()


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    try:
        return parsedate_to_datetime(s)
    except Exception:
        pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def first_img(html_s):
    m = re.search(r"<img[^>]+src=[\"']([^\"']+)", html_s or "", flags=re.I)
    return m.group(1) if m else None


# ---------- feed parsing (RSS 2.0 + Atom) ----------

def text(el, path, ns=None):
    node = el.find(path, ns or NS)
    # The XML parser has already opened real CDATA sections. Some feeds wrap their text a second time (City & State), which leaves the
    # marks themselves in the text: take them out, so no "<![CDATA[" or "]]>" is ever left in a story. (cdata() in cloud/worker.js is the twin.)
    return (node.text or "").replace("<![CDATA[", "").replace("]]>", "").strip() if node is not None and node.text else ""


def parse_feed(xml_bytes):
    root = ET.fromstring(xml_bytes)
    items = []
    if root.tag.endswith("rss") or root.tag == "rss":
        for it in root.iter("item"):
            content = text(it, "content:encoded")
            desc = text(it, "description")
            media = it.find("media:content", NS)
            thumb = it.find("media:thumbnail", NS)
            enc = it.find("enclosure")
            image = None
            for cand in (media, thumb, enc):
                if cand is not None:
                    u = cand.get("url")
                    t = cand.get("type", "") or cand.get("medium", "")
                    if u and ("image" in t or t == "" or re.search(r"\.(jpe?g|png|webp|gif)", u, re.I)):
                        image = u
                        break
            items.append({
                "title": strip_tags(text(it, "title")),
                "link": text(it, "link") or (it.find("guid").text if it.find("guid") is not None else ""),
                "guid": text(it, "guid") or text(it, "link"),
                "date": parse_date(text(it, "pubDate") or text(it, "dc:date")),
                "author": strip_tags(text(it, "dc:creator") or text(it, "author")),
                "categories": [strip_tags(c.text) for c in it.findall("category") if c.text],
                "summary_html": desc,
                "content_html": content or desc,
                "image": image or first_img(content) or first_img(desc),
            })
    else:  # Atom
        for it in root.findall("atom:entry", NS):
            link = ""
            for l in it.findall("atom:link", NS):
                if l.get("rel", "alternate") == "alternate":
                    link = l.get("href", "")
                    break
            content = text(it, "atom:content")
            summary = text(it, "atom:summary")
            items.append({
                "title": strip_tags(text(it, "atom:title")),
                "link": link,
                "guid": text(it, "atom:id") or link,
                "date": parse_date(text(it, "atom:published") or text(it, "atom:updated")),
                "author": strip_tags(text(it, "atom:author/atom:name")),
                "categories": [c.get("term", "") for c in it.findall("atom:category", NS)],
                "summary_html": summary,
                "content_html": content or summary,
                "image": first_img(content) or first_img(summary),
            })
    return items


# ---------- article page enrichment ----------

OUTLET_MARK = re.compile(r"logo|placeholder|favicon|default[-_]?(?:share|image|og)|share[-_]?default", re.I)


def og_meta(url):
    """Pull og:image and og:description from the article page. Best effort."""
    try:
        page = get(url, timeout=10).decode("utf-8", "replace")[:200_000]
    except Exception:
        return {}
    out = {}
    for prop, key in (("og:image", "image"), ("og:description", "description")):
        m = re.search(r"<meta[^>]+(?:property|name)=[\"']%s[\"'][^>]+content=[\"']([^\"']+)" % re.escape(prop), page, re.I) \
            or re.search(r"<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+(?:property|name)=[\"']%s[\"']" % re.escape(prop), page, re.I)
        if m:
            out[key] = html.unescape(m.group(1))
    if out.get("image") and OUTLET_MARK.search(out["image"]):   # the outlet's own logo, which a live blog or a bare page names as its picture
        del out["image"]
    return out


def embeddable(url):
    """Can this site be shown inside an <iframe> on another origin? Checked once per publication per run.
    Returns True, False, or None when the site would not answer a script (treated as not embeddable)."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
        with urllib.request.urlopen(req, timeout=10) as r:
            xfo = (r.headers.get("X-Frame-Options") or "").upper()
            csp = r.headers.get("Content-Security-Policy") or ""
    except Exception:
        return None
    if "DENY" in xfo or "SAMEORIGIN" in xfo:
        return False
    m = re.search(r"frame-ancestors\s+([^;]+)", csp, re.I)
    if m:
        sources = {t.strip("'").lower() for t in m.group(1).split()}
        # only a true wildcard or a scheme-wide allowance lets another origin frame the page
        return bool(sources & {"*", "http:", "https:"})
    return True


# ---------- where to pay an outlet (mirror findSupport in cloud/worker.js) ----------

SUPPORT_WORDS = re.compile(r"donat|support|subscri|member|join|contribut|sustain|give", re.I)
SUPPORT_NOT = re.compile(r"log ?in|sign ?in|newsletter|podcast|gift|manage|account|customer|help|faq|unsubscribe|advertis|privacy|terms|rss", re.I)


def support_label(t):
    return "Donate" if re.search(r"donat|contribut|give|sustain", t, re.I) else "Become a member" if re.search(r"member|join", t, re.I) else "Subscribe"


def find_support(home):
    """Read the outlet's home page, collect links that look like ways to give it money, let Jev pick the real one.
    Returns {"url", "label"}, or the reason there is none ("blocked" or "notfound") so the page can say why. No guessing either way."""
    from urllib.parse import urljoin, urlsplit
    parts = urlsplit(home)
    origin = f"{parts.scheme}://{parts.netloc}"
    try:
        page = get(origin + "/", timeout=10).decode("utf-8", "replace")[:700_000]
    except Exception:
        # The home page refused (the Times does this) but the outlet's own pay page may still answer. Try the usual addresses and
        # accept one only if it really exists on the same site and its title is about paying: nothing is assumed.
        def site(h):   # the part of an address that identifies one site: three labels where a country puts a category before its code (uol.com.br)
            p = h.lower().removeprefix("www.").split(".")
            return ".".join(p[-3:] if len(p) >= 3 and len(p[-1]) == 2 and p[-2] in ("com", "co", "org", "net", "gov", "edu", "ac") else p[-2:])
        for path in ("/subscribe", "/donate", "/membership"):
            try:
                req = urllib.request.Request(origin + path, headers={"User-Agent": UA, "Accept": "text/html"})
                with urllib.request.urlopen(req, timeout=8) as r:
                    final, head = r.geturl(), r.read(20_000).decode("utf-8", "replace")
                t = re.search(r"<title[^>]*>(.*?)</title>", head, re.I | re.S)
                title = strip_tags(t.group(1)) if t else ""
                if site(urlsplit(final).netloc) == site(parts.netloc) and SUPPORT_WORDS.search(title + " " + final):
                    return {"url": final.split("?")[0], "label": support_label(path + " " + title)}
            except Exception:
                pass
        return "blocked"
    if parts.netloc.endswith(".substack.com") or "substackcdn.com" in page[:30_000]:
        return {"url": origin + "/subscribe", "label": "Subscribe"}
    cands, seen = [], set()
    for m in re.finditer(r"<a\b[^>]*href=[\"']([^\"'#]+)[\"'][^>]*>(.*?)</a>", page, re.I | re.S):
        text, href = strip_tags(m.group(2))[:60], urljoin(origin, html.unescape(m.group(1)))
        both = text + " " + href
        if not href.startswith("https://") or href in seen or not SUPPORT_WORDS.search(both):   # https only; the Worker also restricts outlets nobody has vetted
            continue
        if SUPPORT_NOT.search(both) and not re.search(r"donat|member", text, re.I):
            continue
        seen.add(href)
        cands.append((href, text))
        if len(cands) >= 30:
            break
    if not cands:
        return "notfound"
    # A link that plainly says Donate or Membership is trusted as it stands. Jev settles the rest (is this "Subscribe" a paid one?),
    # and if it finds nothing, the plain one still counts: outlets often take donations on a different address from their own.
    plain = next((c for c in cands if re.match(r"(donate|give|become a member|membership|join us|support us)\b", c[1], re.I)), None)
    pick = plain or next((c for c in cands if re.search(r"donat|member|subscri", c[1], re.I)), None)
    key = jev_key()
    if key:
        criteria = {f"c{i}": f'"{t}" -> {h}' for i, (h, t) in enumerate(cands)}
        criteria["none"] = "None of these is a way to pay the outlet"
        q = {"pay": {"type": "choice", "criteria": criteria, "instructions": "These are links from a news outlet's home page. Which one is where a reader goes to give the outlet money: to donate, become a paying member, or buy a subscription? Not a free newsletter sign-up, a login, a gift, or a store."}}
        try:
            req = urllib.request.Request(JEV_URL, data=json.dumps({"model": "jev-latest", "state": {"outlet": origin}, "questions": q}).encode(),
                                         headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "nyc-feed-reader"})
            with urllib.request.urlopen(req, timeout=20) as r:
                a = json.loads(r.read())["answers"]["pay"]
            # several good links split the vote between them, so the test is that "none" lost
            pick = cands[int(a["choice"][1:])] if a["choice"] != "none" and a["probabilities"].get("none", 0) < 0.4 else plain
        except Exception:
            pass
    return {"url": pick[0], "label": support_label(pick[1] + " " + pick[0])} if pick else "notfound"


def support_pass(pubs, limit=4):
    """Look up a few publications that have not been checked yet and record the answer in feeds.json."""
    todo = [p for p in pubs if not p.get("support_checked")][:limit]
    if not todo:
        return
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    with ThreadPoolExecutor(max_workers=4) as ex:
        for p, found in zip(todo, ex.map(lambda p: find_support(p["home"]), todo)):
            p["support"], p["support_why"], p["support_checked"] = (found, "", day) if isinstance(found, dict) else (None, found, day)
    (HERE / "feeds.json").write_text(json.dumps(CONFIG, ensure_ascii=False, indent=2) + "\n")
    print(f"  looked up where to support {len(todo)} outlets: " + ", ".join(f"{p['id']}={'yes' if p['support'] else 'none'}" for p in todo))


# ---------- tagging (Jev; mirror tagStories in cloud/worker.js) ----------

TAXONOMY = json.loads((HERE / "taxonomy.json").read_text())
JEV_URL = "https://api.typesafe.ai/v1/systemone"
TAG_WORKERS = 6            # parallel requests to Jev
TAG_MAX_PER_RUN = 300      # a scheduled run tags at most this many; --retag has no cap


def jev_key():
    key = os.environ.get("TYPESAFE_API_KEY")
    if key:
        return key.strip()
    try:
        for line in (HERE / ".dev.vars").read_text().splitlines():
            if line.startswith("TYPESAFE_API_KEY="):
                return line.split("=", 1)[1].strip() or None
    except OSError:
        pass
    return None


def slug(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")


def jev_questions():
    """One request per story: a Choice for the primary topic, a Noul per topic for secondary ones,
    a Choice over boroughs + none, a Choice over neighborhoods + none."""
    topics = TAXONOMY["topics"]
    q = {"topic": {"type": "choice", "instructions": "Which topic is this news story primarily about?", "criteria": topics}}
    for name, desc in topics.items():
        if name != "Other":
            q["t_" + slug(name)] = {"type": "noul", "instructions": f"Is a substantial part of this news story about {name} ({desc})?"}
    q["borough"] = {"type": "choice", "instructions": "Which New York City borough is this story set in or mainly about?",
                    "criteria": {**{b: None for b in TAXONOMY["boroughs"]}, "none": "No single borough: the whole city, several boroughs, or somewhere outside New York City"}}
    q["neighborhood"] = {"type": "choice", "instructions": "Which New York City neighborhood is this story set in or mainly about?",
                         "criteria": {**{n: f"in {b}" for b, ns in TAXONOMY["boroughs"].items() for n in ns}, "none": "No specific neighborhood on this list, or outside New York City"}}
    return q


def read_tags(answers):
    """Jev's answers -> {"topics": [{name, p}], "places": [{name, p}]}. Primary topic first."""
    r3 = lambda x: round(float(x), 3)
    t = answers["topic"]
    topics = [{"name": t["choice"], "p": r3(t["probabilities"][t["choice"]])}]
    extra = []
    for name in TAXONOMY["topics"]:
        a = answers.get("t_" + slug(name))
        if a and name != t["choice"] and a["noul"] >= TAXONOMY["secondary_threshold"]:
            extra.append({"name": name, "p": r3(a["noul"])})
    topics += sorted(extra, key=lambda x: -x["p"])[:3]
    places = []
    for k in ("borough", "neighborhood"):
        a = answers[k]
        p = a["probabilities"][a["choice"]]
        if a["choice"] != "none" and p >= TAXONOMY["place_threshold"]:
            places.append({"name": a["choice"], "p": r3(p)})
    return {"topics": topics, "places": places}


def tag_one(item, pub_name, key, questions):
    state = {"publication": pub_name, "headline": item["title"], "summary": item.get("summary", ""),
             "opening_text": strip_tags(item.get("content", ""))[:600], "publisher_categories": item.get("categories", [])}
    body = json.dumps({"state": state, "model": "jev-latest", "questions": questions}).encode()
    for attempt in range(4):
        req = urllib.request.Request(JEV_URL, data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "nyc-feed-reader"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return read_tags(json.loads(r.read())["answers"])
        except urllib.error.HTTPError as e:
            if e.code not in (429, 529, 500, 502, 503) or attempt == 3:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 3:
                raise
        time.sleep(1.5 * 2 ** attempt)


def tag_stories(items, pub_names, limit=TAG_MAX_PER_RUN):
    """Tag every item that has no `topics` yet, newest first, in place. Returns how many were tagged."""
    todo = [i for i in items if not isinstance(i.get("topics"), list)]
    key = jev_key()
    if not todo:
        return 0
    if not key:
        from tag_rules import rule_tags   # no Jev key: tag by the keyword rules in taxonomy.json
        todo = todo[:limit] if limit else todo
        for it in todo:
            it.update(rule_tags(it, TAXONOMY))
        print(f"  tagged {len(todo)} stories by keyword rules (no TYPESAFE_API_KEY)")
        return len(todo)
    todo.sort(key=lambda x: x["date"], reverse=True)
    if limit:
        todo = todo[:limit]
    questions, failed = jev_questions(), []

    def work(it):
        try:
            return tag_one(it, pub_names.get(it["pub"], it["pub"]), key, questions)
        except Exception as e:
            failed.append(f"{type(e).__name__}{' ' + str(e.code) if hasattr(e, 'code') else ''}")
            return None
    with ThreadPoolExecutor(max_workers=TAG_WORKERS) as ex:
        results = list(ex.map(work, todo))
    n = 0
    for it, tags in zip(todo, results):
        if tags:
            it.update(tags)
            n += 1
    print(f"  tagged {n} stories" + (f"; {len(failed)} failed ({failed[0]})" if failed else ""))
    return n


def write_data(data):
    tmp = HERE / "data.json.tmp"
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    tmp.replace(HERE / "data.json")   # atomic swap so a page mid-load never sees a half-written file


def retag():
    """Backfill: tag every archived story without topics. Fetches no feeds."""
    path = HERE / "data.json"
    data = json.loads(path.read_text())
    names = {p["id"]: p["name"] for p in data["publications"]}
    before = sum(1 for i in data["items"] if not isinstance(i.get("topics"), list))
    print(f"{datetime.now().strftime('%Y-%m-%d %H:%M')}  retag: {before} of {len(data['items'])} stories untagged")
    tag_stories(data["items"], names, limit=None)
    # the scheduled fetch may have rewritten data.json meanwhile: carry the tags onto the newest copy
    tags = {i["id"]: i for i in data["items"] if isinstance(i.get("topics"), list)}
    latest = json.loads(path.read_text())
    for i in latest["items"]:
        if not isinstance(i.get("topics"), list) and i["id"] in tags:
            i["topics"], i["places"] = tags[i["id"]]["topics"], tags[i["id"]]["places"]
    write_data(latest)
    left = sum(1 for i in latest["items"] if not isinstance(i.get("topics"), list))
    print(f"  wrote data.json: {left} of {len(latest['items'])} stories still untagged ({left / max(1, len(latest['items'])):.1%})")


# ---------- main ----------

def fetch_publication(pub):
    t0 = time.time()
    try:
        raw = get(pub["feed"])
        items = parse_feed(raw)
        status = "ok"
    except urllib.error.HTTPError as e:
        items, status = [], f"http {e.code}"
    except Exception as e:
        items, status = [], f"error: {type(e).__name__}"
    items = items[: CONFIG.get("max_per_publication", 25)]
    for it in items:
        it["pub"] = pub["id"]
    print(f"  {pub['name']:<22} {status:<12} {len(items):>3} items  {time.time()-t0:4.1f}s", flush=True)
    return pub["id"], status, items


def load_existing():
    path = HERE / "data.json"
    if "--fresh" in sys.argv or not path.exists():
        return {}
    try:
        old = json.loads(path.read_text())
        return {it["id"]: it for it in old.get("items", [])}
    except Exception as e:
        print(f"  could not read existing data.json ({type(e).__name__}); starting fresh")
        return {}


def item_id(key):
    return re.sub(r"[^a-z0-9]+", "-", key.lower())[-80:]


def main():
    pubs = CONFIG["publications"]
    existing = load_existing()
    print(f"{datetime.now().strftime('%Y-%m-%d %H:%M')}  archive has {len(existing)} items; fetching {len(pubs)} feeds...")
    with ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(fetch_publication, pubs))

    fetched = [it for _, _, items in results for it in items]
    all_items = [it for it in fetched if item_id(it["guid"] or it["link"]) not in existing]
    status_by_pub = {pid: {"status": s, "count_in_feed": len(items)} for pid, s, items in results}
    print(f"  {len(fetched)} items in feeds, {len(all_items)} new")

    if CONFIG.get("fetch_article_pages"):
        need = [it for it in all_items if not it["image"]]
        print(f"Scraping {len(need)} article pages for lead images...")
        with ThreadPoolExecutor(max_workers=12) as ex:
            for it, meta in zip(need, ex.map(lambda i: og_meta(i["link"]), need)):
                it["image"] = meta.get("image")
                if not strip_tags(it["summary_html"]) and meta.get("description"):
                    it["summary_html"] = meta["description"]

    now_iso = datetime.now(timezone.utc).isoformat()
    known = {p["id"] for p in pubs}

    # A story that runs in two feeds (two sections of one outlet) is stored once; "also" lists the other feeds it appeared in.
    # (mirror of the same bookkeeping in cloud/worker.js)
    # (On the web each outlet's stories are a value of their own, cloud/archive.js: the same identity, merge, de-duplication and keep_days rules,
    # applied to one outlet at a time. This file holds the whole archive in one file, which a Mac has room for, so it needs none of that.)
    def also_in(item, pub):
        if item["pub"] != pub and pub not in item.get("also", []):
            item.setdefault("also", []).append(pub)
    for it in fetched:
        ex = existing.get(item_id(it["guid"] or it["link"] or ""))
        if ex:
            also_in(ex, it["pub"])
    for i in existing.values():   # a story outlives the feed it first came from if another of its feeds is still followed
        if "also" in i:
            i["also"] = [x for x in i["also"] if x in known]
            if i["pub"] not in known and i["also"]:
                i["pub"] = i["also"].pop(0)
            if not i["also"]:
                del i["also"]
    dropped = [i for i in existing.values() if i["pub"] not in known]
    if dropped:
        print(f"  dropping {len(dropped)} archived items from removed publications")
    out_items = [i for i in existing.values() if i["pub"] in known]
    seen = {i["id"]: i for i in out_items}
    for it in all_items:
        key = it["guid"] or it["link"]
        if not key:
            continue
        if item_id(key) in seen:
            also_in(seen[item_id(key)], it["pub"])
            continue
        d = it["date"] or datetime.now(timezone.utc)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        summary = strip_tags(it["summary_html"])
        out_items.append({
            "id": item_id(key),
            "first_seen": now_iso,
            "pub": it["pub"],
            "title": it["title"],
            "link": it["link"],
            "date": d.astimezone(timezone.utc).isoformat(),
            "author": it["author"],
            "categories": it["categories"][:6],
            "summary": summary[:320] + ("…" if len(summary) > 320 else ""),
            "content": sanitize(it["content_html"]),
            # an image address lifted out of HTML still has its & written as &amp;: put it back, or an outlet that signs its
            # image addresses refuses it (the same line is in cloud/worker.js)
            "image": html.unescape(it["image"]) if it["image"] else it["image"],
        })
        seen[item_id(key)] = out_items[-1]
    keep_days = CONFIG.get("keep_days")
    if keep_days:
        cutoff = (datetime.now(timezone.utc).timestamp() - keep_days * 86400)
        before = len(out_items)
        out_items = [i for i in out_items if datetime.fromisoformat(i["date"]).timestamp() >= cutoff]
        if before != len(out_items):
            print(f"  pruned {before - len(out_items)} items older than {keep_days} days")
    out_items.sort(key=lambda x: x["date"], reverse=True)
    tag_stories(out_items, {p["id"]: p["name"] for p in pubs})
    support_pass(pubs)

    counts = {}
    for i in out_items:
        counts[i["pub"]] = counts.get(i["pub"], 0) + 1

    print("Checking which sites allow embedding...")
    sample = {}
    for i in out_items:
        sample.setdefault(i["pub"], i["link"])
    with ThreadPoolExecutor(max_workers=10) as ex:
        embed = dict(zip(sample, ex.map(embeddable, sample.values())))
    for pid, ok in embed.items():
        print(f"  {pid:<13} {'embeddable' if ok else 'blocks framing' if ok is False else 'no answer (assume blocked)'}")
    data = {
        "generated": now_iso,
        "publications": [{**p, **status_by_pub[p["id"]], "count": counts.get(p["id"], 0), "embeddable": bool(embed.get(p["id"]))} for p in pubs],
        "items": out_items,
    }
    write_data(data)
    print(f"  wrote data.json: {len(out_items)} items total ({len(all_items)} added), {(HERE / 'data.json').stat().st_size // 1024} KB")


if __name__ == "__main__":
    retag() if "--retag" in sys.argv else main()
