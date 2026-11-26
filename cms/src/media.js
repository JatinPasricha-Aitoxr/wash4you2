'use strict';
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const IMG_ROOT = 'src/assets/images/';
const UP_DIR = 'src/assets/images/uploads/';
const EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const ext = (n) => (n.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();

function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.slice(0, 4).toString() === 'GIF8') return '.gif';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return '.webp';
  const head = buf.slice(0, 600).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return '.svg';
  return null;
}
function svgIsSafe(buf) {
  const s = buf.toString('utf8');
  return !/<script|<foreignobject|\son\w+\s*=|javascript:|<iframe|<embed|<object|xlink:href\s*=\s*["']?\s*(?!#)/i.test(s);
}
const slug = (s) => (String(s).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'image').slice(0, 50);

// Validate and normalise an upload; returns { buffer, ext, name }.
function validateUpload(name, dataUrl) {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('Expected a base64 image upload.'), { status: 400 });
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });
  if (buffer.length > config.maxUploadBytes) throw Object.assign(new Error(`Image is too large (max ${Math.round(config.maxUploadBytes / 1048576)} MB).`), { status: 413 });
  const real = sniff(buffer);
  if (!real) throw Object.assign(new Error('Only PNG, JPG, WebP, GIF or SVG images are allowed.'), { status: 415 });
  if (real === '.svg' && !svgIsSafe(buffer)) throw Object.assign(new Error('This SVG contains scripts or unsafe content.'), { status: 415 });
  const claimed = ext(String(name || ''));
  if (claimed && EXT.has(claimed) && (claimed === '.jpeg' ? '.jpg' : claimed) !== real) throw Object.assign(new Error('The file type does not match its extension.'), { status: 415 });
  return { buffer, ext: real };
}


// A human description of one file that uses an image: what it is, which pages show it.
const STORE_PAGES = { home: ['/'], about: ['/about-us/'], services: ['/services/'], pricing: ['/pricing/'], packages: ['/packages/'],
  'steam-iron': ['/steam-iron/'], blog: ['/blog/'], locations: ['/locate-us/'], policies: [], testimonials: [], proof: [], posters: [], site: [] };
const STORE_NAMES = { home: 'Home page', about: 'About page', services: 'Services page', pricing: 'Pricing page', packages: 'Packages page',
  'steam-iron': 'Steam iron page', blog: 'Blog page', locations: 'Locate us page', policies: 'Policy pages', testimonials: 'Customer reviews',
  proof: 'Before / after photos', posters: 'Poster images (shared)', site: 'Header, footer and site settings', areas: 'Area pages', 'city-prices': 'City price pages' };
function describe(h, rel, resolveScope) {
  const f = h.file, out = { file: f, via: h.via, label: f, pages: [], note: '' };
  let m;
  if ((m = /^content\/posts\/(.+)\.md$/.exec(f))) {
    const title = (/^title:\s*"?(.*?)"?\s*$/m.exec(h.text) || [])[1] || m[1];
    out.label = `Blog post: ${title.replace(/\\"/g, '"')}`; out.pages = [`/${m[1]}/`];
  } else if ((m = /^src\/data\/products\/(.+)\.json$/.exec(f))) {
    out.label = `Product page: ${m[1]}`; out.pages = [`/products/${m[1]}/`];
  } else if (f === 'src/data/overrides.json') {
    out.label = 'Edited in the Studio (text or image replaced on a page)';
    try { const d = JSON.parse(h.text); for (const [scope, kv] of Object.entries(d.i || {})) if (Object.values(kv).includes(rel)) { const pg = resolveScope && resolveScope(scope); if (pg) out.pages.push(pg); else out.note = 'on every page (header or footer)'; } } catch { /* ignore */ }
  } else if (f === 'src/data/blocks.json' || f === 'src/data/styles.json') {
    out.label = f.endsWith('blocks.json') ? 'A Studio widget (e.g. image or gallery)' : 'A Studio section background';
    try { const d = JSON.parse(h.text); const sec = f.endsWith('blocks.json') ? d.pages : d.sections; for (const [k, v] of Object.entries(sec || {})) if (JSON.stringify(v).includes(rel)) { const pg = resolveScope && resolveScope(k); if (pg) out.pages.push(pg); else out.note = `scope ${k}`; } } catch { /* ignore */ }
  } else if ((m = /^src\/data\/([^/]+)\.json$/.exec(f))) {
    out.label = STORE_NAMES[m[1]] || `Site data: ${m[1]}`; out.pages = STORE_PAGES[m[1]] || [];
  } else if (f.startsWith('src/templates/')) {
    out.label = `Site template: ${f.split('/').pop()}`; out.note = h.via === 'folder' ? 'this template picks images from the same folder by name, so this image may appear there' : 'part of the page layout';
  } else if (f.startsWith('src/assets/css/')) {
    out.label = `Stylesheet: ${f.split('/').pop()}`;
  }
  if (h.via === 'name' && !out.note) out.note = 'matched by file name only';
  return out;
}

