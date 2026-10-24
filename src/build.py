#!/usr/bin/env python3
"""Wash4You static site generator."""

from __future__ import annotations

import html
import json
import math
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

import studio
import seo_overrides
from jinja2 import Environment, FileSystemLoader
from markupsafe import Markup

ROOT = Path(__file__).resolve().parent
TEMPLATES_DIR = ROOT / "templates"
DATA_DIR = ROOT / "data"
ASSETS_DIR = ROOT / "assets"

# Edit mode is switched on by the local admin (src/admin/server.py) via the
# W4U_EDIT env var. It renders an *editable* copy of the whole site into
# dist-edit/ — the only difference is that the `cms()` template helper emits
# data-cms binding attributes the click-to-edit overlay reads. Production
# builds (W4U_EDIT unset) are byte-for-byte unchanged and still go to dist/.
EDIT_MODE = bool(os.environ.get("W4U_EDIT"))
DIST_DIR = ROOT.parent / ("dist-edit" if EDIT_MODE else "dist")


def load_json(path: Path) -> dict | list:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _deep_merge(base, over):
    """`over` wins; dicts merge key by key, lists and scalars replace."""
    if isinstance(base, dict) and isinstance(over, dict):
        out = dict(base)
        for k, v in over.items():
            out[k] = _deep_merge(base[k], v) if k in base else v
        return out
    return over


def _fill_tokens(value, tokens: dict):
    if isinstance(value, str):
        for k, v in tokens.items():
            value = value.replace(k, v)
        return value
    if isinstance(value, list):
        return [_fill_tokens(v, tokens) for v in value]
    if isinstance(value, dict):
        return {k: _fill_tokens(v, tokens) for k, v in value.items()}
    return value


# --- SEO keyword highlighter -------------------------------------------------
# Wraps the money keywords in <mark class="seo-hl"> inside each page's h1, so they read as if marked with a green highlighter. Each
# keyword is marked once per heading. Skipped in edit mode (the admin overlay
# edits those nodes' text in place).
_SEO_KEYWORDS = [
    "dry[- ]?cleaning", "dry[- ]?clean(?:ers|er)?", "dryclean", "laundry", "wash (?:&amp;|&) fold",
    "shoe (?:&amp;|&) sneaker cleaning", "sneaker cleaning", "shoe cleaning", "shoe care",
    "sofa cleaning", "carpet (?:&amp;|&) rug cleaning", "carpet cleaning", "rug cleaning",
    "curtains? cleaning", "mattress cleaning", "steam iron(?:ing)?", "leather cleaning",
    "bag cleaning", "toy cleaning", "free (?:doorstep )?pickup(?: (?:&amp;|&|and) delivery)?",
    "doorstep pickup", "Gurgaon", "Gurugram", "Delhi NCR",
]
_SEO_RE = re.compile(r"(?<![\w-])(" + "|".join(_SEO_KEYWORDS) + r")(?![\w-])", re.I)
_H1_RE = re.compile(r"(<h1\b[^>]*>)(.*?)(</h1>)", re.S | re.I)
_TAG_SPLIT = re.compile(r"(<[^>]+>)")


def _mark_keywords(inner: str) -> str:
    seen: set = set()
    depth_mark = 0
    out = []
    for part in _TAG_SPLIT.split(inner):
        if part.startswith("<"):
            low = part.lower()
            if low.startswith("<mark"):
                depth_mark += 1
            elif low.startswith("</mark"):
                depth_mark = max(0, depth_mark - 1)
            out.append(part)
            continue
        if depth_mark or not part.strip():
            out.append(part)
            continue

        def _wrap(m):
            key = re.sub(r"\s+", " ", m.group(1).lower())
            if key in seen:
                return m.group(0)
            seen.add(key)
            return f'<mark class="seo-hl">{m.group(1)}</mark>'
        out.append(_SEO_RE.sub(_wrap, part))
    return "".join(out)


def highlight_seo_keywords(page: str) -> str:
    # Main heading (h1) only; h2s and body copy are left as authored.
    return _H1_RE.sub(lambda m: m.group(1) + _mark_keywords(m.group(2)) + m.group(3), page)


SERVICE_SLUG_SUFFIX = "-best-premium-drycleaning-service"
SERVICE_URL_RE = None


def resolve_product(prod: dict, shared: dict, price_index: dict) -> dict:
    """One product page's data: shared sections underneath, the product's
    own JSON on top, {name}/{noun}/{care}/{Care} filled in, and every price
    read from pricing.json so a product page can never quote a stale rate."""
    merged = _deep_merge(shared, prod)
    care = merged.get("care", "dryclean care")
    merged = _fill_tokens(merged, {
        "{name}": merged["name"],
        "{noun}": merged.get("noun", merged["name"].lower()),
        "{care}": care,
        "{Care}": care.title(),
        "{seo}": merged.get("seo", merged["name"] + " Dry Cleaning"),
    })
    for svc in merged["services"]:
        item = price_index.get(svc.get("slug"))
        if item:
            svc["price"], svc["amount"] = item["price"], item["amount"]
            svc["price_delhi"], svc["amount_delhi"] = item.get("price_delhi", item["price"]), item.get("amount_delhi", item["amount"])
            if item.get("unit"):
                svc["unit"] = item["unit"]
    # Second pass for copy that quotes a price ("from {price1} per piece"),
    # which only exists once pricing.json has been read above.
    # Rates differ by city (Gurgaon / Delhi), so copy must not quote a single
    # number: rephrase the "starts from {priceN}" sentences, then fill any
    # remaining tokens (none today) with the Gurgaon rate.
    def _cityless(o):
        if isinstance(o, dict):
            return {k: _cityless(v) for k, v in o.items()}
        if isinstance(o, list):
            return [_cityless(v) for v in o]
        if isinstance(o, str) and "{price" in o:
            o = re.sub(r"starts from \{price\d\} per ([a-z ]+?) and ([A-Za-z&\- ]+?) from \{price\d\} per ([a-z ]+)\.",
                       r"and \2 are priced per \1 at your city's rate. Choose Gurgaon or Delhi in the rate box above.", o)
            o = re.sub(r"starts from \{price\d\} per ([a-z ]+)\.",
                       r"is priced per \1 at your city's rate. Choose Gurgaon or Delhi in the rate box above.", o)
        return o
    merged = _cityless(merged)
    merged = _fill_tokens(merged, {
        f"{{price{i}}}": s["price"] for i, s in enumerate(merged["services"], 1)
    })
    cheapest = min(merged["services"], key=lambda s: s["amount"])
    merged["startingPrice"] = cheapest["price"]
    merged["startingAmount"] = cheapest["amount"]
    merged["startingUnit"] = cheapest.get("unit", "")
    merged["relatedServices"] = [
        {"slug": r} if isinstance(r, str) else r
        for r in merged.get("relatedServices", [])
    ]
    for rel in merged["relatedServices"]:
        item = price_index.get(rel["slug"])
        if item:
            rel.setdefault("name", item["name"])
            rel.setdefault("img", item.get("img", ""))
            rel["price"] = "From " + item["price"] + (" " + item["unit"] if item.get("unit") else "")
    return merged


