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

  // Where is this image used? Scans every content file (and the templates).
  async references(p) {
    this._checkPath(p);
    const rel = p.replace(/^src\/assets\//, '');           // images/uploads/x.webp
    const needles = [rel, p.split('/').pop()];
    const hits = [];
    const paths = (await this.repo.list('src/data/')).map((f) => f.path).filter((x) => x.endsWith('.json'));
    const tpl = (await this.repo.list('src/templates/')).map((f) => f.path);
    for (const f of [...paths, ...tpl]) {
      const text = await this.content.getText(f);
      if (text && needles.some((n) => text.includes(n))) hits.push(f);
    }
    const dr = await db.query("SELECT path, content FROM drafts WHERE kind = 'text'");
    for (const d of dr) if (!hits.includes(d.path) && needles.some((n) => (d.content || '').includes(n))) hits.push(d.path);
    return hits;
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
