#!/usr/bin/env python3
"""SEO invariants for the built site (default: dist/).

    python3 src/build.py && python3 tools/verify-seo.py [dist-dir]

Exits non-zero if any check fails. Checks: sitemap integrity, the noindex
set, one title/description/H1/canonical per page (titles and descriptions
unique), JSON-LD validity and store-only DryCleaningOrLaundry, no TODO text,
no 'Shushant', no '//' in internal hrefs, no links to removed URLs.
"""
import collections
import glob
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
BASE = "https://wash4you.in/"
STORES = {"laundry-service-sushant-lok", "laundry-service-sector-49", "laundry-service-sector-7",
          "laundry-service-vasant-vihar-delhi"}
# Hand-written redirect stubs / print sheet / 404: not "real" pages.
NON_PAGES = {"404.html", "pricing-print.html", "book-pickup/index.html", "menu/index.html"}
LOC_RE = re.compile(r"^laundry-service-[a-z0-9-]+-(noida|faridabad|ghaziabad|delhi)/index\.html$")
LOC_KEEP = {"laundry-service-malviya-nagar-delhi/index.html", "laundry-service-vasant-vihar-delhi/index.html"}
REMOVED = re.compile(r'''href="[^"]*(best-dryclean-near-me/|pricing/(sushant-lok|sector-49|cyber-city|dlf-phase-3|golf-course-road|golf-course-extension|sohna-road|sector-29|palam-vihar|mg-road)/|services/(eco-friendly-laundry|accessories-cleaning|steam-ironing|linen-cleaning|shoe-cleaning|sofa-cleaning|toy-cleaning|wet-cleaning|premium-dry-cleaning|bag-cleaning|carpet-cleaning|blanket-quilt-cleaning|mattress-cleaning|curtains-cleaning|leather-cleaning)/)"''')

fails = []
def fail(msg): fails.append(msg)

pages = {str(p.relative_to(ROOT)): p.read_text(encoding="utf-8") for p in ROOT.rglob("*.html")}
real = {k: v for k, v in pages.items() if k not in NON_PAGES}

# ---- sitemaps
idx = (ROOT / "sitemap.xml").read_text(encoding="utf-8")
children = re.findall(r"<sitemap><loc>([^<]+)</loc>", idx)
if len(children) != 6: fail(f"sitemap index lists {len(children)} sitemaps, expected 6")
sm_urls = []
for c in children:
    f = ROOT / urlparse(c).path.lstrip("/")
    if not f.is_file(): fail(f"sitemap file missing: {c}"); continue
    for m in re.finditer(r"<url><loc>([^<]+)</loc>(<lastmod>(\d{4}-\d{2}-\d{2})</lastmod>)?", f.read_text(encoding="utf-8")):
        loc, lm = m.group(1), m.group(3)
        sm_urls.append(loc)
        if not loc.startswith(BASE) or not loc.endswith("/"): fail(f"bad sitemap URL: {loc}")
        if not lm: fail(f"no lastmod: {loc}")
        rel = loc[len(BASE):] + "index.html"
        if rel not in pages: fail(f"sitemap URL has no built page: {loc}"); continue
        if re.search(r'<meta name="robots" content="noindex', pages[rel]): fail(f"noindex page in sitemap: {loc}")
if len(sm_urls) != len(set(sm_urls)): fail("duplicate URLs across sitemaps")

# ---- robots
n_noindex = 0
for k, h in real.items():
    m = re.search(r'<meta name="robots" content="([^"]*)"', h)
    robots = m.group(1) if m else ""
    is_loc = bool(LOC_RE.match(k)) and k not in LOC_KEEP
    if is_loc:
        n_noindex += 1
        if robots != "noindex, follow": fail(f"{k}: robots={robots!r}, expected noindex, follow")
    elif robots != "index, follow, max-image-preview:large":
        fail(f"{k}: robots={robots!r}")
if n_noindex != 372: fail(f"{n_noindex} location pages noindex, expected 372")

# ---- title / description / h1 / canonical
titles, descs = collections.defaultdict(list), collections.defaultdict(list)
for k, h in real.items():
    for name, rx in (("title", r"<title>"), ("meta description", r'<meta name="description"'), ("h1", r"<h1[\s>]")):
        n = len(re.findall(rx, h))
        if n != 1: fail(f"{k}: {n} x {name}")
    path = k[: -len("index.html")] if k.endswith("index.html") else k
    can = re.findall(r'<link rel="canonical" href="([^"]*)"', h)
    if can != [BASE + path]: fail(f"{k}: canonical {can}, expected {BASE + path}")
    t = re.search(r"<title>(.*?)</title>", h, re.S); d = re.search(r'name="description" content="([^"]*)"', h)
    if t: titles[t.group(1)].append(k)
    if d: descs[d.group(1)].append(k)
for label, dct in (("title", titles), ("description", descs)):
    for text, ks in dct.items():
        if len(ks) > 1: fail(f"duplicate {label} on {len(ks)} pages: {ks[:3]} ...")

# ---- JSON-LD
for k, h in pages.items():
    for blob in re.findall(r'<script type="application/ld\+json">(.*?)</script>', h, re.S):
        try: data = json.loads(blob)
        except Exception as e: fail(f"{k}: JSON-LD does not parse ({e})"); continue
        has = any(n.get("@type") == "DryCleaningOrLaundry" for n in data.get("@graph", []))
        slug = k.split("/")[0]
        if has and slug not in STORES: fail(f"{k}: DryCleaningOrLaundry on a non-store page")
        if not has and slug in STORES: fail(f"{k}: store page without DryCleaningOrLaundry")
        if re.search(r"TODO|REPLACE", blob): fail(f"{k}: TODO/REPLACE in JSON-LD")

# ---- visible text, typo, hrefs, removed links
for k, h in pages.items():
    body = re.sub(r"<!--.*?-->|<script.*?</script>|<style.*?</style>", "", h, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", body)
    if re.search(r"\bTODO\b|\bREPLACE\b", text): fail(f"{k}: TODO/REPLACE in visible text")
    if "Shushant" in h: fail(f"{k}: 'Shushant'")
    for href in re.findall(r'href="([^"]*)"', h):
        if "//" in href and not re.match(r"(https?:)?//", href) or re.match(r"https?://[^/]+//", href):
            fail(f"{k}: href with '//': {href}")
    if k != "robots.txt" and REMOVED.search(h): fail(f"{k}: link to a removed/redirected URL")
for f in list(ROOT.rglob("*.xml")) + list(ROOT.rglob("*.json")) + list(ROOT.rglob("*.css")) + list(ROOT.rglob("*.js")):
    if "Shushant" in f.read_text(encoding="utf-8", errors="ignore"): fail(f"{f}: 'Shushant'")

print(f"{len(pages)} pages checked, {len(sm_urls)} sitemap URLs, {n_noindex} noindex location pages")
if fails:
    print(f"\n{len(fails)} FAILURES:")
    for m in fails[:60]: print(" -", m)
    sys.exit(1)
print("ALL CHECKS PASSED")
