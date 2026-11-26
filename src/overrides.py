"""Click-to-edit for EXISTING page content (text and images), without touching any template.

Only part of the site's text is wired to a data field (`cms('home:hero.title')` in the templates).
The rest, such as the stats strip, FAQ questions, the hero image tiles and most card text, used to be
impossible to change from the Studio. This module closes that gap generically:

* It scans the rendered HTML of a page and finds every editable item: a text-only element, a loose
  run of text next to an icon, or an <img>.
* Each item gets a stable key built from the page, what it is and its text/src (plus an occurrence
  number for repeats): the same on every build, so no template needs an id.
* EDIT build (W4U_EDIT): each item that is not already bound gets data-cms="overrides:t.<page>.<key>"
  (or ...i... for images), which is all the Studio canvas needs to make it editable.
* Every build: if data/overrides.json has a value for an item's key, the new text / image replaces
  the original. Nothing else on the page changes; with no overrides the output is byte-identical.

`scan()` must give the same keys in the edit build and in the production build; keys therefore depend
only on tag names and visible text, never on attributes such as data-cms.
"""

from __future__ import annotations

import hashlib
import html as _html
import json
import re
from pathlib import Path

DATA_FILE = Path(__file__).resolve().parent / "data" / "overrides.json"

# Tags that may sit inside an editable text element: exactly the ones the rich-text sanitiser keeps
# (see studio.sanitize_html). Anything else, e.g. a <span> wrapper, would be stripped on save and lose its
# styling, so an element containing one is split into separately editable pieces instead.
INLINE = {"a", "strong", "em", "b", "i", "u", "br", "wbr"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
# Never editable, and they make their parent "not text-only".
SKIP = {"script", "style", "noscript", "svg", "template", "textarea", "select", "option", "title", "head",
        "iframe", "canvas", "video", "audio", "object", "form", "input"}
TAG = re.compile(r"<!--.*?-->|<(/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\"[^\"]*\"|'[^']*'|[^>\"'])*)>", re.S)
MIN_ALNUM = 2


def load() -> dict:
    try:
        d = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        d = {}
    d.setdefault("t", {})
    d.setdefault("i", {})
    return d


def scope_key(rel_path: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", rel_path.lower()).strip("-") or "home"


def _plain(fragment: str) -> str:
    return re.sub(r"\s+", " ", _html.unescape(re.sub(r"<[^>]*>", "", fragment))).strip()


_PLAIN_ATTRS = re.compile(r"""\s(?:href|target|rel|title|data-cms|data-cms-kind|data-sid)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?""")


def _styled(attrs: str) -> bool:
    """True if an inline tag carries attributes the rich-text editor would strip (class, style, id...)."""
    return bool(_PLAIN_ATTRS.sub("", " " + attrs.strip().rstrip("/")).strip())


def _alnum(s: str) -> int:
    return len(re.findall(r"[^\W_]", s))


def _key(scope: str, region: str, kind: str, text: str, n: int) -> str:
    return hashlib.sha1(f"{scope}|{region}|{kind}|{text}|{n}".encode("utf-8")).hexdigest()[:10]


class _Frame:
    __slots__ = ("name", "open_start", "open_end", "attrs", "skip", "block", "cands", "runs", "last")

    def __init__(self, name, open_start, open_end, attrs, skip):
        self.name, self.open_start, self.open_end, self.attrs = name, open_start, open_end, attrs
        self.skip = skip
        self.block = False      # contains something that is not inline text
        self.cands = []         # editable targets found at or below this element
        self.runs = []          # direct text runs (start, end)
        self.last = open_end    # end of the previous token, to find text between tags


def scan(html: str, start: int, end: int):
    """Editable targets inside html[start:end], in document order.

    Each target is a dict: kind 'el' (inner = [s, e) of a text-only element),
    'run' (a loose text run [s, e)), or 'img' (the <img> tag [s, e)). 'text' / 'src' hold the original.
    """
    root = _Frame("#root", start, start, "", False)
    stack = [root]
    for m in TAG.finditer(html, start, end):
        top = stack[-1]
        gap = (top.last, m.start())
        if gap[1] > gap[0] and html[gap[0]:gap[1]].strip():
            top.runs.append(gap)
        raw = m.group(0)
        if raw.startswith("<!--"):
            top.last = m.end()
            continue
        closing, name, attrs = m.group(1) == "/", m.group(2).lower(), m.group(3)
        if not closing:
            selfclose = name in VOID or attrs.rstrip().endswith("/")
            skip = top.skip or name in SKIP or ' data-block="' in attrs
            if name == "img":
                src = re.search(r"""\ssrc\s*=\s*("([^"]*)"|'([^']*)')""", attrs)
                val = (src.group(2) or src.group(3) or "") if src else ""
                if not top.skip and val and not val.startswith(("data:", "http:", "https:", "//")):
                    top.cands.append({"kind": "img", "s": m.start(), "e": m.end(), "text": val})
                top.block = True
            elif selfclose:
                if name not in INLINE:
                    top.block = True
            else:
                if name not in INLINE or name in SKIP or _styled(attrs):
                    top.block = True
                stack.append(_Frame(name, m.start(), m.end(), attrs, skip))
            top.last = m.end()
            continue
        # closing tag: find the frame it closes (tolerate unclosed <p>/<li>)
        idx = next((i for i in range(len(stack) - 1, 0, -1) if stack[i].name == name), None)
        if idx is None:
            top.last = m.end()
            continue
        while len(stack) - 1 > idx:             # implicitly closed children
            _close(stack, m.start(), html)
        fr = stack[-1]
        gap = (fr.last, m.start())
        if gap[1] > gap[0] and html[gap[0]:gap[1]].strip():
            fr.runs.append(gap)
        _close(stack, m.start(), html)
        stack[-1].last = m.end()
    while len(stack) > 1:                      # tolerate elements left open at the end of the region
        fr = stack[-1]
        gap = (fr.last, end)
        if gap[1] > gap[0] and html[gap[0]:gap[1]].strip():
            fr.runs.append(gap)
        _close(stack, end, html)
    gap = (root.last, end)
    if gap[1] > gap[0] and html[gap[0]:gap[1]].strip():
        root.runs.append(gap)
    return root.cands


def _close(stack, close_start, html):
    fr = stack.pop()
    parent = stack[-1]
    clean = not fr.block and not fr.skip
    inner = html[fr.open_end:close_start]
    eligible = clean and _alnum(_plain(inner)) >= MIN_ALNUM
    if eligible:
        cands = [{"kind": "el", "s": fr.open_end, "e": close_start, "text": _plain(inner), "tag": fr.name,
                  "open": (fr.open_start, fr.open_end), "has_tags": "<" in inner}]
    else:
        cands = list(fr.cands)
        if not fr.skip and fr.runs and (fr.block or not clean):
            for s, e in fr.runs:
                seg = html[s:e]
                lead = len(seg) - len(seg.lstrip())
                trail = len(seg) - len(seg.rstrip())
                text = _plain(seg)
                if _alnum(text) >= MIN_ALNUM:
                    cands.append({"kind": "run", "s": s + lead, "e": e - trail, "text": text})
        cands.sort(key=lambda c: c["s"])
    parent.cands.extend(cands if not fr.skip else [])
    if not clean or fr.name not in INLINE:
        parent.block = True


_RAWTEXT = re.compile(r"(<(script|style)\b[^>]*>)(.*?)(</\2\s*>)", re.S | re.I)


def _blank_rawtext(html: str) -> str:
    """Same length, with <script>/<style> bodies blanked, so code like `a<b` is never read as a tag."""
    return _RAWTEXT.sub(lambda m: m.group(1) + " " * len(m.group(3)) + m.group(4), html)


def _items(html: str, a: int, b: int, scope: str, region: str):
    seen: dict[tuple, int] = {}
    out = []
    for c in scan(_blank_rawtext(html), a, b):
        kind = {"el": "t", "run": "t", "img": "i"}[c["kind"]]
        ident = (kind, c["text"])
        n = seen.get(ident, 0)
        seen[ident] = n + 1
        c["key"] = _key(scope, region, kind, c["text"], n)
        c["store"] = kind
        out.append(c)
    return out


def _regions(html: str):
    """(start, end, region name) for the body parts, with <main> on its own (page scope) and the
    header / footer around it sharing one site-wide scope."""
    bm = re.search(r"<body\b[^>]*>", html)
    if not bm:
        return []
    be = html.rfind("</body>")
    if be < 0:
        be = len(html)
    mm = re.search(r"<main\b[^>]*>", html[bm.end():be])
    if not mm:
        return [(bm.end(), be, "page")]
    ms = bm.end() + mm.end()
    me = html.find("</main>", ms)
    if me < 0:
        return [(bm.end(), be, "page")]
    return [(bm.end(), bm.end() + mm.start(), "head"), (ms, me, "page"), (me + len("</main>"), be, "foot")]


SAFE_IMG = re.compile(r"images/[A-Za-z0-9_\-./]+")


def process(html: str, rel_path: str, edit: bool, ovr: dict | None = None, styled: set | None = None,
            sanitize=None) -> str:
    """Apply stored overrides and (in the edit build) tag every unbound item for the Studio."""
    ovr = ovr if ovr is not None else load()
    styled = styled or set()
    page = scope_key(rel_path)
    has_any = any(ovr["t"].get(s) or ovr["i"].get(s) for s in (page, "all"))
    if not edit and not has_any and not styled:
        return html
    edits = []   # (start, end, replacement) applied back to front
    for a, b, region in _regions(html):
        scope = page if region == "page" else "all"
        for c in _items(html, a, b, scope, region):
            store, key = c["store"], c["key"]
            binding = f"overrides:{store}.{scope}.{key}"
            new = ovr[store].get(scope, {}).get(key)
            if c["kind"] == "img":
                tag = html[c["s"]:c["e"]]
                rel = None
                if isinstance(new, str) and SAFE_IMG.fullmatch(new) and ".." not in new:
                    # keep the page's own prefix (assets/, ../assets/, ...): everything before "images/"
                    pm = re.match(r"(.*?)images/", c["text"])
                    rel = pm.group(1) if pm else None
                if rel is not None and isinstance(new, str) and SAFE_IMG.fullmatch(new) and ".." not in new:
                    tag = re.sub(r"""(\ssrc\s*=\s*)("[^"]*"|'[^']*')""", lambda m: f'{m.group(1)}"{rel}{new}"', tag, count=1)
                    tag = re.sub(r"""\s(?:srcset|sizes)\s*=\s*("[^"]*"|'[^']*')""", "", tag)
                extra = ""
                if edit and "data-cms=" not in tag:
                    extra += f' data-cms="{binding}" data-cms-kind="image"'
                if binding in styled and "data-sid=" not in tag:
                    extra += f' data-sid="{binding}"'
                if extra:
                    tag = re.sub(r"^<img", "<img" + extra.replace("\\", "\\\\"), tag, count=1)
                if tag != html[c["s"]:c["e"]]:
                    edits.append((c["s"], c["e"], tag))
                continue
            # text
            new_inner = None
            if isinstance(new, str) and new != "" and c.get("has_tags") and not new.startswith("<!--rt-->"):
                new = "<!--rt-->" + new        # an element that already holds markup is edited as HTML
            if isinstance(new, str) and new != "":
                if new.startswith("<!--rt-->") and sanitize:
                    new_inner = sanitize(new)
                elif new.startswith("<!--rt-->"):
                    new_inner = _html.escape(new[len("<!--rt-->"):], quote=False)
                else:
                    new_inner = _html.escape(new, quote=False).replace("\n", "<br>")
            kind_attr = "rich" if c.get("has_tags") or (isinstance(new, str) and new.startswith("<!--rt-->")) else "text"
            attrs = ""
            if edit:
                attrs += f' data-cms="{binding}" data-cms-kind="{kind_attr}"'
            if binding in styled:
                attrs += f' data-sid="{binding}"'
            if c["kind"] == "el":
                o0, o1 = c["open"]
                opening = html[o0:o1]
                already = "data-cms=" in opening
                if attrs and not already:
                    opening2 = re.sub(r"^<([a-zA-Z0-9-]+)", lambda m: "<" + m.group(1) + attrs.replace("\\", "\\\\"), opening, count=1)
                    edits.append((o0, o1, opening2))
                if new_inner is not None:
                    edits.append((c["s"], c["e"], new_inner))
            else:  # loose text run
                if new_inner is None and not attrs:
                    continue
                body = new_inner if new_inner is not None else html[c["s"]:c["e"]]
                edits.append((c["s"], c["e"], f"<span{attrs}>{body}</span>" if attrs else body))
    for s, e, r in sorted(edits, key=lambda x: x[0], reverse=True):
        html = html[:s] + r + html[e:]
    return html
