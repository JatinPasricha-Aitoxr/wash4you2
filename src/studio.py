"""Wash4You Studio — the build-side half of the visual editor.

The site is generated from templates + JSON. The Studio adds three things on
top without changing how any template is written:

1. LAYOUT AS DATA. Every top-level <section> inside <main> gets a stable id
   (data-sec). `data/layout.json` can reorder them and hide them per page, or
   for every page that shares a template ("tpl:page-product-detail.html").
2. WIDGETS. `data/blocks.json` holds extra blocks (text, image+text, gallery,
   CTA, stats, FAQ, video, HTML, spacer, hero) that are rendered from
   templates/_blocks.html and placed through the same layout order.
3. STYLES. `data/styles.json` holds per-section and per-field style overrides
   and global theme colours, emitted as assets/css/studio-custom.css.

`apply()` runs on every rendered page. With edit mode off (production) hidden
sections are removed; in edit mode they are kept, flagged, so the Studio can
show them dimmed and let you bring them back.
"""

from __future__ import annotations

import hashlib
import html as _html
import json
import re
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"

LAYOUT_FILE = DATA_DIR / "layout.json"
BLOCKS_FILE = DATA_DIR / "blocks.json"
STYLES_FILE = DATA_DIR / "styles.json"

BLOCK_TYPES = ("hero", "heading", "image_text", "gallery", "cta", "stats", "faq", "video", "spacer", "html",
               "button", "image", "features", "testimonials", "columns", "pricing", "divider")

# Font choices offered by the Studio. The editor stores the KEY (never raw CSS);
# the stacks live here and in cms/public/studio/studio.js. The first four are
# the site's own self-hosted fonts; the rest are safe system stacks.
FONTS = {
    "fraunces": "'Fraunces', Georgia, 'Times New Roman', serif",
    "hanken": "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    "bricolage": "'Bricolage Grotesque', 'Hanken Grotesk', sans-serif",
    "plexmono": "'IBM Plex Mono', ui-monospace, Menlo, monospace",
    "georgia": "Georgia, 'Times New Roman', serif",
    "times": "'Times New Roman', Times, serif",
    "arial": "Arial, Helvetica, sans-serif",
    "verdana": "Verdana, Geneva, sans-serif",
    "trebuchet": "'Trebuchet MS', Helvetica, sans-serif",
    "system": "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    "courier": "'Courier New', Courier, monospace",
}
GLOBAL_FONT_VARS = ("--font-display", "--font-sans")

# Breakpoints used by the "hide on device" switches (match the site CSS).
BP_TABLET_MIN = "40.0625rem"
BP_DESKTOP_MIN = "62rem"

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
         "meta", "param", "source", "track", "wbr"}
_TAG = re.compile(
    r"<!--.*?-->|<(/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\"[^\"]*\"|'[^']*'|[^>\"'])*)>", re.S)


