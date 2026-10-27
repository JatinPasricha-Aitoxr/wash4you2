'use strict';
// Blog posts. One Markdown file per article in the repository
// (content/posts/<slug>.md: YAML front matter, then the article body), which
// the site build turns into /<slug>/ pages. Edits are staged as drafts in the
// database like every other content change, and published as one commit.
//
// The Markdown renderer here is a port of render_post_markdown() in
// src/build.py and is used for the editor's live preview only; the live pages
// are always rendered by the build. test/posts.test.js checks the two agree.
// `yaml` reads hand-written front matter of any style. If the package is missing (an
// update deployed without `npm install`), fall back to a small reader that understands
// the format this admin itself writes - so the admin keeps running instead of crashing.
let yaml = null;
try { yaml = require('yaml'); } catch { /* use parseLite */ }
const sanitizeHtml = require('sanitize-html');
const db = require('./db');
const config = require('./config');

const POSTS_DIR = 'content/posts/';
const postPath = (slug) => `${POSTS_DIR}${slug}.md`;
const POST_FILE = /^content\/posts\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMG_RE = /^images\/[A-Za-z0-9_\-/.]+\.(?:webp|jpe?g|png|gif|svg)$/i;
const CATEGORY_RE = /^[A-Za-z0-9][A-Za-z0-9 &'\-]*$/;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Addresses a post may never take: site sections, the admin, and the prefixes
// the area/service pages are generated under (those pages always win in the
// build, so a post there would silently never appear).
const RESERVED = new Set(['admin', 'api', 'assets', 'images', 'blog', 'services', 'products', 'pricing', 'packages',
  'about-us', 'contact-us', 'locate-us', 'steam-iron', 'sitemap', 'robots', 'index', '404', 'cms', 'content', 'src',
  'node-modules', 'webapp', 'menu', 'wash4y', 'wash4you-overview', 'studio', 'login', 'logout', 'book-pickup',
  'best-dryclean-near-me', 'best-dryclean-in-gurgaon', 'terms-and-conditions', 'privacy-and-security-policy',
  'refund-and-delivery-policy', 'free-pickup-delivery-policy', 'curtain-cleaning-policy']);
const RESERVED_PREFIX = ['laundry-service-', 'carpet-cleaning-', 'curtains-cleaning-', 'eco-friendly-laundry-',
  'premium-dry-cleaning-', 'shoe-cleaning-', 'sofa-cleaning-', 'steam-ironing-'];

// ------------------------------------------------------------ front matter
// Reads `key: "json value"` lines (what serialize() writes), plus plain `key: value` and
// indented folded continuations. Anything fancier is a parse failure.
function parseLite(src) {
  const meta = {}; let last = null;
  for (const line of String(src).split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m && !/^\s/.test(line)) {
      const raw = m[2].trim(); last = m[1];
      try { meta[last] = JSON.parse(raw); } catch { meta[last] = raw.replace(/^(['"])(.*)\1$/, '$2'); }
    } else if (/^\s+\S/.test(line) && last && typeof meta[last] === 'string') meta[last] += ' ' + line.trim();
    else throw new Error('unsupported front matter');
  }
  return meta;
}
const yamlParse = (src) => (yaml ? yaml.parse(src) : parseLite(src));

function parse(text) {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(String(text || ''));
  if (!m) return { meta: null, body: String(text || '') };
  let meta;
  try { meta = yamlParse(m[1]); } catch { meta = null; }
  if (meta === undefined) meta = {};
  return { meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null, body: m[2] };
}

const KEY_ORDER = ['title', 'date', 'excerpt', 'meta_description', 'category', 'cover_service_slug', 'image', 'author', 'legacy_url', 'status'];
// Every value is written as a JSON string/array/number: valid YAML, and it can
// never be misread (a colon in a title, a leading #, a bare "no"...).
function serialize(meta, body) {
  const keys = [...KEY_ORDER.filter((k) => k in meta), ...Object.keys(meta).filter((k) => !KEY_ORDER.includes(k))];
  const lines = keys.filter((k) => meta[k] !== undefined && meta[k] !== null && meta[k] !== '')
    .map((k) => `${k}: ${JSON.stringify(meta[k])}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body).replace(/\s+$/, '')}\n`;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Accepts 2026-06-25 or "June 25, 2026" (what older posts use); returns ISO or ''.
function isoDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    if (mi >= 0) return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
  }
  return '';
}
const realDate = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso && +iso.slice(0, 4) >= 2000 && +iso.slice(0, 4) <= 2100;
};

// ------------------------------------------------------------- validation
const oneLine = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
function validatePost(b) {
  b = b || {};
  const title = oneLine(b.title);
  if (title.length < 3 || title.length > 140) throw bad('The title must be 3 to 140 characters.');
  const slug = String(b.slug || '').trim();
  if (!SLUG_RE.test(slug) || slug.length < 3 || slug.length > 80) throw bad('The web address can only use lowercase letters, numbers and hyphens (3 to 80 characters).');
  const date = isoDate(b.date);
  if (!realDate(date)) throw bad('Choose a valid publish date.');
  const excerpt = oneLine(b.excerpt);
  if (excerpt.length < 10 || excerpt.length > 300) throw bad('The summary must be 10 to 300 characters. It appears on the blog page and in search results.');
  const meta_description = oneLine(b.meta_description);
  if (meta_description.length > 200) throw bad('The search description can be at most 200 characters.');
  const category = oneLine(b.category) || 'Guides';
  if (category.length < 2 || category.length > 40 || !CATEGORY_RE.test(category)) throw bad('The topic must be 2 to 40 letters, numbers, spaces, & or -.');
  const author = oneLine(b.author);
  if (author.length > 60) throw bad('The author name is too long.');
  const image = String(b.image || '').trim();
  if (image && (!IMG_RE.test(image) || image.includes('..'))) throw bad('The cover image must come from the media library.');
  const status = b.status === 'draft' ? 'draft' : 'published';
  let body = String(b.body == null ? '' : b.body).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (body.trim().length < 20) throw bad('Write the article before saving (at least a few sentences).');
  if (body.length > 60000) throw bad('The article is too long (limit 60,000 characters).');
  return { slug, title, date, excerpt, meta_description, category, author, image, status, body };
}

// --------------------------------------------------------- markdown render
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (v) => v.replace(/"/g, '%22').replace(/'/g, '%27');
const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';

function renderMarkdown(text) {
  const toc = [];
  if (!text) return { html: '', toc, words: 0, readMinutes: 1 };
  const levels = [...text.matchAll(/^(#{1,4})\s/gm)].map((m) => m[1].length);
  const shift = levels.length ? 2 - Math.min(...levels) : 0;
  const used = new Set();
  const link = (_, label, url) => {
    if (url.startsWith('/')) return `<a href="@ROOT@${attr(url.replace(/^\/+/, ''))}">${label}</a>`;
    if (/^https?:\/\//.test(url)) return `<a href="${attr(url)}" target="_blank" rel="noopener">${label}</a>`;
    return label;
  };
  const image = (_, alt0, url) => {
    const alt = alt0.replace(/"/g, '&quot;');
    if (/^images\/[A-Za-z0-9_\-./]+$/.test(url) && !url.includes('..')) return `<img src="@ASSET@${url}" alt="${alt}" loading="lazy">`;
    if (url.startsWith('https://')) return `<img src="${attr(url)}" alt="${alt}" loading="lazy">`;
    return alt;
  };
  const inline = (t) => {
    t = esc(t);
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, image);
    t = t.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, link);
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(?<![\p{L}\p{N}_*])\*([^*\n]+?)\*(?![\p{L}\p{N}_*])/gu, '<em>$1</em>');
    return t;
  };
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) { flushPara(); closeList(); continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); closeList();
      const level = Math.min(Math.max(heading[1].length + shift, 2), 4);
      const label = heading[2].trim();
      const base = slugify(label);
      let hid = base; let n = 2;
      while (used.has(hid)) { hid = `${base}-${n}`; n += 1; }
      used.add(hid);
      if (level === 2) toc.push({ id: hid, text: label.replace(/[*_]/g, '') });
      out.push(`<h${level} id="${hid}">${inline(label)}</h${level}>`);
    } else if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push('<li>' + inline((ul || ol)[1]) + '</li>');
    } else if (line.startsWith('>')) {
      flushPara(); closeList();
      out.push('<blockquote><p>' + inline(line.replace(/^[> ]+/, '').trim()) + '</p></blockquote>');
    } else if (/^(-{3,}|\*{3,})$/.test(line)) {
      flushPara(); closeList();
      out.push('<hr>');
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara(); closeList();
  const words = (text.match(/[\p{L}\p{N}_]+/gu) || []).length;
  return { html: out.join('\n'), toc, words, readMinutes: Math.max(1, Math.ceil(words / 200)) };
}

// Preview HTML for the editor: render, point links/images at the real site /
// admin canvas, then sanitise once more (belt and braces - the renderer
// already escapes everything).
const PREVIEW_OPTS = {
  allowedTags: ['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'blockquote', 'hr', 'img'],
  allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt', 'loading'], h2: ['id'], h3: ['id'], h4: ['id'] },
  allowedSchemes: ['http', 'https'],
  allowProtocolRelative: false,
};
function preview(body) {
  const r = renderMarkdown(String(body || '').replace(/\r\n?/g, '\n'));
  const html = r.html.replace(/@ROOT@/g, config.publicSiteUrl.replace(/\/+$/, '') + '/').replace(/@ASSET@/g, '/');
  return { html: sanitizeHtml(html, PREVIEW_OPTS), toc: r.toc, words: r.words, readMinutes: r.readMinutes };
}

// Called by Content.validateDrafts before anything is published.
function checkDraftFile(path, text) {
  const m = POST_FILE.exec(path);
  if (!m) return;
  const { meta, body } = parse(text);
  if (!meta) throw new Error(`${path} has invalid front matter`);
  validatePost({ ...meta, slug: m[1], date: isoDate(meta.date), body, category: meta.category, status: meta.status === 'draft' ? 'draft' : 'published' });
}

// ------------------------------------------------------------------ store
class Posts {
  constructor(repo, content) { this.repo = repo; this.content = content; this.cache = new Map(); }

  async _files() { return (await this.repo.list(POSTS_DIR)).filter((f) => POST_FILE.test(f.path)); }
  _drafts() { return db.query('SELECT path, kind, updated_at FROM drafts WHERE path LIKE ?', [POSTS_DIR + '%']); }

  // Parsed front matter of a published file, cached by content hash.
  async _repoMeta(f) {
    const key = `${f.path}:${f.sha || f.size}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const buf = await this.repo.read(f.path);
    const { meta, body } = parse(buf ? buf.toString('utf8') : '');
    const val = { meta: meta || {}, words: renderMarkdown(body).words, valid: !!meta };
    this.cache.set(key, val);
    return val;
  }

  _summary(slug, meta, words, state) {
    return {
      slug, title: String(meta.title || slug), category: String(meta.category || 'Guides'), date: isoDate(meta.date),
      status: meta.status === 'draft' ? 'draft' : 'published', state, cover: String(meta.image || ''), words,
      url: `${config.publicSiteUrl.replace(/\/+$/, '')}/${slug}/`,
    };
  }

  async list() {
    const files = await this._files();
    const drafts = new Map((await this._drafts()).map((d) => [d.path, d]));
    const seen = new Set();
    const out = [];
    for (const f of files) {
      seen.add(f.path);
      const slug = POST_FILE.exec(f.path)[1];
      const d = drafts.get(f.path);
      if (d && d.kind === 'del') {
        const r = await this._repoMeta(f);
        out.push({ ...this._summary(slug, r.meta, r.words, 'deleting'), updatedAt: Number(d.updated_at) });
      } else if (d && d.kind === 'text') {
        const { meta, body } = parse(await this.content.getText(f.path));
        out.push({ ...this._summary(slug, meta || {}, renderMarkdown(body).words, 'edited'), updatedAt: Number(d.updated_at) });
      } else {
        const r = await this._repoMeta(f);
        out.push({ ...this._summary(slug, r.meta, r.words, r.valid ? 'live' : 'broken'), updatedAt: null });
      }
    }
    for (const [p, d] of drafts) {
      if (seen.has(p) || d.kind !== 'text') continue;
      const { meta, body } = parse(await this.content.getText(p));
      out.push({ ...this._summary(POST_FILE.exec(p)[1], meta || {}, renderMarkdown(body).words, 'new'), updatedAt: Number(d.updated_at) });
    }
    out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title));
    return out;
  }

  async get(slug) {
    if (!SLUG_RE.test(String(slug))) throw bad('Unknown post.', 404);
    const p = postPath(slug);
    const text = await this.content.getText(p);
    if (text == null) throw bad('That post does not exist.', 404);
    const { meta, body } = parse(text);
    if (!meta) throw bad('This post file has invalid front matter and cannot be opened here. Fix it in the repository.', 422);
    const d = await db.one('SELECT kind FROM drafts WHERE path = ?', [p]);
    const live = !!(await this.repo.read(p));
    return {
      slug, title: String(meta.title || ''), date: isoDate(meta.date), excerpt: String(meta.excerpt || ''),
      meta_description: String(meta.meta_description || ''), category: String(meta.category || 'Guides'), author: String(meta.author || ''),
      image: String(meta.image || ''), status: meta.status === 'draft' ? 'draft' : 'published', body,
      state: d ? (live ? 'edited' : 'new') : 'live', live, url: `${config.publicSiteUrl.replace(/\/+$/, '')}/${slug}/`,
    };
  }

  async categories() {
    const set = new Set(['Care guides', 'Silk care', 'Pricing & services']);
    for (const p of await this.list()) set.add(p.category);
    return [...set].sort();
  }

  async slugProblem(slug) {
    if (!SLUG_RE.test(slug) || slug.length < 3 || slug.length > 80) return 'Use 3 to 80 lowercase letters, numbers and hyphens.';
    if (RESERVED.has(slug) || RESERVED_PREFIX.some((x) => slug.startsWith(x))) return 'That address is reserved for a page of the site. Choose another.';
    const top = await this.repo.topLevel();
    if (top.has(slug)) return 'That address is already used by a page on the site. Choose another.';
    return '';
  }

  async save(input, userId) {
    const clean = validatePost(input);
    const path = postPath(clean.slug);
    const existing = await this.content.getText(path);
    if (input.isNew) {
      if (existing !== null) throw bad('A post with that web address already exists.', 409);
      const problem = await this.slugProblem(clean.slug);
      if (problem) throw bad(problem);
    } else if (existing === null) throw bad('That post does not exist.', 404);

    // Keep any front-matter keys this editor doesn't manage (legacy_url, cover_service_slug, ...).
    const meta = existing ? (parse(existing).meta || {}) : {};
    Object.assign(meta, {
      title: clean.title, date: clean.date, excerpt: clean.excerpt, category: clean.category, status: clean.status,
      meta_description: clean.meta_description || undefined, image: clean.image || undefined, author: clean.author || undefined,
    });
    for (const k of ['meta_description', 'image', 'author']) if (meta[k] === undefined) delete meta[k];
    const text = serialize(meta, clean.body);

    const published = await this.repo.read(path);
    if (published && published.toString('utf8') === text) await db.exec('DELETE FROM drafts WHERE path = ?', [path]);   // identical to live: no draft
    else await this.content.saveDraftText(path, text, userId);
    await this.content.saveDraftRevision(userId, `Blog draft: ${clean.title}`.slice(0, 200));
    return this.get(clean.slug);
  }

  async setStatus(slug, status, userId) {
    const p = await this.get(slug);
    return this.save({ ...p, status: status === 'draft' ? 'draft' : 'published', isNew: false }, userId);
  }

  async remove(slug, userId) {
    if (!SLUG_RE.test(String(slug))) throw bad('Unknown post.', 404);
    const p = postPath(slug);
    if (await this.repo.read(p)) await this.content.stageDelete(p, userId);
    else await db.exec('DELETE FROM drafts WHERE path = ?', [p]);          // never published: just drop the draft
    await this.content.saveDraftRevision(userId, `Blog post removed: ${slug}`);
  }

  // Throw away unpublished work on a post: edits revert to the live version, a
  // staged deletion is cancelled, a never-published draft disappears.
  async discard(slug, userId) {
    if (!SLUG_RE.test(String(slug))) throw bad('Unknown post.', 404);
    await db.exec('DELETE FROM drafts WHERE path = ?', [postPath(slug)]);
    await this.content.saveDraftRevision(userId, `Blog changes discarded: ${slug}`);
  }

  // Publish ONE post: its file plus any not-yet-published images it uses.
  async publish(slug, message, userId) {
    if (!SLUG_RE.test(String(slug))) throw bad('Unknown post.', 404);
    const p = postPath(slug);
    const d = await db.one('SELECT kind, content FROM drafts WHERE path = ?', [p]);
    if (!d) return { published: false, files: 0, message: 'This post has no unpublished changes.' };
    const paths = [p];
    if (d.kind === 'text') {
      const { meta, body } = parse(d.content);
      const used = new Set([...(meta && meta.image ? [String(meta.image)] : []), ...(body.match(/images\/[A-Za-z0-9_\-/.]+\.(?:webp|jpe?g|png|gif|svg)/gi) || [])]);
      for (const rel of used) {
        const ip = `src/assets/${rel}`;
        if (await db.one("SELECT path FROM drafts WHERE path = ? AND kind = 'bin'", [ip])) paths.push(ip);
      }
    }
    const title = d.kind === 'text' ? String((parse(d.content).meta || {}).title || slug) : slug;
    return this.content.publish(userId, message || (d.kind === 'del' ? `Remove post: ${title}` : `Publish post: ${title}`), paths);
  }
}

module.exports = { Posts, parse, parseLite, serialize, validatePost, renderMarkdown, preview, checkDraftFile, isoDate, postPath, POST_FILE, SLUG_RE, RESERVED };