class Media {
  constructor(repo, content) { this.repo = repo; this.content = content; }

  async list({ q = '', limit = 60, offset = 0, folder = '' } = {}) {
    const files = (await this.repo.list(IMG_ROOT)).filter((f) => EXT.has(ext(f.path)));
    const drafts = await db.query("SELECT path, kind, updated_at FROM drafts WHERE path LIKE ?", [IMG_ROOT + '%']);
    const map = new Map(files.map((f) => [f.path, { path: f.path, size: f.size, draft: false }]));
    for (const d of drafts) {
      if (d.kind === 'bin') map.set(d.path, { path: d.path, size: (map.get(d.path) || {}).size || 0, draft: true });
      if (d.kind === 'del') map.delete(d.path);
    }
    const meta = new Map((await db.query('SELECT path, alt, title FROM media_meta')).map((r) => [r.path, r]));
    let items = [...map.values()].map((f) => ({
      ...f, url: f.path.replace(/^src\/assets\//, ''), name: f.path.split('/').pop(),
      folder: f.path.slice(IMG_ROOT.length).split('/').slice(0, -1).join('/'),
      alt: (meta.get(f.path) || {}).alt || '', title: (meta.get(f.path) || {}).title || '',
    }));
    if (folder) items = items.filter((i) => i.folder === folder);
    const needle = String(q).toLowerCase().trim();
    if (needle) items = items.filter((i) => i.name.toLowerCase().includes(needle) || i.alt.toLowerCase().includes(needle) || i.folder.toLowerCase().includes(needle));
    items.sort((a, b) => Number(b.draft) - Number(a.draft) || a.path.localeCompare(b.path));
    const folders = [...new Set([...map.keys()].map((p) => p.slice(IMG_ROOT.length).split('/').slice(0, -1).join('/')))].sort();
    return { total: items.length, items: items.slice(offset, offset + limit), folders };
  }

  async upload(name, dataUrl, userId) {
    const { buffer, ext: e } = validateUpload(name, dataUrl);
    const fname = `${slug(name)}-${crypto.randomBytes(4).toString('hex')}${e}`;
    const p = UP_DIR + fname;
    await this.content.saveDraftBinary(p, buffer, userId);
    await db.exec('INSERT INTO media_meta (path, alt, title, uploaded_by, uploaded_at) VALUES (?,?,?,?,?)', [p, '', '', userId, Date.now()]);
    return { path: p, url: p.replace(/^src\/assets\//, '') };
  }

  async replace(p, dataUrl, userId) {
    this._checkPath(p);
    const { buffer, ext: e } = validateUpload(p, dataUrl);
    const cur = ext(p) === '.jpeg' ? '.jpg' : ext(p);
    if (e !== cur) throw Object.assign(new Error(`Replacement must be a ${cur.slice(1).toUpperCase()} image (same type as the original).`), { status: 400 });
    await this.content.saveDraftBinary(p, buffer, userId);
    return { path: p };
  }

  async setMeta(p, { alt, title }) {
    this._checkPath(p);
    const row = await db.one('SELECT path FROM media_meta WHERE path = ?', [p]);
    const a = String(alt ?? '').slice(0, 250), t = String(title ?? '').slice(0, 250);
    if (row) await db.exec('UPDATE media_meta SET alt = ?, title = ? WHERE path = ?', [a, t, p]);
    else await db.exec('INSERT INTO media_meta (path, alt, title) VALUES (?,?,?)', [p, a, t]);
  }

  _checkPath(p) {
    if (typeof p !== 'string' || !p.startsWith(IMG_ROOT) || p.includes('..') || !EXT.has(ext(p))) throw Object.assign(new Error('Not a media file.'), { status: 400 });
  }

  // ---- Where is this image used? ------------------------------------------------------------
  // Scans page data, templates, stylesheets, blog posts and unpublished drafts. Matching is exact
  // (a whole path, or a whole file name written as a value), so "shirt.webp" no longer matches
  // "t-shirt.webp". File contents are cached by version, and fetched in parallel, so the first
  // search takes a few seconds on the live server and later ones are instant.
  async _scanSet() {
    const dirs = ['src/data/', 'src/templates/', 'src/assets/css/', 'content/posts/'];
    const lists = await Promise.all(dirs.map((d) => this.repo.list(d)));
    const files = lists.flat().filter((f) => /\.(json|html|css|md)$/.test(f.path));
    const drafts = await db.query("SELECT path, content, kind FROM drafts WHERE kind IN ('text','del')");
    const dmap = new Map(drafts.map((d) => [d.path, d]));
    const out = new Map(files.map((f) => [f.path, { path: f.path, sha: f.sha, draft: null }]));
    for (const d of drafts) {
      if (!dirs.some((x) => d.path.startsWith(x)) || !/\.(json|html|css|md)$/.test(d.path)) continue;
      if (d.kind === 'del') out.delete(d.path); else out.set(d.path, { path: d.path, draft: d.content || '' });
    }
    void dmap; return [...out.values()];
  }
  async _text(f) {
    if (f.draft != null) return f.draft;
    this._cache = this._cache || new Map();
    const key = `${f.path}@${f.sha}`;
    if (this._cache.has(key)) return this._cache.get(key);
    const buf = await this.repo.read(f.path);
    const text = buf ? buf.toString('utf8') : '';
    if (this._cache.size > 2000) this._cache.clear();
    this._cache.set(key, text);
    return text;
  }
  static matcher(p) {
    const rel = p.replace(/^src\/assets\//, '');                  // images/pricing/shirt.webp
    const name = p.split('/').pop();
    const folder = rel.slice(0, rel.lastIndexOf('/'));
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const full = new RegExp('(?<![A-Za-z0-9_-])' + esc(rel) + '(?![A-Za-z0-9_-])');
    const bare = new RegExp('(?<=["\'(])' + esc(name) + '(?![A-Za-z0-9_.-])');
    const dyn = new RegExp(esc(folder) + '/\\{\\{');
    return { rel, test: (text, isTpl) => (full.test(text) ? 'path' : bare.test(text) ? 'name' : (isTpl && dyn.test(text) ? 'folder' : null)) };
  }
  async usage(p, resolveScope) {
    this._checkPath(p);
    const m = Media.matcher(p);
    const set = await this._scanSet();
    const hits = [];
    let i = 0;
    const worker = async () => {
      while (i < set.length) {
        const f = set[i++];
        const text = await this._text(f).catch(() => '');
        const via = m.test(text, f.path.startsWith('src/templates/'));
        if (via) hits.push({ file: f.path, via, text });
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    hits.sort((a, b) => a.file.localeCompare(b.file));
    return hits.map((h) => describe(h, m.rel, resolveScope));
  }
  async references(p) {
    return (await this.usage(p)).filter((u) => u.via !== 'folder').map((u) => u.file);
  }

  async remove(p, userId) {
    this._checkPath(p);
    const refs = await this.references(p);
    if (refs.length) throw Object.assign(new Error('This image is still used by published content. Replace it where it is used first.'), { status: 409, refs });
    const published = await this.repo.read(p);
    if (published) { await db.exec('DELETE FROM drafts WHERE path = ?', [p]); await db.exec("INSERT INTO drafts (path, content, data, kind, updated_by, updated_at) VALUES (?,?,?,?,?,?)", [p, null, null, 'del', userId, Date.now()]); }
    else await db.exec('DELETE FROM drafts WHERE path = ?', [p]);
    await db.exec('DELETE FROM media_meta WHERE path = ?', [p]);
    return { removed: p };
  }
}
module.exports = { Media, validateUpload, sniff, IMG_ROOT, UP_DIR };