# ------------------------------------------------------------------ state
def _load(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return default
    return default


def load_layout() -> dict:
    d = _load(LAYOUT_FILE, {})
    d.setdefault("pages", {})
    return d


def load_blocks() -> dict:
    d = _load(BLOCKS_FILE, {})
    d.setdefault("pages", {})
    return d


def load_styles() -> dict:
    d = _load(STYLES_FILE, {})
    d.setdefault("sections", {})
    d.setdefault("elements", {})
    d.setdefault("global", {})
    return d


def styled_bindings() -> set[str]:
    """Bindings that carry a style override (they get a data-sid attribute)."""
    return set(load_styles()["elements"].keys())


def scope_keys(rel_path: str, template_name: str) -> list[str]:
    """Most general first: template-wide, then this exact page."""
    return [f"tpl:{template_name}", f"page:{rel_path}"]


# --------------------------------------------------------------- scanning
def _find_main(html: str):
    m = re.search(r"<main\b[^>]*>", html)
    if not m:
        return None
    end = html.find("</main>", m.end())
    if end < 0:
        return None
    return m.end(), end


def find_sections(inner: str) -> list[dict]:
    """Outermost <section> elements of `inner` as {start, end, open, depth}
    (any <section> that is not itself inside another <section>), in document
    order - whether they sit directly in <main> or inside wrapper <div>s."""
    found = []
    stack: list[tuple[str, int, int, str]] = []  # (tag, start, depth, open_text)
    pos = 0
    while True:
        m = _TAG.search(inner, pos)
        if not m:
            break
        pos = m.end()
        if m.group(0).startswith("<!--"):
            continue
        closing, name = m.group(1), m.group(2).lower()
        if not closing and name in ("script", "style"):
            close = re.search(rf"</{name}\s*>", inner[pos:], re.I)
            pos = pos + close.end() if close else len(inner)
            continue
        if not closing:
            if name in _VOID or m.group(0).endswith("/>"):
                continue
            stack.append((name, m.start(), len(stack), m.group(0)))
        else:
            for i in range(len(stack) - 1, -1, -1):
                if stack[i][0] == name:
                    tag, start, depth, open_text = stack[i]
                    nested = any(t[0] == "section" for t in stack[:i])
                    del stack[i:]
                    if tag == "section" and not nested:
                        found.append({"start": start, "end": m.end(), "open": open_text, "depth": depth})
                    break
    if not found:
        return []
    found.sort(key=lambda s: s["start"])
    return found


def _classes(open_tag: str) -> str:
    m = re.search(r'class="([^"]*)"', open_tag)
    return " ".join((m.group(1) if m else "").split())


def _label(fragment: str, open_tag: str) -> str:
    h = re.search(r"<h[1-3][^>]*>(.*?)</h[1-3]>", fragment, re.S)
    if h:
        text = re.sub(r"<[^>]+>", " ", h.group(1))
        text = " ".join(_html.unescape(text).split())
        if text:
            return text[:60]
    cls = _classes(open_tag).replace("section", "").strip()
    return (cls.split(" ")[0] if cls else "Section").replace("-", " ").replace("_", " ").title()


def _assign_ids(sections: list[dict], inner: str) -> None:
    """Stable ids from the class list + occurrence number (content-independent,
    so editing a headline never changes a section's id)."""
    seen: dict[str, int] = {}
    for s in sections:
        sig = _classes(s["open"]) or "section"
        short = re.sub(r"[^a-z0-9]+", "-", sig.lower()).strip("-")[:28] or "section"
        key = hashlib.md5(sig.encode()).hexdigest()[:4]
        n = seen.get(sig, 0) + 1
        seen[sig] = n
        s["id"] = f"{short}-{key}" + (f"-{n}" if n > 1 else "")
        s["label"] = _label(inner[s["start"]:s["end"]], s["open"])


# ----------------------------------------------------------------- blocks
def render_block(env, block: dict, root_path: str, asset_path: str) -> str:
    """HTML for one widget block. Never raises: a bad block renders a notice."""
    btype = block.get("type")
    if btype not in BLOCK_TYPES:
        return ""
    props = dict(block.get("props") or {})
    if btype == "video":
        props["embed"] = _embed_url(props.get("url", ""))
    block = {**block, "props": props}
    try:
        tpl = env.get_template("_blocks.html")
        macro = getattr(tpl.module, f"block_{btype}")
        body = str(macro(block.get("props") or {}, root_path, asset_path))
    except Exception as e:  # keep the page building whatever the props hold
        body = f'<section class="section"><div class="wrap"><p>Block error: {_html.escape(str(e))}</p></div></section>'
    # Tag the block's root <section> with its id so layout / styles can find it.
    bid = _html.escape(block.get("id", ""), quote=True)
    body = body.strip()
    body = re.sub(r"^<section\b", f'<section data-block="{bid}" data-block-type="{btype}"', body, count=1)
    return body


def _embed_url(url: str) -> str:
    """YouTube / Vimeo watch link -> embeddable URL ("" if not recognised)."""
    url = (url or "").strip()
    m = re.search(r"(?:youtube\.com/(?:watch\?v=|embed/|shorts/)|youtu\.be/)([A-Za-z0-9_-]{6,})", url)
    if m:
        return f"https://www.youtube-nocookie.com/embed/{m.group(1)}"
    m = re.search(r"vimeo\.com/(?:video/)?(\d+)", url)
    if m:
        return f"https://player.vimeo.com/video/{m.group(1)}"
    return ""


# ------------------------------------------------------------------ apply
def _merge_order(original: list[str], saved: list[str] | None) -> list[str]:
    """The saved order wins; ids it does not know yet (new template sections)
    slot in after the id that preceded them in the original order."""
    if not saved:
        return list(original)
    final = [i for i in saved if i in original or i.startswith("blk-")]
    for idx, sid in enumerate(original):
        if sid in final:
            continue
        prev = original[idx - 1] if idx else None
        at = final.index(prev) + 1 if prev in final else 0
        final.insert(at, sid)
    return final


def effective(rel_path: str, template_name: str, layout: dict, blocks: dict, styles: dict):
    """Resolve the layout/blocks/styles that apply to one page."""
    lay = {"order": None, "hidden": set()}
    blk: list[dict] = []
    sec_styles: dict[str, dict] = {}
    for key in scope_keys(rel_path, template_name):
        entry = layout["pages"].get(key)
        if entry:
            if entry.get("order") is not None:
                lay["order"] = entry["order"]
            lay["hidden"] = set(entry.get("hidden") or [])
        blk = blk + list(blocks["pages"].get(key, []))
        sec_styles.update(styles["sections"].get(key, {}))
    return lay, blk, sec_styles


def apply(html: str, rel_path: str, template_name: str, env, root_path: str,
          asset_path: str, edit: bool, layout=None, blocks=None, styles=None) -> str:
    """Tag sections, apply order/visibility, inject blocks. Returns new HTML."""
    span = _find_main(html)
    if not span:
        return html
    layout = layout or load_layout()
    blocks = blocks or load_blocks()
    styles = styles or load_styles()
    a, b = span
    inner = html[a:b]
    sections = find_sections(inner)

    lay, block_defs, _ = effective(rel_path, template_name, layout, blocks, styles)
    if not sections and not block_defs:
        return _tag_body(html, rel_path, template_name, edit)
    _assign_ids(sections, inner)

    original_ids = [s["id"] for s in sections]
    pieces: dict[str, str] = {}
    labels: dict[str, str] = {}
    for s in sections:
        pieces[s["id"]] = inner[s["start"]:s["end"]]
        labels[s["id"]] = s["label"]
    for blk in block_defs:
        if not blk.get("id"):
            continue
        pieces[blk["id"]] = render_block(env, blk, root_path, asset_path)
        labels[blk["id"]] = {"hero": "Hero", "heading": "Heading", "image_text": "Image + text", "gallery": "Gallery",
                             "cta": "Call to action", "stats": "Stats", "faq": "FAQ", "video": "Video",
                             "spacer": "Spacer", "html": "HTML"}.get(blk.get("type"), "Block")

    block_ids = [b["id"] for b in block_defs if b.get("id")]
    base_order = original_ids + [i for i in block_ids if i not in original_ids]
    order = _merge_order(base_order, lay["order"])
    hidden = lay["hidden"]

    def decorate(sid: str, frag: str) -> str:
        m = re.match(r"<section\b", frag)
        if not m:
            return frag
        attrs = f' data-sec="{_html.escape(sid, quote=True)}"'
        if edit:
            attrs += f' data-sec-label="{_html.escape(labels.get(sid, ""), quote=True)}"'
            if sid in hidden:
                attrs += ' data-sec-hidden="1"'
        if 'data-sec="' in frag[:200]:
            return frag
        return "<section" + attrs + frag[len("<section"):]

    out_items = []
    for sid in order:
        frag = pieces.get(sid)
        if frag is None:
            continue
        if sid in hidden and not edit:
            frag = ""
        else:
            frag = decorate(sid, frag)
        out_items.append(frag)

    if sections:
        # Keep every non-section byte where it was: fill the original section
        # slots in order, and append any extra items (new blocks) after the last.
        rebuilt, cursor, k = [], 0, 0
        for s in sections:
            rebuilt.append(inner[cursor:s["start"]])
            rebuilt.append(out_items[k] if k < len(out_items) else "")
            k += 1
            cursor = s["end"]
        rebuilt.append("".join(out_items[k:]))
        rebuilt.append(inner[cursor:])
        new_inner = "".join(rebuilt)
    else:
        new_inner = inner + "".join(out_items)

    html = html[:a] + new_inner + html[b:]
    return _tag_body(html, rel_path, template_name, edit)


def _tag_body(html: str, rel_path: str, template_name: str, edit: bool) -> str:
    """Page identity on <body>, used by scoped CSS (and by the Studio)."""
    slug = re.sub(r"[^a-z0-9]+", "-", rel_path.lower()).strip("-") or "home"
    tpl = re.sub(r"[^a-z0-9]+", "-", template_name.lower()).strip("-")
    extra = f' data-pagekey="{_html.escape(rel_path, quote=True)}" data-tpl="{_html.escape(template_name, quote=True)}"'
    m = re.search(r"<body\b([^>]*)>", html)
    if not m:
        return html
    attrs = m.group(1)
    cm = re.search(r'class="([^"]*)"', attrs)
    cls = f"{cm.group(1)} " if cm else ""
    cls += f"pg-{slug} tpl-{tpl}"
    attrs = re.sub(r'\s*class="[^"]*"', "", attrs)
    return html[:m.start()] + f'<body class="{cls}"{attrs}{extra}>' + html[m.end():]


# -------------------------------------------------------------------- css
def _decl(props: dict, allowed: dict[str, str]) -> str:
    out = []
    for key, css in allowed.items():
        v = props.get(key)
        if v in (None, "", False):
            continue
        s = str(v)
        if not re.fullmatch(r"[#A-Za-z0-9 .,()%/_\-+]*", s):
            continue
        out.append(f"{css}:{s}")
    return ";".join(out)


def css(styles: dict | None = None) -> str:
    """The generated studio-custom.css."""
    styles = styles or load_styles()
    rules = ["/* Generated by the Studio from data/styles.json - do not edit by hand. */"]
    g = styles.get("global") or {}
    gv = [f"{k}:{v}" for k, v in g.items() if re.fullmatch(r"--[a-z0-9-]+", k) and re.fullmatch(r"#[0-9a-fA-F]{3,8}", str(v))]
    gv += [f"{k}:{FONTS[v]}" for k, v in g.items() if k in GLOBAL_FONT_VARS and v in FONTS]
    if gv:
        rules.append(":root{" + ";".join(gv) + "}")

    sec_allowed = {"bg": "background", "color": "color", "padTop": "padding-top", "padBottom": "padding-bottom",
                   "marginTop": "margin-top", "marginBottom": "margin-bottom", "radius": "border-radius",
                   "minHeight": "min-height", "textAlign": "text-align"}
    px_keys = ("padTop", "padBottom", "marginTop", "marginBottom", "radius", "minHeight")
    for scope, secs in (styles.get("sections") or {}).items():
        if scope.startswith("tpl:"):
            prefix = ".tpl-" + re.sub(r"[^a-z0-9]+", "-", scope[4:].lower()).strip("-")
        else:
            prefix = ".pg-" + (re.sub(r"[^a-z0-9]+", "-", scope[5:].lower()).strip("-") or "home")
        for sid, props in secs.items():
            if not re.fullmatch(r"[A-Za-z0-9_-]+", sid):
                continue
            sel = f'{prefix} [data-sec="{sid}"]'
            p = dict(props)
            for k in px_keys:
                if p.get(k) not in (None, "") and re.fullmatch(r"-?\d+", str(p[k])):
                    p[k] = f"{p[k]}px"
            decls = [x for x in _decl(p, sec_allowed).split(";") if x]
            # Background image / gradient go AFTER the colour shorthand so they win.
            img = str(props.get("bgImage") or "")
            if re.fullmatch(r"images/[A-Za-z0-9_./-]+", img) and ".." not in img:
                layers = []
                ov = str(props.get("bgOverlay") or "")
                if re.fullmatch(r"\d{1,2}", ov) and int(ov) > 0:
                    a = round(int(ov) / 100, 2)
                    layers.append(f"linear-gradient(rgba(11,30,60,{a}),rgba(11,30,60,{a}))")
                layers.append(f"url('../{img}')")
                size = "contain" if props.get("bgSize") == "contain" else "cover"
                decls += [f"background-image:{','.join(layers)}", f"background-size:{size}",
                          "background-position:center", "background-repeat:no-repeat"]
            else:
                gf, gt = str(props.get("gradFrom") or ""), str(props.get("gradTo") or "")
                ang = str(props.get("gradAngle") or "135")
                hexre = r"#[0-9a-fA-F]{3,8}"
                if re.fullmatch(hexre, gf) and re.fullmatch(hexre, gt) and re.fullmatch(r"\d{1,3}", ang):
                    decls.append(f"background-image:linear-gradient({ang}deg,{gf},{gt})")
            if props.get("radius") not in (None, "", "0", 0):
                decls.append("overflow:hidden")
            if props.get("shadow"):
                decls.append("box-shadow:0 18px 48px rgba(11,30,60,.22)")
            if decls:
                rules.append(f"{sel}{{" + ";".join(x + " !important" for x in decls) + "}")
            # A widget's text colour reaches its headings and paragraphs too (they set their own colour).
            if props.get("color") and re.fullmatch(r"#[0-9a-fA-F]{3,8}|[a-z]{3,20}", str(props["color"])):
                rules.append(f"{sel}[data-block] :is(h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,small,strong,span){{color:inherit !important}}")
            mw = str(props.get("maxWidth") or "")
            if re.fullmatch(r"\d{3,4}", mw):
                rules.append(f"{sel} .wrap{{max-width:{mw}px !important}}")
            if props.get("hideMobile"):
                rules.append(f"@media (max-width:40rem){{{sel}{{display:none !important}}}}")
            if props.get("hideTablet"):
                rules.append(f"@media (min-width:{BP_TABLET_MIN}) and (max-width:61.99rem){{{sel}{{display:none !important}}}}")
            if props.get("hideDesktop"):
                rules.append(f"@media (min-width:{BP_DESKTOP_MIN}){{{sel}{{display:none !important}}}}")

    el_allowed = {"color": "color", "fontSize": "font-size", "fontWeight": "font-weight",
                  "textAlign": "text-align", "lineHeight": "line-height", "letterSpacing": "letter-spacing",
                  "textTransform": "text-transform", "fontStyle": "font-style"}
    for binding, props in (styles.get("elements") or {}).items():
        if not re.fullmatch(r"[A-Za-z0-9_.:\-]+", binding):
            continue
        p = dict(props)
        if p.get("fontSize") and re.fullmatch(r"\d+(\.\d+)?", str(p["fontSize"])):
            p["fontSize"] = f"{p['fontSize']}px"
        d = _decl(p, el_allowed)
        parts = [x for x in d.split(";") if x]
        if p.get("fontFamily") in FONTS:
            parts.append(f"font-family:{FONTS[p['fontFamily']]}")
        if parts:
            rules.append(f'[data-sid="{binding}"]{{' + ";".join(x + " !important" for x in parts) + "}")
    return "\n".join(r for r in rules if r) + "\n"


# ------------------------------------------------------- fragment rendering
def make_env():
    """A Jinja environment just capable enough to render widget blocks (used by
    the admin server for live previews; the real build uses build.py's env)."""
    from jinja2 import Environment, FileSystemLoader
    env = Environment(loader=FileSystemLoader(Path(__file__).resolve().parent / "templates"),
                      trim_blocks=True, lstrip_blocks=True, autoescape=True, finalize=finalize)
    env.globals["cms"] = lambda *a, **k: ""
    env.globals["edit_mode"] = False
    env.globals["asset_v"] = "0"
    return env


# ------------------------------------------------------------- rich text
# Any editable text may carry formatting. Formatted values are stored as
# "<!--rt-->" + HTML; the Jinja `finalize` hook turns them into sanitised,
# unescaped HTML wherever they are printed, so no template needs to change.
RT = "<!--rt-->"
_ALLOWED = {"p", "br", "b", "strong", "i", "em", "u", "a", "ul", "ol", "li", "h2", "h3", "h4", "span", "blockquote"}
_VOID_OUT = {"br"}


def sanitize_html(raw: str) -> str:
    from html.parser import HTMLParser

    out: list[str] = []
    open_stack: list[str] = []

    class P(HTMLParser):
        def handle_starttag(self, tag, attrs):
            if tag == "div":
                tag = "p"
            if tag not in _ALLOWED:
                return
            a = dict(attrs)
            extra = ""
            if tag == "a":
                href = (a.get("href") or "").strip()
                if not re.match(r"^(https?://|mailto:|tel:|/|#|[A-Za-z0-9_./-]+$)", href):
                    return
                ext = href.startswith("http")
                extra = f' href="{_html.escape(href, quote=True)}"' + (' target="_blank" rel="noopener"' if ext else "")
            elif tag == "span":
                st = a.get("style") or ""
                m = re.search(r"color:\s*(#[0-9a-fA-F]{3,8}|rgb\([\d\s,]+\))", st)
                if not m:
                    return
                extra = f' style="color:{m.group(1)}"'
            out.append(f"<{tag}{extra}>")
            if tag not in _VOID_OUT:
                open_stack.append(tag)

        def handle_startendtag(self, tag, attrs):
            if tag == "br":
                out.append("<br>")

        def handle_endtag(self, tag):
            if tag == "div":
                tag = "p"
            if tag in _ALLOWED and tag not in _VOID_OUT and tag in open_stack:
                while open_stack:
                    t = open_stack.pop()
                    out.append(f"</{t}>")
                    if t == tag:
                        break

        def handle_data(self, data):
            out.append(_html.escape(data, quote=False))

        def handle_entityref(self, name):
            out.append(f"&{name};")

        def handle_charref(self, name):
            out.append(f"&#{name};")

    P(convert_charrefs=False).feed(raw)
    while open_stack:
        out.append(f"</{open_stack.pop()}>")
    return "".join(out)


def finalize(value):
    """Jinja finalize hook: formatted text prints as sanitised HTML."""
    from markupsafe import Markup
    # Also catches values a template already passed through `| safe`.
    if isinstance(value, str) and value.startswith(RT):
        return Markup(sanitize_html(value[len(RT):]))
    return value