def markdown_to_html(text: str) -> str:
    """Render the small markdown subset the generated copy actually uses.

    A scan of all 25 generated bodies found only: ## / ### headings,
    paragraphs, unordered lists and **bold**. That is not worth a dependency,
    and hand-rolling it keeps `python3 src/build.py` runnable with nothing but
    Jinja2 installed.

    Everything is HTML-escaped first, so generated copy can never inject
    markup into the page.
    """
    if not text:
        return ""

    # Generated bodies are inconsistent about whether they open at ## or ###.
    # A body that starts at ### sits under the page's <h1> and creates a
    # heading-level skip, so shift the whole document until its shallowest
    # heading is <h2>.
    levels = [len(m.group(1)) for m in re.finditer(r"^(#{1,4})\s", text, re.M)]
    shift = (2 - min(levels)) if levels else 0

    out: list[str] = []
    in_list = False

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    def inline(s: str) -> str:
        s = html.escape(s, quote=False)
        # Bold first: once ** pairs are consumed, the italic pattern can be a
        # simple single-asterisk match without having to avoid eating them.
        s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
        # Used mainly for the Hinglish phrases ("Nazuk kapde, extra care").
        s = re.sub(r"\*([^*\n]+?)\*", r"<em>\1</em>", s)
        return s

    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            close_list()
            continue
        heading = re.match(r"^(#{1,4})\s+(.*)$", line)
        if heading:
            close_list()
            level = min(max(len(heading.group(1)) + shift, 2), 4)
            out.append(f"<h{level}>{inline(heading.group(2))}</h{level}>")
        elif re.match(r"^[-*+] ", line):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{inline(line[2:])}</li>")
        else:
            close_list()
            out.append(f"<p>{inline(line)}</p>")

    close_list()
    return "\n".join(out)


POST_ROOT = "@ROOT@"  # swapped for the page's root_path at render time (see page-blog-post.html)


def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "section"


def render_post_markdown(text: str) -> tuple[str, list[dict]]:
    """Markdown for blog posts: ## / ### headings (with anchor ids), paragraphs,
    bullet and numbered lists, > quotes, --- rules, **bold**, *italic* and
    [links](url). Returns (html, table_of_contents).

    Everything is HTML-escaped first, so post copy can never inject markup.
    Site-relative links ("/pricing/") become POST_ROOT + "pricing/" so they
    resolve from any page depth, like every other link in the templates.
    """
    toc: list[dict] = []
    if not text:
        return "", toc

    levels = [len(m.group(1)) for m in re.finditer(r"^(#{1,4})\s", text, re.M)]
    shift = (2 - min(levels)) if levels else 0
    used: set[str] = set()

    def link(m: re.Match) -> str:
        label, url = m.group(1), m.group(2)
        if url.startswith("/"):
            return f'<a href="{POST_ROOT}{url.lstrip("/")}">{label}</a>'
        if url.startswith(("http://", "https://")):
            return f'<a href="{url}" target="_blank" rel="noopener">{label}</a>'
        return label  # anything else (javascript:, data:, bare text) is dropped

    def inline(t: str) -> str:
        t = html.escape(t, quote=False)
        t = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, t)
        t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
        t = re.sub(r"(?<![\w*])\*([^*\n]+?)\*(?![\w*])", r"<em>\1</em>", t)
        return t

    out: list[str] = []
    para: list[str] = []
    list_kind: str | None = None

    def flush_para() -> None:
        if para:
            out.append("<p>" + inline(" ".join(para)) + "</p>")
            para.clear()

    def close_list() -> None:
        nonlocal list_kind
        if list_kind:
            out.append(f"</{list_kind}>")
            list_kind = None

    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            flush_para(); close_list(); continue
        heading = re.match(r"^(#{1,4})\s+(.*)$", line)
        ul = re.match(r"^[-*+]\s+(.*)$", line)
        ol = re.match(r"^\d+[.)]\s+(.*)$", line)
        if heading:
            flush_para(); close_list()
            level = min(max(len(heading.group(1)) + shift, 2), 4)
            label = heading.group(2).strip()
            hid = base = _slugify(label)
            n = 2
            while hid in used:
                hid, n = f"{base}-{n}", n + 1
            used.add(hid)
            if level == 2:
                toc.append({"id": hid, "text": re.sub(r"[*_]", "", label)})
            out.append(f'<h{level} id="{hid}">{inline(label)}</h{level}>')
        elif ul or ol:
            flush_para()
            kind = "ul" if ul else "ol"
            if list_kind != kind:
                close_list()
                out.append(f"<{kind}>")
                list_kind = kind
            out.append("<li>" + inline((ul or ol).group(1)) + "</li>")
        elif line.startswith(">"):
            flush_para(); close_list()
            out.append("<blockquote><p>" + inline(line.lstrip("> ").strip()) + "</p></blockquote>")
        elif re.match(r"^(-{3,}|\*{3,})$", line):
            flush_para(); close_list()
            out.append("<hr>")
        else:
            close_list()
            para.append(line)
    flush_para(); close_list()
    return "\n".join(out), toc


def _parse_front_matter(raw: str) -> tuple[dict, str]:
    """`---` YAML front matter, then a Markdown body."""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", raw, re.S)
    if not m:
        return {}, raw
    try:
        import yaml  # in requirements.txt; the generator only needs it for posts
        meta = yaml.safe_load(m.group(1)) or {}
    except ImportError:
        meta = {}
        for ln in m.group(1).splitlines():
            if ":" in ln and not ln.startswith(" "):
                k, v = ln.split(":", 1)
                meta[k.strip()] = v.strip().strip("'\"")
    return meta, m.group(2)


def _post_date(value) -> tuple[str, str]:
    """-> (display like 'June 25, 2026', ISO like '2026-06-25')."""
    if hasattr(value, "strftime"):  # YAML turned 2026-06-25 into a date
        return value.strftime("%B %d, %Y").replace(" 0", " "), value.strftime("%Y-%m-%d")
    text = str(value or "").strip()
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%Y-%m-%d", "%d %B %Y"):
        try:
            d = datetime.strptime(text, fmt)
            return d.strftime("%B %d, %Y").replace(" 0", " "), d.strftime("%Y-%m-%d")
        except ValueError:
            pass
    return text, ""


def load_posts(posts_dir: Path, base_url: str) -> list[dict]:
    """content/posts/<slug>.md -> post dicts, newest first.

    A post lives at /<slug>/ (the URL the blog has always used, so existing
    links and search rankings keep working). Only `status: published` posts
    are built. Front matter: title, date, excerpt, meta_description, category,
    cover_service_slug (the service the card art falls back to), image.
    """
    posts: list[dict] = []
    for f in sorted(posts_dir.glob("*.md")):
        try:
            meta, body = _parse_front_matter(f.read_text(encoding="utf-8"))
        except Exception as e:  # a YAML slip should name the file, not dump a traceback
            raise SystemExit(f"{f.name}: front matter is not valid YAML ({e}). Wrap values containing a colon in quotes.")
        if str(meta.get("status", "published")).lower() != "published":
            continue
        title = str(meta.get("title") or "").strip()
        if not title:
            raise SystemExit(f"{f.name}: front matter needs a title")
        shown, iso = _post_date(meta.get("date"))
        body_html, toc = render_post_markdown(body)
        words = len(re.findall(r"\w+", body))
        slug = f.stem
        excerpt = " ".join(str(meta.get("excerpt") or "").split())
        posts.append({
            "slug": slug,
            "path": f"{slug}/",
            "url": f"{base_url}/{slug}/",
            "title": title,
            "date": shown,
            "date_iso": iso,
            "excerpt": excerpt,
            "meta_description": " ".join(str(meta.get("meta_description") or excerpt).split()),
            "category": str(meta.get("category") or "Guides").strip(),
            "art": meta.get("cover_service_slug") or "",
            "image": meta.get("image") or "",
            "author": str(meta.get("author") or "The Wash4You team"),
            "html": body_html,
            "toc": toc,
            "words": words,
            "read_minutes": max(1, math.ceil(words / 200)),
        })
    posts.sort(key=lambda p: (p["date_iso"], p["title"]), reverse=True)
    return posts



