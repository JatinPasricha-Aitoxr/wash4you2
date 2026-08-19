#!/usr/bin/env python3
"""Wash4You static site generator."""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import sys
from pathlib import Path

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


def _make_cms(enabled: bool):
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

    def cms(path: str, kind: str = "text") -> "Markup | str":
        if not enabled:
            return ""
        safe = html.escape(path, quote=True)
        # kind="file" binds an <img> to a fixed asset on disk (template
        # literals like the mascot/logo that have no JSON field); swapping it
        # overwrites that file under src/assets/. Everything else binds to a
        # JSON location "<store>:<path>" and edits that value.
        if kind == "file":
            return Markup(f' data-cms-file="{safe}"')
        return Markup(f' data-cms="{safe}" data-cms-kind="{html.escape(kind, quote=True)}"')

    return cms


BRAND_SUFFIXES = (" | Wash4You", " — Wash4You", " - Wash4You", " | Wash4You Gurugram")


def _deal_wall(tiles: list, columns: int, per_column: int) -> list:
    """Deal a tile pool into columns for the home hero wall.

    Fills the grid in column-major order and wraps. Two properties this
    relies on, both of which a "cleverer" strided deal loses:

      - every tile appears, provided columns*per_column >= len(tiles).
        A stride whose parity divides into len(tiles) silently locks out
        part of the pool — a 7-stride over 24 tiles renders only 18.
      - horizontal neighbours always differ: the same row in adjacent
        columns is exactly per_column apart in the pool.
    """
    if not tiles:
        return []
    n = len(tiles)
    return [
        [tiles[(col * per_column + row) % n] for row in range(per_column)]
        for col in range(columns)
    ]


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
    pricing = load_json(DATA_DIR / "pricing.json")
    packages = load_json(DATA_DIR / "packages.json")
    steam = load_json(DATA_DIR / "steam-iron.json")
    blog = load_json(DATA_DIR / "blog.json")
    locations = load_json(DATA_DIR / "locations.json")
    policies = load_json(DATA_DIR / "policies.json")
    pages = load_json(DATA_DIR / "pages.json")
    proof = load_json(DATA_DIR / "proof.json")
    areas_data = load_json(DATA_DIR / "areas.json")
    testimonials = load_json(DATA_DIR / "testimonials.json")

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
        trim_blocks=True, lstrip_blocks=True, autoescape=True,
    )
    env.filters["markdown"] = lambda s: Markup(markdown_to_html(s))
    env.globals["edit_mode"] = EDIT_MODE
    env.globals["cms"] = _make_cms(EDIT_MODE)

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
        # Hero garment wall: deal the tile pool into columns here rather
        # than in the template. The pool (24) is smaller than the number of
        # slots (10x5), so it has to wrap — and the stride is what stops a
        # plain wrap from parking the same garment next to itself in the
        # adjacent column.
        "hero_wall_columns": _deal_wall(
            home["hero_wall"]["tiles"],
            home["hero_wall"]["columns"],
            home["hero_wall"]["per_column"],
        ),
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
        "areas_total": sum(c["count"] for c in areas_data["cities"]),
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
            f"services/{service['slug']}/index.html",
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

    # Location pages.
    # The generated copy is keyed by a plain locality slug ("sushant-lok");
    # the live URL keeps the original "laundry-service-*" path so none of the
    # eight existing URLs change. site.json holds the mapping.
    url_map = {k: v for k, v in site["locality_urls"].items() if not k.startswith("_")}
    gen_localities = {loc["slug"]: loc for loc in gen.get("localities", [])}

    for loc_slug, url_slug in url_map.items():
        loc = gen_localities.get(loc_slug)
        legacy = next((a for a in locations["service_areas"] if a["slug"] == url_slug), None)
        if not loc and not legacy:
            continue

        area = dict(legacy or {})
        area["slug"] = url_slug
        area["loc_slug"] = loc_slug
        area["name"] = next(
            (a["label"] for a in site["footer"]["areas"] if a["url"].rstrip("/") == url_slug),
            area.get("name", loc_slug.replace("-", " ").title()),
        )
        if loc:
            area.update({k: v for k, v in loc.items() if k != "slug"})

        # Which matrix pages exist for this locality — the internal-link surface.
        area["matrix"] = [m for m in gen.get("matrix", []) if m.get("locality") == loc_slug]

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

        rendered = template.render(**context)
        write_html(DIST_DIR / rel_path, rendered)
        print(f"Built: {rel_path}")

    # Sitemap, derived from the page registry so it can never drift out of
    # sync with what was actually built.
    base = site["urls"]["base"]
    priorities = [("index.html", "1.0"), ("services/", "0.9"), ("pricing/", "0.8")]
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

    print(f"\nDone. Generated {len(pages_to_build)} pages + sitemap ({len(urls)} URLs) in {DIST_DIR}")


if __name__ == "__main__":
    try:
        build()
    except Exception as e:
        print(f"Build failed: {e}", file=sys.stderr)
        raise
