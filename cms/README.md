# Wash4You hosted admin (`cms/`)

A secure, online visual editor for the Wash4You website. It runs as a **Node.js app on
Hostinger Business Web Hosting** (which supports Node.js apps, SSH and MySQL; Python is *not*
available on that plan), keeps accounts and drafts in **MySQL**, and publishes by committing
to the **`wash4you2` GitHub repository**. **GitHub Actions** (free) rebuilds the static site.

```
 You (browser) ──► Admin app (Node + MySQL, Hostinger)
                      │  drafts, revisions, users, media metadata  → MySQL
                      │  Publish = ONE atomic commit to GitHub (src/data/*.json, images)
                      ▼
                  GitHub: wash4you2 / main
                      │  workflow "Publish site (admin)"
                      ├─► python build → copies the built site to the repo root ─► Hostinger deploys main
                      └─► editable build → branch `cms-edit` ─► the admin downloads it for the editor canvas
```

The existing local tool (`python3 src/admin/server.py`) still works and is unchanged.

## What you can do

| Area | What it does |
|---|---|
| **Visual editor** (`/studio`) | The real page in the middle. Click text to edit, click an image to replace it, drag widgets in, reorder / hide / duplicate / delete sections, set backgrounds, colours, spacing, per-device visibility, desktop/tablet/mobile preview, undo/redo, autosave (15 s), unsaved-changes warning. |
| **Blog posts** | Write, edit, hide, delete and publish articles: title, web address, date, topic, summary, search description, cover image, and a Markdown editor (toolbar for headings, bold, links, lists, quotes, library images) with a live preview. Each post is one file, `content/posts/<slug>.md`. Save draft keeps it private; **Publish** commits just that post (and any new images it uses). |
| **Drafts** | *Save draft* stores your work in the database. The live site does **not** change. Reopening a page shows your latest draft. |
| **Publish** | Commits every draft in one step. The site rebuilds and goes live in a few minutes. |
| **Revisions** | Every publish (and draft saves) is kept. *Restore* puts a version back as a draft; nothing goes live until you publish. |
| **Media library** | Upload (content-checked PNG/JPG/WebP/GIF/SVG, max 8 MB), search, alt text, replace, "where is this used?", delete (blocked while the image is still used). |
| **SEO** | Per page: meta title, description, canonical, social image, noindex. Applied by the site build; unset fields keep the built-in value. |
| **Header, footer & menus** | Edit the header menu, header button, and the three footer link lists. |
| **Account & users** | Change password, add/remove administrators. Audit log on the Overview page. |

## Security model

* Passwords: scrypt with a per-user salt. Sessions: random 256-bit token (only its SHA-256 is stored), `HttpOnly`, `SameSite=Strict`, `Secure` in production, 12 h expiry.
* Every write needs the session's **CSRF token** *and* a same-origin `Origin` header.
* Login lockout: 5 failures per 15 minutes per IP and per username. Constant-time comparison; unknown users cost the same time as known ones.
* Every `/admin/api` route requires a session (tested). The site canvas and dashboard redirect to login.
* All JSON is validated on the server: widget types, section ids, link schemes (no `javascript:`), CSS values (charset allow-list, same as the build), rich text and "Custom HTML" are sanitised (no `<script>`, handlers, or foreign iframes).
* The repository adapter can only write `src/data/**/*.json`, `src/assets/images/**` and `content/posts/<slug>.md`. It cannot touch code, workflows or `.env`.
* Blog posts: the web address is validated (lowercase letters, numbers, hyphens), cannot be a reserved or already-used page, and is locked once created. Article text is Markdown that the site build HTML-escapes; links may only be `https://` or site-relative, images only from the media library or `https://`. The editor preview is rendered server-side, escaped and sanitised again.
* Secrets only come from environment variables; nothing sensitive is in the repository.

## One-time setup on Hostinger

1. **MySQL**: hPanel → Databases → create a database + user. Note the name, user, password (host is `localhost`).
2. **GitHub token**: GitHub → Settings → Developer settings → *Fine-grained tokens* → repository **`wash4you2` only** → permissions **Contents: Read and write**. Copy it.
3. **Node.js app**: hPanel → Websites → *Add website* → **Node.js Apps** (Business plan and above). Import the `wash4you2` repo (or upload `cms/`), then set:
   * Application root: `cms`  ·  Entry file: `src/server.js`  ·  Node version: 20 or 22
   * Use a **sub-domain** such as `admin.wash4you.in` (keep the public site on the main domain).
   * Environment variables (see `.env.example`): `NODE_ENV=production`, `DB_DRIVER=mysql`, `DB_HOST=localhost`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `REPO_DRIVER=github`, `GITHUB_TOKEN`, `PUBLIC_SITE_URL=https://wash4you.in`.
4. Install and create your account (hPanel terminal or SSH, inside `cms/`):
   ```bash
   npm install --omit=dev
   npm run migrate
   ADMIN_USER=yourname ADMIN_PASSWORD='a long passphrase 123' npm run create-admin
   ```
5. In GitHub run the workflow **Actions → Publish site (admin) → Run workflow** once. It creates the `cms-edit` branch the editor needs.
6. Start the app, open `https://admin.wash4you.in`, sign in, then **Drafts & publishing → Refresh editor build**.

> Not yet verified on Hostinger: the MySQL path and the GitHub API path were written to the
> documented behaviour but could only be tested here with SQLite and a local folder (see Tests).
> Do step 6 first on a test edit (e.g. change a heading) before relying on it.

## Day to day

**Blog:** `/admin` → **Blog posts** → *New post* → write → *Save draft* → *Publish post*. See `CLIENT-GUIDE.md`.

1. `/admin` → **Pages & editor** → pick a page → edit → **Save draft** (also autosaves).
2. **Publish**. Wait a few minutes for the rebuild, then **Refresh editor build** to see it in the editor.
3. Something wrong? **Revisions → Restore → Publish**.

## Development

```bash
cd cms && npm install
DB_DRIVER=sqlite REPO_DRIVER=local NODE_ENV=development PORT=3111 \
  ADMIN_USER=admin ADMIN_PASSWORD='Some-long-pass-1' node src/create-admin.js
DB_DRIVER=sqlite REPO_DRIVER=local NODE_ENV=development PORT=3111 node src/server.js
npm test          # 47 tests: auth, CSRF, authorization, validation, sanitising, publish, revisions, media, SEO, blog posts
```

With `REPO_DRIVER=local` the app edits the checkout in `LOCAL_REPO_DIR` (default: the repo) and serves
`dist-edit/` as the canvas (`W4U_EDIT=1 python3 src/build.py`). Point `LOCAL_REPO_DIR` at a **copy** to experiment safely.

## Known limits

* Publishing is not instant: the rebuild takes a few minutes. Text, images and styling show instantly in the editor; **new/moved sections** also show instantly but only on the page you are editing.
* The editor canvas is the *last published build* with your saved drafts laid over it, not a full rebuild.
* Removing a style override that was already published still shows the published style in the canvas until the rebuild.
* Redirect management is not included (static hosting cannot do 301s safely).
* Blog: a post's web address cannot be changed after it exists (that would break its links). There is no scheduling: *Publish* goes live at the next rebuild. A malformed or conflicting post file is skipped by the build (with a warning in the Actions log) rather than failing the whole site.
* The post list reads each article from GitHub (cached by file hash), so the first load after a restart is a little slower.