def _make_cms(enabled: bool, styled: set | None = None):
    """Build the `cms()` template global.

    In edit mode it returns an HTML attribute string that binds a rendered
    element back to its source: `cms('home:why.title')` ->
    ` data-cms="home:why.title" data-cms-kind="text"`. The value is
    "<store>:<dotted.path>" where <store> maps to src/data/<store>.json and the
    path is the key route into that JSON (list indices included, e.g.
    'how_it_works.steps.0.title'). The click-to-edit overlay reads these; the
    admin's save endpoint writes straight back to that JSON location.

    With edit mode off this returns "" so production HTML is unchanged.
    """
    from markupsafe import Markup

    styled = styled or set()

    def cms(path: str, kind: str = "text") -> "Markup | str":
        # A field with a Studio style override carries data-sid so the generated
        # studio-custom.css can target it (also in production).
        sid = f' data-sid="{html.escape(path, quote=True)}"' if path in styled else ""
        if not enabled:
            return Markup(sid) if sid else ""
        safe = html.escape(path, quote=True)
        # kind="file" binds an <img> to a fixed asset on disk (template
        # literals like the mascot/logo that have no JSON field); swapping it
        # overwrites that file under src/assets/. Everything else binds to a
        # JSON location "<store>:<path>" and edits that value.
        if kind == "file":
            return Markup(f' data-cms-file="{safe}"')
        return Markup(f' data-cms="{safe}" data-cms-kind="{html.escape(kind, quote=True)}"{sid}')

    return cms


BRAND_SUFFIXES = (" | Wash4You", " — Wash4You", " - Wash4You", " | Wash4You Gurugram")


def fit_title(title: str, limit: int = 60) -> str:
    """Keep titles inside Google's ~60-character display width.

    Drops the redundant brand suffix first — the brand is already in the
    domain — and only truncates at a word boundary if that is not enough.
    """
    if not title or len(title) <= limit:
        return title
    for suffix in sorted(BRAND_SUFFIXES, key=len, reverse=True):
        if title.endswith(suffix):
            trimmed = title[: -len(suffix)].rstrip(" |—-")
            if len(trimmed) <= limit:
                return trimmed
            title = trimmed
            break
    if len(title) <= limit:
        return title
    cut = title[:limit].rsplit(" ", 1)[0]
    cut = cut.rstrip(" |—-,&")
    # A word-boundary cut can strand a trailing connector ("... dry cleaning &",
    # "... laundry and") — drop it so the title never ends mid-phrase.
    cut = re.sub(r"\s+(&|and|or|the|of|in|for|to|with|a|an)$", "", cut, flags=re.I)
    return cut.rstrip(" |—-,&")


def fit_description(desc: str, limit: int = 155) -> str:
    """Keep meta descriptions inside the ~155-character snippet width.

    Prefers ending on a complete sentence so the snippet never reads as if it
    was chopped mid-thought; falls back to a word boundary.
    """
    if not desc or len(desc) <= limit:
        return desc
    window = desc[: limit + 1]
    for stop in (". ", "! ", "? "):
        idx = window.rfind(stop)
        if idx > limit * 0.55:
            return window[: idx + 1].strip()
    if desc[:limit].endswith("."):
        return desc[:limit]
    return desc[:limit].rsplit(" ", 1)[0].rstrip(" ,;:—-") + "…"


def load_generated(gen_dir: Path) -> dict:
    """Generated SEO copy, if it has been produced.

    Keeping this optional means a clean checkout still builds the whole
    core site — it just skips the long-tail matrix pages.
    """
    out: dict = {"services": [], "localities": [], "matrix": []}
    if not gen_dir.exists():
        return out
    for name, key in (("services.json", "services"),
                      ("localities.json", "localities"),
                      ("matrix.json", "matrix")):
        path = gen_dir / name
        if not path.exists():
            continue
        data = load_json(path)
        out[key] = data.get(key) or data.get("pages") or []
    return out


def get_paths(depth: int) -> tuple[str, str]:
    """Return (root_path, asset_path) for a page at given directory depth."""
    if depth == 0:
        return "", "assets/"
    prefix = "../" * depth
    return prefix, prefix + "assets/"


