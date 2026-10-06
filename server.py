#!/usr/bin/env python3
"""Serve the pages and run fetch.py on demand.

    python3 server.py            # http://localhost:8787
POST /refresh       runs fetch.py (one at a time) and returns its output as JSON.
GET  /status        reports whether a refresh is running and when data.json last changed.
GET  /publications  returns feeds.json.
POST /publications  replaces the publication list in feeds.json (other settings kept).
POST /probe         {"url": ...} finds the RSS/Atom feed for a site and reports its title and item count.
"""
import json, re, subprocess, sys, threading, time, urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urljoin, urlparse

sys.path.insert(0, str(Path(__file__).parent))
import urllib.parse
import fetch as feedlib          # reuse get() and parse_feed()

HERE = Path(__file__).parent
PORT = 8787
PY = "/opt/homebrew/opt/python@3.11/bin/python3.11"          # see README: python@3.14 here lacks pyexpat
if not Path(PY).exists():
    PY = sys.executable
lock = threading.Lock()


def feed_title(raw):
    m = re.search(rb"<title[^>]*>(.*?)</title>", raw, re.S | re.I)
    if not m:
        return ""
    t = re.sub(rb"<!\[CDATA\[|\]\]>", b"", m.group(1)).strip().decode("utf-8", "replace")
    return feedlib.strip_tags(t)


def looks_like_feed(raw):
    head = raw[:3000].lstrip().lower()
    return head.startswith(b"<?xml") or b"<rss" in head or b"<feed" in head or b"<rdf:rdf" in head


def probe(url):
    """Given a site or feed URL, return the first working feed."""
    if not re.match(r"https?://", url):
        url = "https://" + url
    try:
        raw = feedlib.get(url)
    except urllib.error.HTTPError as e:
        return {"error": f"site answered HTTP {e.code}"}
    except Exception as e:
        return {"error": f"could not reach it ({type(e).__name__})"}
    if looks_like_feed(raw):
        try:
            n = len(feedlib.parse_feed(raw))
        except Exception as e:
            return {"error": f"looks like a feed but would not parse ({type(e).__name__})"}
        return {"feed": url, "title": feed_title(raw), "items": n, "home": f"{urlparse(url).scheme}://{urlparse(url).netloc}"}
    html = raw[:400_000].decode("utf-8", "replace")
    site_title = feed_title(raw)
    cands = [urljoin(url, h) for h in re.findall(r"<link[^>]+type=[\"'](?:application/(?:rss|atom)\+xml)[\"'][^>]*href=[\"']([^\"']+)", html, re.I)]
    cands += [urljoin(url, h) for h in re.findall(r"<link[^>]+href=[\"']([^\"']+)[\"'][^>]*type=[\"'](?:application/(?:rss|atom)\+xml)[\"']", html, re.I)]
    base = f"{urlparse(url).scheme}://{urlparse(url).netloc}"
    cands += [base + p for p in ("/feed/", "/feed", "/rss/", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml", "/feeds/posts/default")]
    tried = []
    for c in dict.fromkeys(cands):
        tried.append(c)
        try:
            r = feedlib.get(c, timeout=10)
            if looks_like_feed(r):
                items = feedlib.parse_feed(r)
                if items:
                    return {"feed": c, "title": feed_title(r) or site_title, "items": len(items), "home": base}
        except Exception:
            continue
    return {"error": "no feed found", "tried": tried[:6], "title": site_title}


def read_json_body(handler):
    n = int(handler.headers.get("Content-Length") or 0)
    return json.loads(handler.rfile.read(n) or b"{}")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(HERE), **k)

    def log_message(self, fmt, *args):          # quieter log: skip static file hits
        if any(k in fmt % args for k in ("/refresh", "/publications", "/probe")):
            super().log_message(fmt, *args)

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # never serve secrets or tooling: dotfiles (.git, .dev.vars, .claude) and the Worker's folder stay private
        parts = urllib.parse.unquote(self.path.split("?")[0]).split("/")
        if any(x.startswith(".") for x in parts if x) or parts[1:2] == ["cloud"]:
            return self.send_error(404)
        if self.path.split("?")[0] in ("/privacy", "/terms", "/ai"):       # the Worker serves these without the extension
            self.path = self.path.split("?")[0] + ".html"
        if self.path.split("?")[0] == "/publications":
            return self.send_json(200, json.loads((HERE / "feeds.json").read_text()))
        if self.path.split("?")[0] == "/status":
            d = HERE / "data.json"
            return self.send_json(200, {"running": lock.locked(), "data_mtime": d.stat().st_mtime if d.exists() else None})
        if self.path.split("?")[0].endswith("data.json"):
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Cache-Control", "no-store")
            body = (HERE / "data.json").read_bytes(); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
        return super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        if route == "/probe":
            try:
                url = (read_json_body(self).get("url") or "").strip()
            except Exception:
                return self.send_json(400, {"error": "bad JSON"})
            if not url:
                return self.send_json(400, {"error": "no url"})
            return self.send_json(200, probe(url))
        if route == "/publications":
            try:
                pubs = read_json_body(self).get("publications")
                assert isinstance(pubs, list) and pubs, "publications must be a non-empty list"
                ids = [p["id"] for p in pubs]
                assert len(ids) == len(set(ids)), "duplicate ids"
                for p in pubs:
                    for k in ("id", "name", "short", "color", "ink", "home", "feed"):
                        assert isinstance(p.get(k), str) and p[k], f"{p.get('id', '?')}: missing {k}"
                    assert re.match(r"https?://", p["feed"]), f"{p['id']}: feed must be a URL"
            except Exception as e:
                return self.send_json(400, {"ok": False, "error": str(e)})
            cfg = json.loads((HERE / "feeds.json").read_text())
            cfg["publications"] = [{**{k: p[k] for k in ("id", "name", "short", "color", "ink", "home", "feed")},
                                    "tags": [str(t).strip() for t in (p.get("tags") or []) if str(t).strip()][:12]} for p in pubs]
            tmp = HERE / "feeds.json.tmp"
            tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2))
            tmp.replace(HERE / "feeds.json")
            return self.send_json(200, {"ok": True, "count": len(pubs)})
        if route != "/refresh":
            return self.send_json(404, {"ok": False, "error": "unknown endpoint"})
        if not lock.acquire(blocking=False):
            return self.send_json(409, {"ok": False, "error": "a refresh is already running"})
        try:
            t0 = time.time()
            r = subprocess.run([PY, str(HERE / "fetch.py")], cwd=HERE, capture_output=True, text=True, timeout=180)
            out = (r.stdout + r.stderr).strip()
            added = next((int(l.split("(")[1].split()[0]) for l in out.splitlines() if "added)" in l), None)
            self.send_json(200 if r.returncode == 0 else 500, {"ok": r.returncode == 0, "seconds": round(time.time() - t0, 1), "added": added, "output": out})
        except subprocess.TimeoutExpired:
            self.send_json(504, {"ok": False, "error": "fetch.py timed out after 180s"})
        finally:
            lock.release()


if __name__ == "__main__":
    print(f"Serving {HERE} at http://localhost:{PORT}  (POST /refresh runs fetch.py with {PY})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
