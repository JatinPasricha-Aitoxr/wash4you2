'use strict';
// Content layer: reads effective content (draft over repository), validates and
// stages edits as drafts in the database, publishes drafts as ONE git commit,
// and records revisions that can be restored.
const db = require('./db');
const sanitizeHtml = require('sanitize-html');

const ALLOWED_STORES = new Set([
  'site', 'home', 'about', 'services', 'pricing', 'packages', 'steam-iron', 'blog', 'locations',
  'policies', 'pages', 'proof', 'testimonials', 'posters', 'city-prices', 'areas',
  'generated-services', 'seo', 'layout', 'blocks', 'styles',
]);
const STORE_FILES = { 'generated-services': 'generated/services.json' };
const storePath = (store) => {
  if (!ALLOWED_STORES.has(store)) throw bad(`unknown store: ${store}`);
  return `src/data/${STORE_FILES[store] || store + '.json'}`;
};
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const BLOCK_TYPES = ['hero', 'heading', 'image_text', 'gallery', 'cta', 'stats', 'faq', 'video', 'spacer', 'html'];
const EMPTY = { layout: { pages: {} }, blocks: { pages: {} }, styles: { sections: {}, elements: {}, global: {} }, seo: { pages: {} } };

// ---------------------------------------------------------- sanitising
const RT = '<!--rt-->';
const RT_OPTS = {
  allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'span', 'blockquote'],
  allowedAttributes: { a: ['href', 'target', 'rel'], span: ['style'] },
  allowedStyles: { span: { color: [/^#[0-9a-f]{3,8}$/i, /^rgb\([\d\s,]+\)$/] } },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowProtocolRelative: false,
  transformTags: {
    div: 'p',
    a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs,
      ...(/^https?:/i.test(attribs.href || '') ? { target: '_blank', rel: 'noopener' } : {}) } }),
  },
};
// The "Custom HTML" widget: rich markup, but never script, styles, forms or handlers.
const CUSTOM_OPTS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'figure', 'figcaption', 'iframe', 'section', 'h1', 'h2', 'span', 'div', 'small']),
  allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt', 'width', 'height', 'loading'], iframe: ['src', 'title', 'allowfullscreen', 'loading', 'width', 'height'], '*': ['class'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedIframeHostnames: ['www.youtube-nocookie.com', 'www.youtube.com', 'player.vimeo.com'],
  allowProtocolRelative: false,
  exclusiveFilter: (f) => f.tag === 'iframe' && !f.attribs.src,
};
const SAFE_URL = /^(https?:\/\/|mailto:|tel:|#|\/|[A-Za-z0-9_./?=&%-]*$)/i;
const cleanUrl = (u) => (typeof u === 'string' && SAFE_URL.test(u.trim()) && !/^\s*(javascript|data|vbscript):/i.test(u) ? u.trim() : '');

function cleanString(v, key, blockType) {
  if (typeof v !== 'string') return v;
  if (v.length > 60000) throw bad('A text value is too long.');
  if (v.startsWith(RT)) return RT + sanitizeHtml(v.slice(RT.length), RT_OPTS);
  if (blockType === 'html' && key === 'html') return sanitizeHtml(v, CUSTOM_OPTS);
  if (/(^|_)(url|link|src|image|href)$/i.test(key) || /^button2?_url$/.test(key)) {
    if (/^\s*(javascript|data|vbscript):/i.test(v)) return '';
    if (/^(src|image)$/i.test(key) || /_src$|_image$/i.test(key)) return v;
    return cleanUrl(v) || '';
  }
  return v;
}
function cleanDeep(v, key = '', blockType = '', depth = 0) {
  if (depth > 8) throw bad('Content is nested too deeply.');
  if (Array.isArray(v)) { if (v.length > 400) throw bad('A list is too long.'); return v.map((x) => cleanDeep(x, key, blockType, depth + 1)); }
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) { if (k === '__proto__' || k === 'constructor') continue; o[k] = cleanDeep(x, k, blockType, depth + 1); }
    return o;
  }
  return cleanString(v, key, blockType);
}

