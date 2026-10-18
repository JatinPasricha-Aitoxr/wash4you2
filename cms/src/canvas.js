'use strict';
// The editor canvas is the last *published* build of the site. Edits that are
// saved as drafts but not yet published are laid over it here, so reopening a
// page always shows your latest saved work.
const db = require('./db');
const sanitizeHtml = require('sanitize-html');
const { RT, storePath, split } = require('./content');

const SKIP = new Set(['layout', 'blocks', 'styles', 'seo']);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const RT_OPTS = { allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'span', 'blockquote'], allowedAttributes: { a: ['href', 'target', 'rel'], span: ['style'] }, allowedSchemes: ['http', 'https', 'mailto', 'tel'] };
const render = (v) => (typeof v === 'string' && v.startsWith(RT) ? sanitizeHtml(v.slice(RT.length), RT_OPTS) : esc(v));
const get = (obj, keys) => { let c = obj; for (const k of keys) { if (c == null) return undefined; c = c[k]; } return c; };

function closeIndex(html, name, from) {
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi'); re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(html))) { depth += m[1] ? -1 : (/\/>$/.test(m[0]) ? 0 : 1); if (!depth) return m.index; }
  return -1;
}

async function overlayDrafts(html, repo) {
  const rows = await db.query("SELECT path, content FROM drafts WHERE kind = 'text'");
  const docs = {};
  for (const r of rows) {
    const m = /^src\/data\/([A-Za-z0-9_-]+)\.json$/.exec(r.path);
    if (!m || SKIP.has(m[1])) continue;
    try {
      const pubBuf = await repo.read(r.path);
      docs[m[1]] = { draft: JSON.parse(r.content), pub: pubBuf ? JSON.parse(pubBuf.toString('utf8')) : {} };
    } catch { /* ignore unreadable draft */ }
  }
  if (!Object.keys(docs).length) return html;
  const re = /<([a-z][a-z0-9]*)\b[^>]*?\sdata-cms="([a-z0-9-]+):([^"]+)"[^>]*?>/gi;
  const edits = []; let m;
  while ((m = re.exec(html))) {
    const d = docs[m[2]]; if (!d) continue;
    let keys; try { keys = split(m[3]); } catch { continue; }
    const dv = get(d.draft, keys), pv = get(d.pub, keys);
    if (typeof dv !== 'string' || dv === pv) continue;
    const start = m.index + m[0].length, end = closeIndex(html, m[1], start);
    if (end > 0) edits.push([start, end, render(dv)]);
  }
  for (const [s, e, v] of edits.sort((a, b) => b[0] - a[0])) html = html.slice(0, s) + v + html.slice(e);
  return html;
}
module.exports = { overlayDrafts };
