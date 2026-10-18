"""Per-page SEO overrides edited in the admin (src/data/seo.json).

seo.json: {"pages": {"/about-us/": {"title", "description", "canonical",
"og_image", "noindex"}}}. Only the fields that are set replace the page's
built-in value; everything else is left exactly as the template rendered it.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

SEO_FILE = Path(__file__).resolve().parent / "data" / "seo.json"


def load() -> dict:
    try:
        d = json.loads(SEO_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    pages = d.get("pages") if isinstance(d, dict) else None
    return pages if isinstance(pages, dict) else {}


def page_url(rel_path: str) -> str:
    p = "/" + rel_path.replace("index.html", "").strip("/")
    return "/" if p == "/" else p + "/"


def _set_meta(doc: str, pattern: str, tag: str) -> str:
    if re.search(pattern, doc, re.I):
        return re.sub(pattern, lambda _m: tag, doc, count=1, flags=re.I)
    return doc.replace("</head>", tag + "</head>", 1)


def apply(doc: str, rel_path: str, seo: dict, base_url: str) -> str:
    rec = seo.get(page_url(rel_path))
    if not rec or not isinstance(rec, dict):
        return doc
    esc = lambda v: html.escape(str(v), quote=True)  # noqa: E731
    if rec.get("title"):
        t = esc(rec["title"])
        doc = re.sub(r"<title>.*?</title>", lambda _m: f"<title>{t}</title>", doc, count=1, flags=re.S)
        doc = re.sub(r'(<meta property="og:title" content=")[^"]*(")', lambda m: m.group(1) + t + m.group(2), doc, count=1)
    if rec.get("description"):
        d = esc(rec["description"])
        doc = re.sub(r'(<meta name="description" content=")[^"]*(")', lambda m: m.group(1) + d + m.group(2), doc, count=1)
        doc = re.sub(r'(<meta property="og:description" content=")[^"]*(")', lambda m: m.group(1) + d + m.group(2), doc, count=1)
    if rec.get("canonical"):
        c = esc(rec["canonical"])
        doc = _set_meta(doc, r'<link rel="canonical" href="[^"]*">', f'<link rel="canonical" href="{c}">')
        doc = re.sub(r'(<meta property="og:url" content=")[^"]*(")', lambda m: m.group(1) + c + m.group(2), doc, count=1)
    if rec.get("og_image"):
        img = str(rec["og_image"])
        url = img if img.startswith("http") else f"{base_url}/{img.lstrip('/')}"
        doc = re.sub(r'(<meta property="og:image" content=")[^"]*(")', lambda m: m.group(1) + esc(url) + m.group(2), doc, count=1)
    if rec.get("noindex"):
        doc = _set_meta(doc, r'<meta name="robots" content="[^"]*">', '<meta name="robots" content="noindex, follow">')
    return doc
