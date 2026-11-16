#!/usr/bin/env python3
"""
fetch_paper.py - download an arXiv paper as HTML into papers/.

Why download first? The browser can't fetch arxiv.org directly (CORS), so we
grab the HTML once with Python and serve it locally.

Pipeline:
  1. Metadata (title, authors, date, abstract) from the arXiv Atom API.
  2. HTML from arxiv.org/html/{id} (native, ~late 2023+), falling back to
     ar5iv.labs.arxiv.org/html/{id} (LaTeX->HTML for older papers).
  3. Rewrite relative src/href URLs to absolute so figures + CSS still load.
  4. Save papers/{id}.html + papers/{id}.json, and refresh papers/index.json
     (the list the browser dropdown reads).

Usage:
  python fetch_paper.py                 # Attention Is All You Need
  python fetch_paper.py 1810.04805
  python fetch_paper.py https://arxiv.org/abs/2005.14165
  python fetch_paper.py --batch "1706.03762 2005.14165 1810.04805"
"""
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

DEFAULT_ID = "1706.03762"
USER_AGENT = "PaperCrawler/1.0 (educational paper viewer; python-urllib)"
DELAY_S = 3  # arXiv API etiquette: wait ~3s between requests
PAPERS = Path(__file__).parent / "papers"
ATOM = "{http://www.w3.org/2005/Atom}"

_last_request = 0.0


def get(url):
    """GET with a descriptive User-Agent, rate-limited to one request per DELAY_S."""
    global _last_request
    wait = DELAY_S - (time.time() - _last_request)
    if wait > 0:
        time.sleep(wait)
    _last_request = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.geturl(), r.read().decode("utf-8", errors="replace")


def parse_id(arg):
    """Accept '1706.03762', 'arXiv:1706.03762v5' or any arxiv.org URL."""
    m = re.search(r"(\d{4}\.\d{4,5}(?:v\d+)?|[a-z\-]+(?:\.[A-Z]{2})?/\d{7})", arg)
    if not m:
        raise SystemExit(f"Can't find an arXiv ID in {arg!r}")
    return m.group(1)


def fetch_metadata(pid):
    _, xml = get(f"http://export.arxiv.org/api/query?id_list={urllib.parse.quote(pid)}")
    entry = ET.fromstring(xml).find(f"{ATOM}entry")
    if entry is None or entry.find(f"{ATOM}title") is None:
        raise SystemExit(f"arXiv API has no entry for {pid}")
    text = lambda tag: " ".join((entry.findtext(f"{ATOM}{tag}") or "").split())
    return {
        "id": pid,
        "title": text("title"),
        "authors": [a.findtext(f"{ATOM}name") for a in entry.findall(f"{ATOM}author")],
        "published": text("published")[:10],
        "abstract": text("summary"),
    }


def absolutize(html, base):
    """Rewrite relative src/href (and srcset) to absolute URLs against `base`."""
    def fix(m):
        attr, q, url = m.group(1), m.group(2), m.group(3)
        if url.startswith(("#", "data:", "mailto:", "javascript:")):
            return m.group(0)
        return f"{attr}={q}{urllib.parse.urljoin(base, url)}{q}"
    return re.sub(r'\b(src|href)=(["\'])(.*?)\2', fix, html)


def fetch_html(pid):
    for url in (f"https://arxiv.org/html/{pid}", f"https://ar5iv.labs.arxiv.org/html/{pid}"):
        try:
            final_url, html = get(url)
        except urllib.error.HTTPError as e:
            print(f"  {url} -> HTTP {e.code}")
            continue
        except urllib.error.URLError as e:
            print(f"  {url} -> {e.reason}")
            continue
        # ar5iv redirects papers it can't render back to arxiv.org/abs
        if "/abs/" in final_url or "ltx_document" not in html and "ltx_page" not in html:
            print(f"  {url} -> no HTML rendering")
            continue
        # resolve exactly like the browser would: against the page URL itself
        return absolutize(html, final_url), url
    return None, None


def localize_images(html, safe):
    """Download the paper's figures into papers/{id}/ and point <img> at them.

    Needed for the shared Claude artifact version: its page can't load
    images from arxiv.org, only files published alongside it.
    """
    folder = PAPERS / safe
    srcs = sorted(set(re.findall(r'<img[^>]*?\bsrc="(https://(?:arxiv\.org/html|ar5iv[^"]*?)/[^"]+)"', html)))
    srcs = [s for s in srcs if "/static/" not in s]
    for i, url in enumerate(srcs):
        name = hashlib.sha1(url.encode()).hexdigest()[:8] + "_" + re.sub(r"[^A-Za-z0-9._-]", "_", url.rsplit("/", 1)[-1])[-60:]
        dest = folder / name
        if not dest.exists():
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = r.read()
            except (urllib.error.URLError, TimeoutError) as e:
                print(f"  figure skipped ({e}): {url}")
                continue
            folder.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            time.sleep(0.3)  # gentle on arxiv.org's static files
        html = html.replace(f'src="{url}"', f'src="papers/{safe}/{name}"')
    print(f"  {len(srcs)} figures saved in papers/{safe}/")
    return html


def update_index():
    """papers/index.json = [{id, title}] for the browser dropdown."""
    items = []
    for f in sorted(PAPERS.glob("*.json")):
        if f.name == "index.json":
            continue
        meta = json.loads(f.read_text())
        items.append({"id": meta["id"], "title": meta["title"]})
    (PAPERS / "index.json").write_text(json.dumps(items, indent=2))


def fetch(arg):
    pid = parse_id(arg)
    print(f"[{pid}] metadata...")
    meta = fetch_metadata(pid)
    print(f"[{pid}] {meta['title']}")
    html, source = fetch_html(pid)
    if html is None:
        print(f"[{pid}] ERROR: this paper has no HTML version on arxiv.org/html or ar5iv. "
              "Try another paper.", file=sys.stderr)
        return False
    meta["source"] = source
    PAPERS.mkdir(exist_ok=True)
    safe = pid.replace("/", "_")
    meta["id"] = safe
    html = localize_images(html, safe)
    (PAPERS / f"{safe}.html").write_text(html)
    (PAPERS / f"{safe}.json").write_text(json.dumps(meta, indent=2))
    update_index()
    print(f"[{pid}] saved papers/{safe}.html ({len(html)//1024} KB) from {source}")
    return True


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--batch"]:
        ids = " ".join(args[1:]).replace(",", " ").split()
    else:
        ids = args or [DEFAULT_ID]
    ok = [fetch(i) for i in ids]
    sys.exit(0 if all(ok) else 1)