def write_html(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def build() -> None:
    # Clean and recreate dist
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    # Copy assets
    shutil.copytree(ASSETS_DIR, DIST_DIR / "assets")

    # Copy images to dist root for root-relative access
    images_src = ASSETS_DIR / "images"
    images_dst = DIST_DIR / "images"
    shutil.copytree(images_src, images_dst)

    # Load data
    site = load_json(DATA_DIR / "site.json")
    home = load_json(DATA_DIR / "home.json")
    about = load_json(DATA_DIR / "about.json")
    services = load_json(DATA_DIR / "services.json")
    global SERVICE_URL_RE
    SERVICE_URL_RE = re.compile(
        r"services/(" + "|".join(re.escape(x["slug"]) for x in sorted(services["services"], key=lambda x: -len(x["slug"]))) + r")/"
    )
    pricing = load_json(DATA_DIR / "pricing.json")
    packages = load_json(DATA_DIR / "packages.json")
    steam = load_json(DATA_DIR / "steam-iron.json")
    blog = load_json(DATA_DIR / "blog.json")
    # Posts come from content/posts/*.md (one file per article, full text).
    # blog.json keeps the page's own copy: meta, hero.
    _posts_dir = ROOT.parent / "content" / "posts"
    if _posts_dir.is_dir():
        blog["posts"] = load_posts(_posts_dir, site["urls"]["base"])
    locations = load_json(DATA_DIR / "locations.json")
    policies = load_json(DATA_DIR / "policies.json")
    pages = load_json(DATA_DIR / "pages.json")
    proof = load_json(DATA_DIR / "proof.json")
    areas_data = load_json(DATA_DIR / "areas.json")
    testimonials = load_json(DATA_DIR / "testimonials.json")
    # Central registry for the /laundry-service-*/ local-SEO area pages. One
    # entry per published area; build.py loops over it below, so adding an
    # area to this file is the only step needed to publish its page.
    area_pages = load_json(DATA_DIR / "area-pages.json")["areas"]
    # Second registry, same loop pattern: the non-Gurugram service-area pages.
    # Separate file and separate template on purpose — Wash4You has no premises
    # in Delhi, Noida, Faridabad or Ghaziabad, so those pages must not carry a
    # "nearest store", a local address or a LocalBusiness schema. Generated by
    # tools/gen-coverage-pages.py from the same areas.json coverage list.
    coverage_data = load_json(DATA_DIR / "coverage-pages.json")
    coverage_pages = coverage_data["areas"]
    coverage_hubs = coverage_data["hubs"]

    # Product pages: one JSON per priced item in src/data/products/, most of
    # them written by tools/gen-product-pages.py. `_shared.json` holds the
    # sections every product page carries (studio, process, doorstep, ...)
    # and is merged underneath each product; it is not a page itself.
    products_dir = DATA_DIR / "products"
    products_raw = []
    product_shared = {}
    if products_dir.exists():
        shared_file = products_dir / "_shared.json"
        if shared_file.exists():
            product_shared = load_json(shared_file)
        for p_file in sorted(products_dir.glob("*.json")):
            if not p_file.name.startswith("_"):
                products_raw.append(load_json(p_file))

    # Generated SEO copy. Absent on a clean checkout — the site still builds
    # without it, just without the long-tail matrix pages.
    gen = load_generated(DATA_DIR / "generated")

    # Merge the generated long-form copy onto the matching service entries.
    gen_services = {s["slug"]: s for s in gen.get("services", [])}
    # Index of each slug inside generated/services.json, so the admin overlay
    # can bind a service page's headline and body to the file that actually
    # supplies them. Editing the same field in services.json has no effect —
    # the merge below overwrites it.
    gen_index = {s["slug"]: i for i, s in enumerate(gen.get("services", []))}
    for service in services["services"]:
        extra = gen_services.get(service["slug"])
        if extra:
            service.update({k: v for k, v in extra.items() if k != "slug"})

    # Slug -> service, so a blog post's `art` field (a service slug used as
    # its hero image) can resolve to that service's own photo instead of
    # walking services.services from inside a template.
    services_by_slug = {s["slug"]: s for s in services["services"]}

    # Fall back to the first pair rather than aborting the whole build if the
    # configured hero id ever stops matching a pair.
    hero_pair = next(
        (p for p in proof["pairs"] if p["id"] == proof["hero"]),
        proof["pairs"][0] if proof.get("pairs") else None,
    )

    # Jinja environment. autoescape is ON so authored copy (increasingly typed
    # straight into the admin) can never break out of an HTML attribute or
    # inject markup. The markdown filter and the icon/component macros produce
    # trusted HTML, so their output is wrapped as Markup; JSON-LD values are
    # emitted through `| tojson`, which is both valid-JSON and escape-safe.
    env = Environment(
        loader=FileSystemLoader(TEMPLATES_DIR),
        trim_blocks=True, lstrip_blocks=True, autoescape=True, finalize=studio.finalize,
    )
    env.filters["markdown"] = lambda s: Markup(markdown_to_html(s))
    # Cache-buster for CSS/JS links: changes on every build so browsers never
    # keep serving a stale stylesheet after a deploy.
    env.globals["asset_v"] = __import__("time").strftime("%Y%m%d%H%M%S")
    env.globals["edit_mode"] = EDIT_MODE
    env.globals["cms"] = _make_cms(EDIT_MODE, studio.styled_bindings())

    # Page registry
    pages_to_build = []

    # Slug -> price-list item, shared by the home page price rail and every
    # service detail gallery. Built once here rather than per page: Jinja
    # resolves `category.items` to the dict METHOD, so walking pricing.json
    # from a template is a trap.
    price_index = {
        item["slug"]: item
        for category in pricing["categories"]
        for item in category["items"]
        if item.get("slug")
    }

    # Delhi rates (data/city-prices.json). Each price-list item gets
    # price_delhi/amount_delhi so templates can render both cities and the
    # city selector can swap between them client-side.
    city_prices = load_json(DATA_DIR / "city-prices.json").get("delhi", {})
    for slug, item in price_index.items():
        amt = city_prices.get(slug, item["amount"])
        item["amount_delhi"] = amt
        item["price_delhi"] = f"\u20b9{amt:,}"

    products_list = [resolve_product(p, product_shared, price_index) for p in products_raw]

    # Client poster artwork (data/posters.json): per-product posters plus the
    # pickup/delivery trio shown on every product page.
    posters = load_json(DATA_DIR / "posters.json")
    env.globals["posters"] = posters
    for prod in products_list:
        prod["posters"] = posters["by_product"].get(prod["slug"], [])
        prod["doorstepPosters"] = posters["doorstep"]

    # Price-list slug -> product page. Each product claims the slugs of the
    # services it sells (jeans + iron-jeans -> products/jeans/), so the footer,
    # search, price list and service galleries all link through this one map.
    product_urls = {}
    for prod in products_list:
        url = f"products/{prod['slug']}/"
        product_urls.setdefault(prod["slug"], url)
        for i, svc in enumerate(prod["services"]):
            if svc.get("slug"):
                product_urls.setdefault(svc["slug"], url if i == 0 else f"{url}?service={svc['id']}")
    # The steam-iron page's rate table has names, not slugs: link each row
    # to its product with the steam-press option preselected.
    product_urls_by_name = {}
    for prod in products_list:
        press = next((s for s in prod["services"] if s["id"] == "steam-press"), None)
        if press:
            product_urls_by_name[prod["name"].lower()] = product_urls[press["slug"]]
    for prod in products_list:
        for rel in prod.get("relatedServices", []):
            rel["url"] = product_urls.get(rel["slug"], f"pricing/#{rel['slug']}")

    # Flat list for the header search index — every priced item (shirt,
    # saree, carpet, ...), each tagged with the #cat-N anchor of the price
    # list section it lives in, so a hit jumps straight to that category
    # instead of dropping the visitor at the top of a 58-item page.
    search_pricing_items = [
        {"name": item["name"], "cat_index": cat_i, "slug": item.get("slug"),
         "cat": category.get("title", ""), "price": item.get("price", "")}
        for cat_i, category in enumerate(pricing["categories"])
        for item in category["items"]
        if item.get("name")
    ]

    # Coverage total and the non-Gurugram cities, summed/read from areas.json
    # so neither can drift from the per-city counts on /locate-us/. Shared by
    # the home page hero band and the footer's "also serving" line below.
    areas_total_all = sum(c["count"] for c in areas_data["cities"])
    other_cities = [c["name"] for c in areas_data["cities"] if c["name"] != "Gurugram (Gurgaon)"]

    env.globals["product_urls"] = product_urls

    # Before/after for every hero. A page gets a pair from its own service
    # when proof.json has one; otherwise the closest kind of work we have
    # real photographs of (garments, shoes, bags, upholstery, toys).
    _pairs = {pr["id"]: pr for pr in proof["pairs"] if pr.get("before") and pr.get("after")}
    _by_svc: dict = {}
    for pr in _pairs.values():
        _by_svc.setdefault(pr["service"], []).append(pr)
    _fallback = {
        "leather-cleaning": "bag-cleaning", "accessories-cleaning": "bag-cleaning",
        "eco-friendly-laundry": "premium-dry-cleaning", "steam-ironing": "premium-dry-cleaning",
        "linen-cleaning": "premium-dry-cleaning", "blanket-quilt-cleaning": "premium-dry-cleaning",
        "wet-cleaning": "premium-dry-cleaning", "curtains-cleaning": "sofa-cleaning",
        "carpet-cleaning": "sofa-cleaning", "mattress-cleaning": "sofa-cleaning",
    }

    def _photo(src: str, alt: str, w: int = 1080, h: int = 1440) -> dict:
        return {"photo": {"src": f"images/{src}", "alt": alt, "w": w, "h": h}}

    # Services whose own before/after is the right picture for the page.
    _pair_services = {"shoe-cleaning", "sofa-cleaning", "bag-cleaning", "toy-cleaning", "premium-dry-cleaning"}
    # Everything else gets a photograph of that kind of work.
    _service_photo = {
        "eco-friendly-laundry": ("posters/premium-laundry.webp", "Freshly washed and folded laundry by Wash4You", 1080, 1440),
        "steam-ironing": ("heroes/steam-ironing.webp", "Wash4You team member steam pressing a blazer", 1145, 1374),
        "curtains-cleaning": ("heroes/curtains.webp", "Wash4You team member steam cleaning curtains", 1374, 1145),
        "carpet-cleaning": ("heroes/carpet.webp", "Wash4You team member deep cleaning a carpet at home", 933, 1400),
        "mattress-cleaning": ("posters/mattress-cleaning.webp", "Wash4You team deep cleaning a mattress", 1400, 933),
        "blanket-quilt-cleaning": ("heroes/blanket-quilt.webp", "Quilts and blankets cleaned and packed by Wash4You", 1400, 933),
        "linen-cleaning": ("gallery/linen.webp", "Linen cleaned and pressed by Wash4You", 1400, 1400),
        "wet-cleaning": ("posters/sweater.webp", "Woollens and delicates wet cleaned by Wash4You", 1080, 1440),
        "leather-cleaning": ("posters/leather-jacket-photo.webp", "Black leather jacket cleaned and conditioned by Wash4You", 933, 1400),
        "accessories-cleaning": ("proof/cap-after.webp", "Cap cleaned by Wash4You", 900, 1200),
    }
    # Product pages: a pair where we have one that matches, else the item's own photo.
    _product_pair = {"handbag-leather": "handbag", "lehenga": "lehenga", "t-shirt": "tee-stain"}
    _product_photo_fallback = {
        # no studio photo of their own: nearest same-family photograph
        "cardigan": "sweater", "sweatshirt": "sweater", "woollen-laundry": "sweater", "woollen-laundry-iron": "sweater",
        "coat": "blazer", "jacket": "blazer", "long-coat": "blazer",
        "blouse": "kurta-embroidered", "dupatta": "saree-blue", "salwar": "kurta-blue", "sherwani": "kurta-peacock",
        "palazzo": "pant-hanger", "top": "dress",
        "bed-spread-double": "blanket-bed", "double-bed-sheet": "blanket-bed",
    }
    _by_product = posters["by_product"]

    def hero_visual(service_slug: str = "premium-dry-cleaning", key: str = "", product: str = "") -> dict:
        """The hero picture for a page: a matching before/after where one exists, otherwise a relevant photograph."""
        if service_slug == "shoe-cleaning" and not product:
            return _photo("posters/worker-shoe-care.webp", "Wash4You team member hand-cleaning a sneaker", 1400, 933)
        if product:
            if product in _product_pair and _product_pair[product] in _pairs:
                return {"pair": _pairs[_product_pair[product]]}
            if service_slug == "shoe-cleaning" and _by_svc.get("shoe-cleaning"):
                pool = _by_svc["shoe-cleaning"]
                return {"pair": pool[sum(map(ord, product)) % len(pool)]}
            own = _by_product.get(product)
            if own:
                return _photo(own[0]["src"].replace("images/", "", 1), own[0]["alt"])
            fb = _product_photo_fallback.get(product)
            if fb:
                return _photo(f"posters/{fb}.webp", f"{product.replace('-', ' ').title()} cleaned by Wash4You")
        if service_slug in _pair_services and _by_svc.get(service_slug) and service_slug not in _service_photo:
            pool = _by_svc[service_slug]
            return {"pair": pool[sum(map(ord, key)) % len(pool)] if key else pool[0]}
        if service_slug in _service_photo:
            src, alt, w, h = _service_photo[service_slug]
            return _photo(src, alt, w, h)
        return _photo("posters/family-banner.webp", "Wash4You: care for everything that matters", 1400, 933)

    env.globals["hero_visual"] = hero_visual

    def hero_more(service_slug: str, product: str) -> list:
        """Other before/after pairs of the same kind of work, shown after the hero when the hero itself is a pair."""
        v = hero_visual(service_slug, product, product=product)
        if "pair" not in v:
            return []
        svc = v["pair"]["service"]
        return [pr for pr in _by_svc.get(svc, []) if pr["id"] != v["pair"]["id"]]

    # Home
    pages_to_build.append(("index.html", "page-home.html", {
        "areas": areas_data,
        "meta": home["meta"],
        "home": home,
        "services": services,
        # The home page price rail reads rates and images straight out of the
        # price list, so it can never quote a stale figure. Flattened to a
        # slug lookup here rather than in the template: Jinja resolves
        # `cat.items` to the dict METHOD, so walking pricing.json from a
        # template is a trap.
        "price_index": price_index,
        # Price-rail evidence figures. Derived from pricing.json so the home
        # page can never quote a stale catalogue size or a stale floor. The
        # `unit` filter excludes per-sq-ft and per-panel rates, which are not
        # comparable to a per-piece price.
        "price_count": sum(len(c["items"]) for c in pricing["categories"]),
        "price_min": min(
            item["amount"]
            for c in pricing["categories"]
            for item in c["items"]
            if not item.get("unit")
        ),
        "pricing_note": pricing["note"],
        # Coverage total, summed from areas.json so the headline figure can
        # never be typed by hand and drift from the per-city counts printed
        # directly beneath it.
        "areas_total": areas_total_all,
        "gurugram_areas": next(c["count"] for c in areas_data["cities"] if c["name"] == "Gurugram (Gurgaon)"),
        "proof": proof,
        "hero_pair": hero_pair,
        "testimonials": testimonials,
        "blog": blog,
        "depth": 0,
    }))

    # About
    # `home` is passed so the About page can render the SAME seven process
    # steps the home page does, from one source, instead of keeping its own
    # copy that can drift out of sync.
    pages_to_build.append(("about-us/index.html", "page-about.html", {
        "meta": about["meta"],
        "about": about,
        "home": home,
        "proof": proof,
        "testimonials": testimonials,
        "depth": 1,
    }))

    # Services list
    pages_to_build.append(("services/index.html", "page-services-list.html", {
        "home": home,
        "meta": services["meta"],
        "services": services,
        "depth": 1,
    }))

    # Service detail pages
    for svc_index, service in enumerate(services["services"]):
        # Proof photography that belongs to this specific service.
        service_proof = [p for p in proof["pairs"] if p["service"] == service["slug"]]
        pages_to_build.append((
            f"services/{service['slug']}{SERVICE_SLUG_SUFFIX}/index.html",
            "page-service-detail.html",
            {
                "meta": {
                    "title": service.get("meta_title") or f"{service['name']} – Wash4You",
                    "description": service.get("meta_description") or service["short_description"],
                    "canonical": f"{site['urls']['base']}/services/{service['slug']}/",
                },
                "service": service,
                # Binding prefix so the admin overlay can edit this service's
                # fields (the loop knows the array index; the template doesn't).
                "cms_base": f"services:services.{svc_index}",
                # Binding base for the copy that generated/services.json owns:
                # h1, lede, body, meta and faqs. None if this service has no
                # generated entry, in which case services.json IS the source.
                "gen_base": (
                    f"generated-services:services.{gen_index[service['slug']]}"
                    if service["slug"] in gen_index else None
                ),
                "service_proof": service_proof,
                "price_index": price_index,
                "testimonials": testimonials,
                "depth": 2,
            }
        ))

    # Pricing
    pages_to_build.append(("pricing/index.html", "page-pricing.html", {
        "meta": pricing["meta"],
        "pricing": pricing,
        "depth": 1,
    }))

    # Pricing by area — same rate list, one page per Gurugram area for local
    # SEO. Prices are identical; only the framing and canonical differ.
    for a in site.get("pricing_areas", []):
        pages_to_build.append((
            f"pricing/{a['slug']}/index.html",
            "page-pricing.html",
            {
                "meta": {
                    "title": f"Laundry & Dry-Clean Prices in {a['label']} — Wash4You",
                    "description": (
                        f"Transparent item-wise laundry and dry-cleaning rates for {a['label']}, "
                        f"Gurugram. Free doorstep pickup and delivery. GST extra."
                    ),
                    "canonical": f"{site['urls']['base']}/pricing/{a['slug']}/",
                },
                "pricing": pricing,
                "area": a,
                "depth": 2,
            }
        ))

    # Packages
    pages_to_build.append(("packages/index.html", "page-packages.html", {
        "meta": packages["meta"],
        "packages": packages,
        "depth": 1,
    }))

    # Product detail pages (pilot: Jeans; reusable across all catalog products)
    for prod in products_list:
        prod["meta"].setdefault("canonical", f"{site['urls']['base']}/products/{prod['slug']}/")
        pages_to_build.append((
            f"products/{prod['slug']}/index.html",
            "page-product-detail.html",
            {
                "meta": prod["meta"],
                "product": prod,
                "hero_more": hero_more(prod.get("parentService", {}).get("slug", "premium-dry-cleaning") if isinstance(prod.get("parentService"), dict) else "premium-dry-cleaning", prod["slug"]),
                "hero_visual": hero_visual(prod.get("parentService", {}).get("slug", "premium-dry-cleaning") if isinstance(prod.get("parentService"), dict) else "premium-dry-cleaning", prod["slug"], product=prod["slug"]),
                "home": home,
                "price_index": price_index,
                "depth": 2,
            }
        ))

    # Search landing pages ("best dryclean near me / in Gurgaon") and the
    # one-page Wash4You overview. Copy numbers — coverage totals and prices —
    # are filled from the live data so the pages cannot quote stale figures.
    gurugram_count = next(
        (c["count"] for c in areas_data["cities"] if c["name"].startswith("Gurugram")), 0
    )

    def fill_live(value):
        if isinstance(value, str):
            value = value.replace("{areas}", f"{areas_total_all}+").replace("{gurugram}", str(gurugram_count))
            return re.sub(r"\{price:([a-z0-9-]+)\}", lambda m: price_index[m.group(1)]["price"], value)
        if isinstance(value, list):
            return [fill_live(v) for v in value]
        if isinstance(value, dict):
            return {k: fill_live(v) for k, v in value.items()}
        return value

    landing = fill_live(load_json(DATA_DIR / "landing.json"))
    popular = [
        {**price_index[slug], "url": product_urls.get(slug, "pricing/")}
        for slug in landing["shared"]["popular"] if slug in price_index
    ]
    for lp in landing["pages"]:
        lp["meta"]["canonical"] = f"{site['urls']['base']}/{lp['slug']}/"
        pages_to_build.append((f"{lp['slug']}/index.html", "page-landing.html", {
            "meta": lp["meta"],
            "page": lp,
            "landing": landing["shared"],
            "popular": popular,
            "studio": product_shared.get("studio", {}),
            "studio_photos": product_shared.get("photos", {}).get("studio", []),
            "testimonials": testimonials,
            "areas": areas_data,
            "gurugram_count": gurugram_count,
            "depth": 1,
        }))

    overview_products = [
        {
            "title": cat["title"],
            "items": [
                {**item, "url": product_urls.get(item["slug"])}
                for item in cat["items"] if item.get("slug")
            ],
        }
        for cat in pricing["categories"]
    ]
    pages_to_build.append(("wash4you-overview/index.html", "page-overview.html", {
        "meta": {
            "title": "Wash4You at a Glance — Laundry & Dryclean in Gurgaon",
            "description": f"Everything Wash4You does on one page: dryclean, laundry, shoe and home care, {sum(len(c['items']) for c in overview_products)} published prices, packages, {areas_total_all}+ areas and two Gurugram stores.",
            "canonical": f"{site['urls']['base']}/wash4you-overview/",
        },
        "overview_products": overview_products,
        "item_count": sum(len(c["items"]) for c in overview_products),
        "packages": packages,
        "areas": areas_data,
        "home": home,
        "landing_pages": landing["pages"],
        "depth": 1,
    }))

    # Print-only price list — the source for wash4you-price-list.pdf. Standalone
    # (does not extend base.html), noindex, and kept out of the sitemap below.
    pages_to_build.append(("pricing-print.html", "page-pricing-print.html", {
        "pricing": pricing,
        "depth": 0,
    }))

    # Steam Iron
    pages_to_build.append(("steam-iron/index.html", "page-steam-iron.html", {
        "meta": steam["meta"],
        "steam": steam,
        "depth": 1,
    }))

    # Blog
    pages_to_build.append(("blog/index.html", "page-blog-list.html", {
        "meta": blog["meta"],
        "blog": blog,
        "depth": 1,
    }))

    # Blog posts: one page each at /<slug>/. Related = same category first,
    # then the rest, newest first. prev/next walk the newest-first list.
    _taken = {rel for rel, _t, _c in pages_to_build}
    for _i, _post in enumerate(blog["posts"]):
        _rel = f"{_post['slug']}/index.html"
        if _rel in _taken:
            raise SystemExit(f"Blog post slug '{_post['slug']}' collides with an existing page")
        _taken.add(_rel)
        _others = [p for p in blog["posts"] if p["slug"] != _post["slug"]]
        _others.sort(key=lambda p: p["category"] != _post["category"])  # stable: keeps date order
        pages_to_build.append((_rel, "page-blog-post.html", {
            "meta": {
                "title": _post["title"],
                "description": _post["meta_description"],
                "canonical": _post["url"],
                "og_title": _post["title"],
                "og_description": _post["meta_description"],
                "og_image": _post["image"] or "images/og-share.jpg",
                "og_type": "article",
            },
            "post": _post,
            "blog": blog,
            "related": _others[:3],
            "newer_post": blog["posts"][_i - 1] if _i > 0 else None,
            "older_post": blog["posts"][_i + 1] if _i + 1 < len(blog["posts"]) else None,
            "depth": 1,
        }))

    # Contact
    pages_to_build.append(("contact-us/index.html", "page-contact.html", {
        "meta": pages["contact"]["meta"],
        "pages": pages,
        "depth": 1,
    }))

    # Locate Us
    pages_to_build.append(("locate-us/index.html", "page-locate-us.html", {
        "home": home,
        "areas": areas_data,
        "meta": locations["meta"],
        "locations": locations,
        "depth": 1,
    }))

    # Area pages — one per entry in src/data/area-pages.json.
    #
    # That file is the single registry: name, live URL slug, character,
    # customer profile, service emphasis, nearest store, nearby areas and
    # (for areas whose copy is not already in generated/localities.json)
    # the long-form copy itself. Adding an entry there publishes a page; no
    # code change is needed. The ten original URLs are unchanged — those
    # entries carry a `content_slug` pointing at the authored copy that
    # already lives in generated/localities.json, so nothing was rewritten.
    url_map = {k: v for k, v in site["locality_urls"].items() if not k.startswith("_")}
    gen_localities = {loc["slug"]: loc for loc in gen.get("localities", [])}
    legacy_areas = {a["slug"]: a for a in locations["service_areas"]}
    stores_by_id = {loc["id"]: loc for loc in site["locations"]}
    area_by_slug = {a["slug"]: a for a in area_pages}

    # Label/URL pairs for every published area page. The footer keeps its
    # shorter curated list, but the coverage page, the header search index
    # and the LocalBusiness areaServed block all use this, so no generated
    # page is left without an inbound link.
    area_links = [{"label": a["name"], "url": a["slug"] + "/"} for a in area_pages]
    # "Areas we serve" is alphabetical everywhere it is listed (client request).
    area_links.sort(key=lambda a: a["label"].lower())
    site["footer"]["areas"] = sorted(site["footer"]["areas"], key=lambda a: a["label"].lower())
    site["pricing_areas"] = sorted(site.get("pricing_areas", []), key=lambda a: a["label"].lower())

    # Link the coverage list on /locate-us/ to the pages that now exist.
    # Done here rather than by hand-editing areas.json so the coverage list
    # can never point at an area page that was removed from the registry.
    coverage_urls = {a["coverage_name"]: a["slug"] + "/" for a in area_pages if a.get("coverage_name")}
    # Same idea for the other four cities, but keyed on (city, locality): a
    # "Sector 29" exists in Gurugram, Noida and Faridabad, and they are three
    # different pages.
    other_city_urls = {(a["city_slug"], a.get("coverage_name") or a["name"]): a["slug"] + "/" for a in coverage_pages}
    # Localities listed under two cities in areas.json (Indirapuram, Vaishali,
    # Kaushambi) have one page, under the city they are actually in; the other
    # city's list points at that same page rather than a duplicate.
    for name, slug in (("Indirapuram", "ghaziabad"), ("Vaishali", "ghaziabad"), ("Kaushambi", "ghaziabad")):
        other_city_urls[("noida", name)] = other_city_urls.get((slug, name), "")
    hub_by_city = {h["city_slug"]: h for h in coverage_hubs}
    for city in areas_data["cities"]:
        hub = hub_by_city.get(city["slug"])
        if hub:
            city["hub_url"] = hub["slug"] + "/"
        for column in city["columns"]:
            for item in column["items"]:
                if city["slug"] == "gurugram":
                    url = coverage_urls.get(item["name"])
                else:
                    url = other_city_urls.get((city["slug"], item["name"]))
                if url:
                    item["url"] = url

    # Label/URL pairs for the four city hubs. Used by the footer's "also
    # serving" line and by the hubs' own cross-links — four links, not 371.
    hub_links = [{"label": h["name"], "url": h["slug"] + "/"} for h in coverage_hubs]

    for entry in area_pages:
        url_slug = entry["slug"]
        area = dict(legacy_areas.get(url_slug, {}))
        area.update({k: v for k, v in entry.items() if v is not None})
        area["slug"] = url_slug

        # Long-form copy for the ten original areas still lives in
        # generated/localities.json; merge it in without letting it clobber
        # the registry fields (nearby, store, character, ...).
        content_slug = entry.get("content_slug")
        if content_slug:
            area["loc_slug"] = content_slug
            loc = gen_localities.get(content_slug)
            if loc:
                area.update({k: v for k, v in loc.items() if k != "slug"})
        area["name"] = entry["name"]

        # Which matrix pages exist for this area — the internal-link surface.
        matrix_key = content_slug or url_slug
        area["matrix"] = [m for m in gen.get("matrix", []) if m.get("locality") == matrix_key]

        # Nearby areas, resolved from the registry so a link can never point
        # at a page that is not built.
        area["nearby_links"] = [
            {"label": area_by_slug[s]["name"], "url": s + "/"}
            for s in entry.get("nearby", []) if s in area_by_slug
        ]
        area["store"] = stores_by_id.get(entry.get("nearest_store"))
        area["emphasis"] = [
            services_by_slug[s] for s in entry.get("service_emphasis", [])
            if s in services_by_slug
        ]

        pages_to_build.append((
            f"{url_slug}/index.html",
            "page-location.html",
            {
                "meta": {
                    "title": area.get("meta_title") or area.get("title"),
                    "description": area.get("meta_description") or area.get("description"),
                    "canonical": f"{site['urls']['base']}/{url_slug}/",
                },
                "area": area,
                "services": services,
                "testimonials": testimonials,
                "depth": 1,
            }
        ))

    # Coverage (service-area) pages for the four non-Gurugram cities, plus one
    # hub per city. Same loop shape as the area pages above, different template
    # and different registry, because the honest claim is different: these are
    # areas we will travel to, not places we have a shop in. Nothing here
    # renders a nearest store, a local address or a LocalBusiness schema.
    coverage_by_slug = {c["slug"]: c for c in coverage_pages}
    for hub in coverage_hubs:
        hub["all_links"] = [
            {"label": it["name"], "url": it["slug"] + "/"}
            for zone in hub["zones"] for it in zone["items"]
        ]
        pages_to_build.append((
            f"{hub['slug']}/index.html",
            "page-coverage-hub.html",
            {
                "meta": {
                    "title": hub["meta_title"],
                    "description": hub["meta_description"],
                    "canonical": f"{site['urls']['base']}/{hub['slug']}/",
                },
                "hub": hub,
                "hub_links": hub_links,
                "depth": 1,
            }
        ))

    for entry in coverage_pages:
        area = dict(entry)
        area["nearby_links"] = [
            {"label": coverage_by_slug[s]["name"], "url": s + "/"}
            for s in entry.get("nearby", []) if s in coverage_by_slug
        ]
        pages_to_build.append((
            f"{entry['slug']}/index.html",
            "page-coverage.html",
            {
                "meta": {
                    "title": entry["meta_title"],
                    "description": entry["meta_description"],
                    "canonical": f"{site['urls']['base']}/{entry['slug']}/",
                },
                "area": area,
                "services": services,
                "depth": 1,
            }
        ))

    # Service x locality long-tail pages.
    service_by_slug = {s["slug"]: s for s in services["services"]}
    for m in gen.get("matrix", []):
        svc = service_by_slug.get(m["service"])
        loc_url = url_map.get(m["locality"])
        if not svc or not loc_url:
            continue
        slug = f"{m['service']}-{m['locality']}"
        pages_to_build.append((
            f"{slug}/index.html",
            "page-matrix.html",
            {
                "meta": {
                    "title": m["meta_title"],
                    "description": m["meta_description"],
                    "canonical": f"{site['urls']['base']}/{slug}/",
                },
                "entry": m,
                "service": svc,
                "locality_url": loc_url,
                "locality_name": next(
                    (a["label"] for a in site["footer"]["areas"] if a["url"].rstrip("/") == loc_url),
                    m["locality"].replace("-", " ").title(),
                ),
                "services": services,
                # Sibling links. These 79 programmatic pages each had ONE
                # inbound internal link, so they carried almost no internal
                # link equity and sat at the edge of the crawl graph. Two
                # cheap, genuinely useful cross-links fix that: the same
                # service in nearby localities, and the other services
                # available in this locality.
                "same_service_elsewhere": [
                    o for o in gen["matrix"]
                    if o["service"] == m["service"] and o["locality"] != m["locality"]
                ][:6],
                "other_services_here": [
                    o for o in gen["matrix"]
                    if o["locality"] == m["locality"] and o["service"] != m["service"]
                ][:6],
                "depth": 1,
            }
        ))

    # Policy pages
    for pol_index, policy in enumerate(policies["policies"]):
        pages_to_build.append((
            f"{policy['slug']}/index.html",
            "page-policy.html",
            {
                "meta": {
                    "title": policy["meta_title"],
                    "description": policy["meta_description"],
                    "canonical": policy["canonical"],
                    "og_title": policy["meta_title"],
                    "og_description": policy["meta_description"],
                },
                "policy": policy,
                "cms_base": f"policies:policies.{pol_index}",
                "depth": 1,
            }
        ))

    # 404
    pages_to_build.append(("404.html", "page-404.html", {
        "meta": pages["not_found"]["meta"],
        "pages": pages,
        "depth": 0,
    }))

    # Studio state (layout order / hidden sections / widget blocks / styles).
    studio_layout, studio_blocks, studio_styles = studio.load_layout(), studio.load_blocks(), studio.load_styles()
    seo_pages = seo_overrides.load()

    # Render all pages
    template_cache = {}
    for rel_path, template_name, context in pages_to_build:
        template = template_cache.get(template_name)
        if template is None:
            template = env.get_template(template_name)
            template_cache[template_name] = template

        depth = context.pop("depth")
        root_path, asset_path = get_paths(depth)
        # Normalise every page's title and description to the widths search
        # results actually display, in one place, so no template has to care.
        meta = context.get("meta")
        if isinstance(meta, dict):
            meta = dict(meta)
            meta["title"] = fit_title(meta.get("title") or "")
            meta["description"] = fit_description(meta.get("description") or "")
            meta.setdefault("og_title", meta["title"])
            meta.setdefault("og_description", meta["description"])
            context["meta"] = meta

        context["site"] = site
        context["root_path"] = root_path
        context["asset_path"] = asset_path
        # The footer lists services on every page, so make them globally
        # available rather than threading them through each registration.
        context.setdefault("services", services)
        # The header search index needs blog posts on every page too.
        context.setdefault("blog", blog)
        # Blog cards resolve their hero image through this — see above.
        context.setdefault("services_by_slug", services_by_slug)
        # The header search index needs every priced item on every page too.
        context.setdefault("search_pricing_items", search_pricing_items)
        # The footer's "also serving" line needs the full coverage figure and
        # the other-city names on every page, not just the home page.
        context.setdefault("areas_total_all", areas_total_all)
        context.setdefault("other_cities", other_cities)
        # Every published area page, for the header search index, the
        # LocalBusiness areaServed block and the coverage page grid.
        # NOTE: area_links stays Gurugram-only. base.html appends ", Gurugram"
        # to every entry in the LocalBusiness areaServed block, and the header
        # search index renders one row per entry on every page — putting 371
        # out-of-city localities in there would both mislabel them and bloat
        # every page on the site. The other cities are reached through the four
        # hub links instead.
        context.setdefault("area_links", area_links)
        context.setdefault("hub_links", hub_links)
        # The footer's All Products section walks the full price list on
        # every page too.
        context.setdefault("pricing", pricing)
        context.setdefault("products_list", products_list)
        context.setdefault("product_urls", product_urls)
        context.setdefault("product_urls_by_name", product_urls_by_name)

        rendered = template.render(**context)
        rendered = SERVICE_URL_RE.sub(lambda m: f"services/{m.group(1)}{SERVICE_SLUG_SUFFIX}/", rendered)
        if not EDIT_MODE and template_name != "page-pricing-print.html":
            rendered = highlight_seo_keywords(rendered)
        if template_name not in ("page-pricing-print.html",):
            rendered = studio.apply(rendered, rel_path, template_name, env, root_path, asset_path,
                                    edit=EDIT_MODE, layout=studio_layout, blocks=studio_blocks, styles=studio_styles)
        if seo_pages and template_name != "page-pricing-print.html":
            rendered = seo_overrides.apply(rendered, rel_path, seo_pages, site["urls"]["base"])
        write_html(DIST_DIR / rel_path, rendered)
        print(f"Built: {rel_path}")

    (DIST_DIR / "assets" / "css" / "studio-custom.css").write_text(studio.css(studio_styles), encoding="utf-8")

    # Old service URLs -> new ones. Static hosting has no 301s, so leave a
    # canonical + meta-refresh stub at each old path (kept out of the sitemap).
    for svc in services["services"]:
        new_url = f"{site['urls']['base']}/services/{svc['slug']}{SERVICE_SLUG_SUFFIX}/"
        write_html(DIST_DIR / "services" / svc["slug"] / "index.html",
                   '<!doctype html><html lang="en"><head><meta charset="utf-8">'
                   f'<title>{html.escape(svc["name"])} – Wash4You</title>'
                   f'<link rel="canonical" href="{new_url}">'
                   f'<meta http-equiv="refresh" content="0; url={new_url}">'
                   '<meta name="robots" content="noindex,follow"></head>'
                   f'<body><a href="{new_url}">{html.escape(svc["name"])}</a></body></html>')

    # /book-pickup/ was briefly a page of its own. Booking now lives on the external
    # booking page; this keeps the old address working (kept out of the sitemap).
    _book = site["urls"]["booking"]
    write_html(DIST_DIR / "book-pickup" / "index.html",
               '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Book your pickup | Wash4You</title>'
               f'<meta http-equiv="refresh" content="0; url={_book}">'
               '<meta name="robots" content="noindex"></head>'
               f'<body><p>Opening the Wash4You booking page… <a href="{_book}">Tap here if nothing happens</a>.</p>'
               f'<script>location.replace({json.dumps(_book)})</script></body></html>')

    # Sitemap, derived from the page registry so it can never drift out of
    # sync with what was actually built.
    base = site["urls"]["base"]
    priorities = [("index.html", "1.0"), ("services/", "0.9"), ("products/", "0.85"), ("pricing/", "0.8")]
    urls = []
    for rel_path, _tpl, _ctx in pages_to_build:
        if rel_path in ("404.html", "pricing-print.html"):
            continue
        path = rel_path[: -len("index.html")] if rel_path.endswith("index.html") else rel_path
        loc = f"{base}/{path}"
        prio = "0.7"
        for prefix, p in priorities:
            if rel_path == prefix or path.startswith(prefix):
                prio = p
                break
        urls.append((loc, prio))

    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for loc, prio in urls:
        sitemap.append(f"  <url><loc>{html.escape(loc)}</loc><priority>{prio}</priority></url>")
    sitemap.append("</urlset>")
    (DIST_DIR / "sitemap.xml").write_text("\n".join(sitemap) + "\n", encoding="utf-8")

    (DIST_DIR / "robots.txt").write_text(
        f"User-agent: *\nAllow: /\n\nSitemap: {base}/sitemap.xml\n", encoding="utf-8"
    )
    (DIST_DIR / ".nojekyll").write_text("", encoding="utf-8")

    # QR codes on packaging and the footer point at /menu/. It forwards to the
    # booking app, so a printed code keeps working whatever else changes.
    menu_dir = DIST_DIR / "menu"
    menu_dir.mkdir(exist_ok=True)
    target = html.escape(site["urls"]["schedule"], quote=True)
    (menu_dir / "index.html").write_text(
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<title>Book your pickup | Wash4You</title><meta name="robots" content="noindex">'
        f'<meta http-equiv="refresh" content="0; url={target}">'
        f'<link rel="canonical" href="{target}"></head><body>'
        f'<p>Opening the Wash4You booking app\u2026 <a href="{target}">Tap here if nothing happens</a>.</p>'
        f'<script>location.replace("{target}")</script></body></html>', encoding="utf-8")

    # Sync dist/products to repo root products/ for GitHub Pages static serving
    repo_products = ROOT.parent / "products"
    if (DIST_DIR / "products").exists():
        if repo_products.exists():
            shutil.rmtree(repo_products)
        shutil.copytree(DIST_DIR / "products", repo_products)

    print(f"\nDone. Generated {len(pages_to_build)} pages + sitemap ({len(urls)} URLs) in {DIST_DIR}")


if __name__ == "__main__":
    try:
        build()
    except Exception as e:
        print(f"Build failed: {e}", file=sys.stderr)
        raise