// ---------------------------------------------------------- validation
const SCOPE_KEY = /^(page|tpl):[A-Za-z0-9_\-./:]{0,200}$/;
const CSS_SAFE = /^[#A-Za-z0-9 .,()%/_\-+]*$/;
function validateLayout(d) {
  const out = { pages: {} };
  for (const [k, v] of Object.entries((d && d.pages) || {})) {
    if (!SCOPE_KEY.test(k)) throw bad(`bad layout key: ${k}`);
    const order = Array.isArray(v && v.order) ? v.order : [], hidden = Array.isArray(v && v.hidden) ? v.hidden : [];
    for (const id of [...order, ...hidden]) if (typeof id !== 'string' || !/^[A-Za-z0-9_\-]{1,80}$/.test(id)) throw bad('bad section id');
    out.pages[k] = { order, hidden };
  }
  return out;
}
function validateBlocks(d) {
  const out = { pages: {} };
  for (const [k, list] of Object.entries((d && d.pages) || {})) {
    if (!SCOPE_KEY.test(k)) throw bad(`bad blocks key: ${k}`);
    if (!Array.isArray(list) || list.length > 60) throw bad('too many blocks on a page');
    out.pages[k] = list.map((b) => {
      if (!b || !BLOCK_TYPES.includes(b.type)) throw bad(`unknown widget type: ${b && b.type}`);
      if (!/^[A-Za-z0-9_\-]{1,40}$/.test(String(b.id))) throw bad('bad widget id');
      return { id: b.id, type: b.type, props: cleanDeep(b.props || {}, '', b.type) };
    });
  }
  return out;
}
function validateStyles(d) {
  const out = { sections: {}, elements: {}, global: {} };
  const clean = (props) => {
    const o = {};
    for (const [k, v] of Object.entries(props || {})) {
      if (!/^[A-Za-z]{1,20}$/.test(k)) continue;
      if (typeof v === 'boolean') { o[k] = v; continue; }
      const s = String(v);
      if (!CSS_SAFE.test(s) || s.length > 60) continue;
      o[k] = s;
    }
    return o;
  };
  for (const [scope, secs] of Object.entries((d && d.sections) || {})) {
    if (!SCOPE_KEY.test(scope)) throw bad(`bad style scope: ${scope}`);
    out.sections[scope] = {};
    for (const [sid, props] of Object.entries(secs || {})) if (/^[A-Za-z0-9_\-]+$/.test(sid)) out.sections[scope][sid] = clean(props);
  }
  for (const [b, props] of Object.entries((d && d.elements) || {})) if (/^[A-Za-z0-9_.:\-]+$/.test(b)) out.elements[b] = clean(props);
  for (const [k, v] of Object.entries((d && d.global) || {})) if (/^--[a-z0-9-]+$/.test(k) && /^#[0-9a-fA-F]{3,8}$/.test(String(v))) out.global[k] = String(v);
  return out;
}

// ------------------------------------------------------------- bindings
const KEY_RE = /^[A-Za-z0-9_.\-]+$/;
const split = (p) => {
  if (!p || !KEY_RE.test(p)) throw bad(`invalid path: ${p}`);
  return p.split('.').map((s) => (/^\d+$/.test(s) ? parseInt(s, 10) : s));
};
function parseBinding(b) {
  const i = String(b).indexOf(':');
  if (i < 0) throw bad(`invalid binding: ${b}`);
  return [b.slice(0, i), b.slice(i + 1)];
}
function resolve(data, keys) {
  let cur = data;
  for (const k of keys) { if (k === '__proto__' || k === 'constructor' || cur == null) throw bad('bad path'); cur = cur[k]; }
  return cur;
}

class Content {
  constructor(repo) { this.repo = repo; }

  async getText(p) {
    const d = await db.one('SELECT content, kind FROM drafts WHERE path = ?', [p]);
    if (d && d.kind === 'text') return d.content;
    if (d && d.kind === 'del') return null;
    const buf = await this.repo.read(p);
    return buf ? buf.toString('utf8') : null;
  }
  async readStore(store) {
    const text = await this.getText(storePath(store));
    if (text == null) return JSON.parse(JSON.stringify(EMPTY[store] || {}));
    try { return JSON.parse(text); } catch { return JSON.parse(JSON.stringify(EMPTY[store] || {})); }
  }
  async saveDraftText(p, text, userId) {
    await db.exec('DELETE FROM drafts WHERE path = ?', [p]);
    await db.exec('INSERT INTO drafts (path, content, data, kind, updated_by, updated_at) VALUES (?,?,?,?,?,?)',
      [p, text, null, 'text', userId, Date.now()]);
  }
  async saveDraftBinary(p, buf, userId) {
    await db.exec('DELETE FROM drafts WHERE path = ?', [p]);
    await db.exec('INSERT INTO drafts (path, content, data, kind, updated_by, updated_at) VALUES (?,?,?,?,?,?)',
      [p, null, buf, 'bin', userId, Date.now()]);
  }
  async saveStore(store, data, userId) {
    await this.saveDraftText(storePath(store), JSON.stringify(data, null, 2) + '\n', userId);
  }

  async getBinding(binding) {
    const [store, p] = parseBinding(binding);
    return resolve(await this.readStore(store), split(p));
  }
  async applyEdits(edits, userId) {
    if (!Array.isArray(edits) || edits.length > 500) throw bad('bad edits');
    const by = {};
    for (const e of edits) {
      const [store, p] = parseBinding(e.binding);
      if (['layout', 'blocks', 'styles'].includes(store)) throw bad('use the studio endpoints for layout, blocks and styles');
      (by[store] = by[store] || []).push([split(p), cleanDeep(e.value, split(p).slice(-1)[0] + '')]);
    }
    const changed = {};
    for (const [store, items] of Object.entries(by)) {
      const data = await this.readStore(store);
      for (const [keys, value] of items) {
        const parent = resolve(data, keys.slice(0, -1));
        if (parent == null || typeof parent !== 'object') throw bad('path not found');
        parent[keys[keys.length - 1]] = value;
      }
      await this.saveStore(store, data, userId);
      changed[store] = items.length;
    }
    return changed;
  }
  async saveStudioDocs({ layout, blocks, styles }, userId) {
    if (layout) await this.saveStore('layout', validateLayout(layout), userId);
    if (blocks) await this.saveStore('blocks', validateBlocks(blocks), userId);
    if (styles) await this.saveStore('styles', validateStyles(styles), userId);
  }

  // -------------------------------------------------------- drafts
  async listDrafts() {
    const rows = await db.query('SELECT path, kind, updated_at, updated_by FROM drafts ORDER BY path');
    return rows.map((r) => ({ path: r.path, kind: r.kind, updatedAt: Number(r.updated_at) }));
  }
  async discardDrafts(paths) {
    if (paths && paths.length) for (const p of paths) await db.exec('DELETE FROM drafts WHERE path = ?', [p]);
    else await db.exec('DELETE FROM drafts');
  }
  async snapshotDrafts(revId) {
    const rows = await db.query('SELECT path, content, data, kind FROM drafts');
    for (const r of rows) await db.exec('INSERT INTO revision_files (revision_id, path, content, data, kind) VALUES (?,?,?,?,?)', [revId, r.path, r.content, r.data, r.kind]);
    return rows.length;
  }
  // Validate every staged JSON file before it can go live.
  async validateDrafts() {
    const rows = await db.query("SELECT path, content, kind FROM drafts WHERE kind = 'text'");
    for (const r of rows) {
      try { JSON.parse(r.content); } catch { throw new Error(`${r.path} is not valid JSON`); }
    }
    return rows.length;
  }

  async publish(userId, message) {
    const rows = await db.query('SELECT path, content, data, kind FROM drafts');
    if (!rows.length) return { published: false, files: 0, message: 'No drafts to publish.' };
    await this.validateDrafts();
    const files = {};
    for (const r of rows) files[r.path] = r.kind === 'bin' ? Buffer.from(r.data) : r.kind === 'del' ? null : r.content;
    const msg = (message || 'Update site content via admin').slice(0, 200);
    const sha = await this.repo.commit(files, `${msg}\n\nPublished from the Wash4You admin.`);
    const rev = await db.exec('INSERT INTO revisions (kind, message, user_id, commit_sha, created_at) VALUES (?,?,?,?,?)', ['publish', msg, userId, sha, Date.now()]);
    for (const r of rows) await db.exec('INSERT INTO revision_files (revision_id, path, content, data, kind) VALUES (?,?,?,?,?)', [rev.insertId, r.path, r.content, r.data, r.kind]);
    await db.exec('DELETE FROM drafts');
    return { published: true, files: rows.length, revision: rev.insertId, sha };
  }

  // ---------------------------------------------------- revisions
  async listRevisions(limit = 50) {
    const rows = await db.query(`SELECT r.id, r.kind, r.message, r.commit_sha, r.created_at, u.username,
      (SELECT COUNT(*) FROM revision_files f WHERE f.revision_id = r.id) AS files
      FROM revisions r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT ${Number(limit) | 0}`);
    return rows.map((r) => ({ id: r.id, kind: r.kind, message: r.message, sha: r.commit_sha, at: Number(r.created_at), by: r.username, files: Number(r.files) }));
  }
  async saveDraftRevision(userId, message) {
    const n = (await db.one('SELECT COUNT(*) AS n FROM drafts')).n;
    if (!Number(n)) return null;
    const last = await db.one("SELECT id, created_at FROM revisions WHERE kind = 'draft' ORDER BY id DESC LIMIT 1");
    if (last && Date.now() - Number(last.created_at) < 60e3) {            // coalesce rapid saves
      await db.exec('DELETE FROM revision_files WHERE revision_id = ?', [last.id]);
      await db.exec('UPDATE revisions SET created_at = ?, message = ? WHERE id = ?', [Date.now(), message, last.id]);
      await this.snapshotDrafts(last.id); return last.id;
    }
    const rev = await db.exec('INSERT INTO revisions (kind, message, user_id, created_at) VALUES (?,?,?,?)', ['draft', message, userId, Date.now()]);
    await this.snapshotDrafts(rev.insertId);
    await db.exec(`DELETE FROM revision_files WHERE revision_id IN (SELECT id FROM revisions WHERE kind = 'draft' AND id NOT IN (SELECT id FROM (SELECT id FROM revisions WHERE kind = 'draft' ORDER BY id DESC LIMIT 30) t))`);
    await db.exec(`DELETE FROM revisions WHERE kind = 'draft' AND id NOT IN (SELECT id FROM (SELECT id FROM revisions WHERE kind = 'draft' ORDER BY id DESC LIMIT 30) t)`);
    return rev.insertId;
  }
  // Restoring puts a revision's files back as DRAFTS; nothing goes live until Publish.
  async restoreRevision(id, userId) {
    const rev = await db.one('SELECT id FROM revisions WHERE id = ?', [id]);
    if (!rev) throw new Error('revision not found');
    const files = await db.query('SELECT path, content, data, kind FROM revision_files WHERE revision_id = ?', [id]);
    for (const f of files) {
      if (f.kind === 'bin') await this.saveDraftBinary(f.path, Buffer.from(f.data), userId);
      else await this.saveDraftText(f.path, f.content, userId);
    }
    return files.length;
  }
}

module.exports = { Content, ALLOWED_STORES, BLOCK_TYPES, storePath, validateLayout, validateBlocks, validateStyles, cleanDeep, RT, cleanUrl, split, parseBinding };
