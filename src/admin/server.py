#!/usr/bin/env python3
"""Wash4You local content admin.

A single-user, localhost-only editor for the static site. It serves the site
in edit mode (rendered by build.py into dist-edit/) with a click-to-edit
overlay injected, and writes changes straight back to src/data/*.json.

Run:   python3 src/admin/server.py
Then:  open http://127.0.0.1:8765  and log in.

Design notes:
- Bound to 127.0.0.1 only. The login is a convenience gate for a local tool,
  not internet-grade auth — never expose this port to a network.
- Nothing here touches the production dist/ or the live site until you click
  Publish (and, separately, confirm Push).
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ADMIN_DIR = Path(__file__).resolve().parent
SRC_DIR = ADMIN_DIR.parent
REPO = SRC_DIR.parent
BUILD_PY = SRC_DIR / "build.py"
DIST_EDIT = REPO / "dist-edit"
DIST = REPO / "dist"
OVERLAY_DIR = ADMIN_DIR / "overlay"
IMAGES_DIR = SRC_DIR / "assets" / "images"
UPLOADS_SUBDIR = "images/uploads"  # relative to assets/, where swapped images land

sys.path.insert(0, str(ADMIN_DIR))
import paths as content  # noqa: E402  (local module)
sys.path.insert(0, str(SRC_DIR))
import studio  # noqa: E402  (build-side Studio engine)

CONFIG = json.loads((ADMIN_DIR / "config.json").read_text(encoding="utf-8"))
PORT = int(CONFIG.get("port", 8765))

SESSIONS: set[str] = set()

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".xml": "application/xml",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def run_build(edit: bool) -> tuple[bool, str]:
    """Run build.py (edit or production). Returns (ok, output)."""
    env = dict(os.environ)
    if edit:
        env["W4U_EDIT"] = "1"
    else:
        env.pop("W4U_EDIT", None)
    proc = subprocess.run(
        [sys.executable, str(BUILD_PY)],
        cwd=str(REPO), env=env, capture_output=True, text=True,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode == 0, out.strip()


def inject_overlay(html_text: str, username: str, studio_frame: bool = False) -> str:
    """Insert the admin overlay CSS/JS into a served page. The Studio canvas
    (an iframe) gets the quiet frame script instead of the classic toolbar."""
    if studio_frame:
        head = '<link rel="stylesheet" href="/admin/overlay/studio-frame.css">'
        boot = ('<script>window.__W4U_STUDIO__=true;</script>'
                '<script src="/admin/overlay/studio-frame.js" defer></script>')
    else:
        head = '<link rel="stylesheet" href="/admin/overlay/admin.css">'
        boot = (
            '<script>window.__W4U_ADMIN__='
            + json.dumps({"user": username})
            + ';</script><script src="/admin/overlay/admin.js" defer></script>'
        )
    if "</head>" in html_text:
        html_text = html_text.replace("</head>", head + "</head>", 1)
    if "</body>" in html_text:
        html_text = html_text.replace("</body>", boot + "</body>", 1)
    else:
        html_text += boot
    return html_text


def safe_under(base: Path, rel: str) -> Path | None:
    """Resolve rel under base, refusing anything that escapes base."""
    target = (base / rel.lstrip("/")).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        return None
    return target


class Handler(BaseHTTPRequestHandler):
    server_version = "Wash4YouAdmin/1.0"

    # -- helpers ---------------------------------------------------------
    def _session_ok(self) -> bool:
        raw = self.headers.get("Cookie")
        if not raw:
            return False
        cookie = SimpleCookie(raw)
        tok = cookie.get("w4u_session")
        return bool(tok and tok.value in SESSIONS)

    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj, extra: dict | None = None):
        self._send(code, json.dumps(obj).encode("utf-8"),
                   "application/json; charset=utf-8", extra)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _read_json(self) -> dict:
        raw = self._read_body()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _redirect(self, location: str):
        self._send(302, b"", "text/plain", {"Location": location})

    def log_message(self, fmt, *args):  # quieter console
        return

    # -- GET -------------------------------------------------------------
    def do_GET(self):
        path = unquote(urlparse(self.path).path)

        if path == "/admin/login":
            return self._send(200, LOGIN_PAGE.encode("utf-8"), CONTENT_TYPES[".html"])
        if path == "/admin/logout":
            self._logout_cookie()
            return
        if path.startswith("/admin/overlay/"):
            return self._serve_overlay(path)
        query = parse_qs(urlparse(self.path).query)
        if path == "/studio":
            if not self._session_ok():
                return self._redirect("/admin/login")
            return self._serve_overlay("/admin/overlay/studio.html")
        if path == "/" and "classic" not in query and "studio" not in query:
            return self._redirect("/studio" if self._session_ok() else "/admin/login")

        if path.startswith("/admin/api/"):
            if not self._session_ok():
                return self._json(401, {"error": "not authenticated"})
            if path == "/admin/api/blog":
                return self._json(200, {"posts": content.load_store("blog").get("posts", [])})
            if path == "/admin/api/studio/pages":
                return self._json(200, {"pages": studio_pages()})
            if path == "/admin/api/studio/state":
                return self._json(200, {
                    "layout": studio.load_layout(), "blocks": studio.load_blocks(),
                    "styles": studio.load_styles(), "types": list(studio.BLOCK_TYPES)})
            if path == "/admin/api/bindings":
                # Not strictly needed by the overlay, but handy for debugging.
                return self._json(200, {"stores": sorted(content.ALLOWED_STORES)})
            return self._json(404, {"error": "unknown endpoint"})

        # Everything else is the site itself — auth required.
        if not self._session_ok():
            return self._redirect("/admin/login")
        return self._serve_site(path)

    def do_HEAD(self):
        self.do_GET()

    def _serve_overlay(self, path: str):
        name = path[len("/admin/overlay/"):]
        target = safe_under(OVERLAY_DIR, name)
        if not target or not target.is_file():
            return self._send(404, b"not found", "text/plain")
        ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        return self._send(200, target.read_bytes(), ctype)

    def _serve_site(self, path: str):
        rel = path
        if rel.endswith("/") or rel == "":
            rel = rel + "index.html"
        target = safe_under(DIST_EDIT, rel)
        if target and target.is_dir():
            target = target / "index.html"
        if not target or not target.is_file():
            # Fall back to the built 404 page.
            nf = DIST_EDIT / "404.html"
            if nf.is_file():
                body = inject_overlay(nf.read_text(encoding="utf-8"), self._user())
                return self._send(404, body.encode("utf-8"), CONTENT_TYPES[".html"])
            return self._send(404, b"not found", "text/plain")

        if target.suffix == ".html":
            frame = "studio" in parse_qs(urlparse(self.path).query)
            body = inject_overlay(target.read_text(encoding="utf-8"), self._user(), frame)
            return self._send(200, body.encode("utf-8"), CONTENT_TYPES[".html"])
        ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        return self._send(200, target.read_bytes(), ctype)

    def _user(self) -> str:
        return CONFIG.get("username", "admin")

    # -- POST ------------------------------------------------------------
    def do_POST(self):
        path = unquote(urlparse(self.path).path)

        if path == "/admin/api/login":
            return self._login()
        if path == "/admin/api/logout":
            self._logout_cookie()
            return

        if not self._session_ok():
            return self._json(401, {"error": "not authenticated"})

        try:
            if path == "/admin/api/save":
                return self._save()
            if path == "/admin/api/upload":
                return self._upload()
            if path == "/admin/api/blog":
                return self._blog()
            if path == "/admin/api/publish":
                return self._publish()
            if path == "/admin/api/studio/save":
                return self._studio_save()
            if path == "/admin/api/studio/render-block":
                return self._studio_render_block()
            if path == "/admin/api/studio/upload":
                return self._studio_upload()
            if path == "/admin/api/studio/bindings":
                return self._studio_bindings()
        except Exception as e:  # surface the real reason to the UI
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})

        return self._json(404, {"error": "unknown endpoint"})

    # -- auth ------------------------------------------------------------
    def _login(self):
        data = self._read_json()
        if (data.get("username") == CONFIG["username"]
                and data.get("password") == CONFIG["password"]):
            token = base64.urlsafe_b64encode(os.urandom(24)).decode("ascii")
            SESSIONS.add(token)
            cookie = f"w4u_session={token}; Path=/; HttpOnly; SameSite=Lax"
            return self._json(200, {"ok": True}, {"Set-Cookie": cookie})
        return self._json(401, {"error": "Wrong username or password."})

    def _logout_cookie(self):
        raw = self.headers.get("Cookie")
        if raw:
            tok = SimpleCookie(raw).get("w4u_session")
            if tok:
                SESSIONS.discard(tok.value)
        expire = "w4u_session=; Path=/; Max-Age=0"
        self._send(302, b"", "text/plain",
                   {"Location": "/admin/login", "Set-Cookie": expire})

    # -- editing ---------------------------------------------------------
    def _save(self):
        data = self._read_json()
        edits = data.get("edits") or []
        if not edits:
            return self._json(400, {"error": "no edits"})
        changed = content.apply_edits(edits)
        ok, out = run_build(edit=True)
        if not ok:
            return self._json(500, {"error": "build failed", "detail": out})
        return self._json(200, {"ok": True, "changed": changed})

    def _upload(self):
        data = self._read_json()
        data_url = data.get("dataUrl", "")
        m = re.match(r"^data:([^;]+);base64,(.*)$", data_url, re.S)
        if not m:
            return self._json(400, {"error": "expected a base64 data URL"})
        raw = base64.b64decode(m.group(2))
        orig = data.get("name") or "upload"
        stem = SAFE_NAME.sub("-", Path(orig).stem).strip("-") or "image"
        suffix = Path(orig).suffix.lower() or ".png"

        binding = data.get("binding")  # kind="image": JSON path holds the src
        fixed_file = data.get("file")  # data-cms-file: overwrite this asset

        if fixed_file:
            target = safe_under(IMAGES_DIR.parent, fixed_file)
            if not target:
                return self._json(400, {"error": "bad file path"})
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            new_path = fixed_file
        elif binding:
            up_dir = IMAGES_DIR / "uploads"
            up_dir.mkdir(parents=True, exist_ok=True)
            # A stable-but-unique name from the content itself (no clock needed).
            digest = base64.urlsafe_b64encode(raw).decode()[:8].replace("-", "").replace("_", "")
            fname = f"{stem}-{digest}{suffix}"
            (up_dir / fname).write_bytes(raw)
            new_path = f"{UPLOADS_SUBDIR}/{fname}"
            content.set_binding(binding, new_path)
        else:
            return self._json(400, {"error": "no binding or file target"})

        ok, out = run_build(edit=True)
        if not ok:
            return self._json(500, {"error": "build failed", "detail": out})
        return self._json(200, {"ok": True, "path": new_path})

    def _blog(self):
        data = self._read_json()
        action = data.get("action")
        blog = content.load_store("blog")
        posts = blog.setdefault("posts", [])

        if action == "create":
            posts.insert(0, data.get("post") or {})
        elif action == "update":
            idx = int(data.get("index"))
            posts[idx] = data.get("post") or {}
        elif action == "delete":
            idx = int(data.get("index"))
            posts.pop(idx)
        elif action == "reorder":
            order = data.get("order") or []
            posts[:] = [posts[i] for i in order]
        else:
            return self._json(400, {"error": f"unknown blog action {action!r}"})

        content.save_store("blog", blog)
        ok, out = run_build(edit=True)
        if not ok:
            return self._json(500, {"error": "build failed", "detail": out})
        return self._json(200, {"ok": True, "posts": posts})

    # -- studio ----------------------------------------------------------
    def _studio_save(self):
        data = self._read_json()
        changed = {}
        if data.get("edits"):
            changed = content.apply_edits(data["edits"])
        for key, path in (("layout", studio.LAYOUT_FILE), ("blocks", studio.BLOCKS_FILE), ("styles", studio.STYLES_FILE)):
            doc = data.get(key)
            if isinstance(doc, dict):
                path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        ok, out = run_build(edit=True)
        if not ok:
            return self._json(500, {"error": "build failed", "detail": out})
        return self._json(200, {"ok": True, "changed": changed})

    def _studio_render_block(self):
        data = self._read_json()
        block = {"id": data.get("id") or "blk-preview", "type": data.get("type"), "props": data.get("props") or {}}
        if block["type"] not in studio.BLOCK_TYPES:
            return self._json(400, {"error": "unknown block type"})
        html_text = studio.render_block(studio.make_env(), block, "/", "/")
        return self._json(200, {"html": html_text})

    def _studio_upload(self):
        data = self._read_json()
        m = re.match(r"^data:([^;]+);base64,(.*)$", data.get("dataUrl", ""), re.S)
        if not m:
            return self._json(400, {"error": "expected a base64 data URL"})
        raw = base64.b64decode(m.group(2))
        orig = data.get("name") or "upload"
        stem = SAFE_NAME.sub("-", Path(orig).stem).strip("-") or "image"
        suffix = Path(orig).suffix.lower() or ".png"
        if suffix not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"):
            return self._json(400, {"error": "only image files can be uploaded"})
        digest = base64.urlsafe_b64encode(raw).decode()[:8].replace("-", "").replace("_", "")
        fname = f"{stem}-{digest}{suffix}"
        rel = f"{UPLOADS_SUBDIR}/{fname}"
        for base in (IMAGES_DIR / "uploads", DIST_EDIT / "images" / "uploads", DIST_EDIT / "assets" / "images" / "uploads"):
            base.mkdir(parents=True, exist_ok=True)
            (base / fname).write_bytes(raw)
        return self._json(200, {"ok": True, "path": rel})

    def _studio_bindings(self):
        data = self._read_json()
        out = {}
        for b in data.get("bindings") or []:
            try:
                out[b] = content.get_binding(b)
            except Exception:
                out[b] = None
        return self._json(200, {"values": out})

    # -- publish ---------------------------------------------------------
    def _publish(self):
        data = self._read_json()
        do_commit = bool(data.get("commit", True))
        do_push = bool(data.get("push", False))
        message = (data.get("message") or "Update site content via admin").strip()

        ok, out = run_build(edit=False)  # production build -> dist/
        if not ok:
            return self._json(500, {"error": "production build failed", "detail": out})

        synced = sync_dist_to_root()
        steps = [f"Built production site ({synced} items synced to deploy root)."]

        if do_commit:
            git = git_commit(message)
            steps.append(git["message"])
            if not git["ok"]:
                return self._json(200, {"ok": False, "steps": steps, "detail": git.get("detail", "")})
            if do_push:
                pushed = git_push()
                steps.append(pushed["message"])
                return self._json(200, {"ok": pushed["ok"], "steps": steps, "detail": pushed.get("detail", "")})
        return self._json(200, {"ok": True, "steps": steps})


def studio_pages() -> list[dict]:
    """Every built page (from the edit build's sitemap), grouped for the picker."""
    sm = DIST_EDIT / "sitemap.xml"
    paths = []
    if sm.is_file():
        for loc in re.findall(r"<loc>([^<]+)</loc>", sm.read_text(encoding="utf-8")):
            p = urlparse(loc).path or "/"
            paths.append(p)
    main = ["/", "/services/", "/pricing/", "/packages/", "/about-us/", "/locate-us/", "/contact-us/",
            "/blog/", "/steam-iron/", "/wash4you-overview/", "/best-dryclean-in-gurgaon/"]
    out = []
    for p in paths:
        if p in main:
            group = "Main pages"
        elif p.startswith("/products/"):
            group = "Products"
        elif p.startswith("/services/"):
            group = "Services"
        elif p.startswith("/blog/"):
            group = "Blog"
        elif p.startswith("/laundry-service-"):
            group = "Area pages"
        else:
            group = "Other"
        out.append({"path": p, "group": group})
    order = {"Main pages": 0, "Services": 1, "Products": 2, "Blog": 3, "Area pages": 4, "Other": 5}
    out.sort(key=lambda x: (order.get(x["group"], 9), main.index(x["path"]) if x["path"] in main else 999, x["path"]))
    return out


# -- publish helpers -----------------------------------------------------
# Items in dist/ that mirror onto the served repo root.
def sync_dist_to_root() -> int:
    count = 0
    for item in DIST.iterdir():
        dest = REPO / item.name
        if item.is_dir():
            shutil.copytree(item, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(item, dest)
        count += 1
    return count


def _git(*args) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(REPO),
                          capture_output=True, text=True)


def git_commit(message: str) -> dict:
    _git("add", "-A")
    status = _git("status", "--porcelain")
    if not status.stdout.strip():
        return {"ok": True, "message": "Nothing to commit — working tree already clean."}
    res = _git("commit", "-m", message)
    if res.returncode != 0:
        return {"ok": False, "message": "git commit failed.", "detail": res.stdout + res.stderr}
    return {"ok": True, "message": f"Committed: {message}"}


def git_push() -> dict:
    res = _git("push")
    if res.returncode != 0:
        return {"ok": False, "message": "git push failed.", "detail": res.stdout + res.stderr}
    return {"ok": True, "message": "Pushed to the live site."}


LOGIN_PAGE = """<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Wash4You Editor — Sign in</title>
<link rel=preconnect href="https://fonts.googleapis.com">
<link rel=preconnect href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;700;800&family=Hanken+Grotesk:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel=stylesheet>
<style>
:root{
  --ink:#0C2340; --linen:#F5F8F6; --linen2:#fff; --steam:#D5E3DF;
  --fresh:#0FB5A5; --fresh-d:#0A8b7f; --slate:#5E7086; --brick:#C4442E;
  --sans:'Hanken Grotesk',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  --disp:'Bricolage Grotesque','Hanken Grotesk',system-ui,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
  font-family:var(--sans);color:var(--ink);
  background:
    radial-gradient(120% 80% at 50% -10%, #17386a 0%, transparent 55%),
    var(--ink);}
/* faint woven-label texture behind the ticket */
body::before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.06;
  background-image:repeating-linear-gradient(90deg,#fff 0 1px,transparent 1px 9px),
                   repeating-linear-gradient(0deg,#fff 0 1px,transparent 1px 9px);}
.ticket{position:relative;z-index:1;background:var(--linen);width:min(384px,92vw);
  border-radius:16px;box-shadow:0 30px 70px -24px rgba(0,0,0,.6);
  padding:30px 30px 30px;animation:rise .5s cubic-bezier(.2,.7,.2,1) both;}
/* perforated tear-edge along the very top */
.ticket::before{content:"";position:absolute;top:-6px;left:14px;right:14px;height:12px;
  background:radial-gradient(circle at 6px 6px, var(--ink) 0 3px, transparent 3.5px);
  background-size:14px 12px;background-repeat:repeat-x;opacity:.9;}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.mark{display:flex;align-items:center;gap:10px}
.mark span{font-family:var(--disp);font-weight:800;font-size:20px;letter-spacing:.01em}
.tag{font-family:var(--mono);font-size:10px;letter-spacing:.24em;text-transform:uppercase;
  color:var(--slate);padding-left:11px;margin-left:2px;position:relative}
.tag::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);
  width:1px;height:15px;background:var(--steam)}
.care{margin:16px 0 22px;font-family:var(--mono);font-size:10px;letter-spacing:.18em;
  text-transform:uppercase;color:var(--slate);border-top:1.5px dashed var(--steam);
  border-bottom:1.5px dashed var(--steam);padding:9px 0;text-align:center}
label{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--slate);margin:15px 0 6px}
input{width:100%;padding:11px 12px;border:1px solid var(--steam);border-radius:9px;
  font:inherit;font-size:15px;background:var(--linen2);color:var(--ink)}
input:focus{outline:none;border-color:var(--fresh);box-shadow:0 0 0 3px rgba(15,181,165,.16)}
button{margin-top:24px;width:100%;padding:12px;border:0;border-radius:10px;
  background:var(--fresh);color:#04302B;font-family:var(--sans);font-size:15px;
  font-weight:700;cursor:pointer;transition:background .14s}
button:hover{background:var(--fresh-d)}
button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.err{color:var(--brick);font-family:var(--mono);font-size:11px;letter-spacing:.03em;
  margin-top:14px;min-height:16px}
@media (prefers-reduced-motion:reduce){.ticket{animation:none}}
</style></head><body>
<form class=ticket onsubmit="return signin(event)">
  <div class=mark>
    <svg width=26 height=26 viewBox="0 0 24 24" aria-hidden=true>
      <rect x=4 y=5 width=16 height=14 rx=2.6 fill="#0FB5A5"/>
      <circle cx=8 cy=9 r=1.15 fill="#0C2340"/>
      <rect x=11 y=8.2 width=6 height=1.6 rx=.8 fill="#0C2340" opacity=.55/>
      <rect x=7 y=13 width=10 height=1.6 rx=.8 fill="#0C2340" opacity=.32/>
      <rect x=7 y=15.6 width=7 height=1.6 rx=.8 fill="#0C2340" opacity=.32/>
    </svg>
    <span>Wash4You</span><span class=tag>Editor</span>
  </div>
  <p class=care>Gentle cycle · No bleach · Cool iron</p>
  <label for=u>Username</label>
  <input id=u autocomplete=username autofocus>
  <label for=p>Password</label>
  <input id=p type=password autocomplete=current-password>
  <button type=submit>Sign in</button>
  <div class=err id=err></div>
</form>
<script>
async function signin(e){
  e.preventDefault();
  const err=document.getElementById('err');err.textContent='';
  const r=await fetch('/admin/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username:u.value,password:p.value})});
  if(r.ok){location.href='/';}else{const d=await r.json().catch(()=>({}));err.textContent=d.error||'Sign in failed.';}
  return false;
}
</script></body></html>"""


def main():
    print("Wash4You admin — building editable site (dist-edit/) ...")
    ok, out = run_build(edit=True)
    if not ok:
        print("Initial edit build FAILED:\n" + out, file=sys.stderr)
        sys.exit(1)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"\n  Wash4You admin running:  http://127.0.0.1:{PORT}")
    print(f"  Login: {CONFIG['username']} / (password in src/admin/config.json)")
    print("  Ctrl+C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
