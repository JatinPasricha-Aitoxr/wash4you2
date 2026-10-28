'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const repoMod = require('./repo');
const { Content, BLOCK_TYPES, cleanUrl, cleanDeep } = require('./content');
const { Media, validateUpload } = require('./media');
const { renderBlock } = require('./blocks');
const editsite = require('./editsite');
const { overlayDrafts } = require('./canvas');
const { Posts, preview: previewPost } = require('./posts');

const PUBLIC = path.join(__dirname, '..', 'public');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2' };

const ADMIN_CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

function createApp({ repo, content, media } = {}) {
  repo = repo || repoMod.create();
  content = content || new Content(repo);
  media = media || new Media(repo, content);
  const posts = new Posts(repo, content);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '14mb' }));
  app.use(auth.loadSession);
  app.use('/admin/api', (req, res, next) => (req.path === '/login' ? next() : auth.requireCsrf(req, res, next)));

  const api = express.Router();
  app.use('/admin/api', api);
  const user = (req) => req.session.user.id;

  // ------------------------------------------------------------- auth
  api.post('/login', wrap(async (req, res) => {
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-site sign-in blocked.' });
    const r = await auth.login(req.ip || '', req.body.username, req.body.password);
    if (r.error) { await auth.audit(null, 'login_failed', String(req.body.username || '').slice(0, 64)); return res.status(r.status).json({ error: r.error }); }
    auth.setSessionCookie(res, r.token, config.sessionHours * 3600);
    req.session = { user: r.user, csrf: r.csrf };
    await auth.audit(req, 'login');
    res.json({ ok: true, user: r.user, csrf: r.csrf });
  }));
  api.post('/logout', wrap(async (req, res) => {
    await auth.destroySession(req); auth.setSessionCookie(res, '', 0); res.json({ ok: true });
  }));
  api.get('/me', (req, res) => req.session ? res.json({ user: req.session.user, csrf: req.session.csrf, repoDriver: repo.name }) : res.status(401).json({ error: 'not authenticated' }));
  api.use((req, res, next) => (req.path === '/login' ? next() : auth.requireAuth(req, res, next)));

  api.post('/password', wrap(async (req, res) => {
    const { current, next: nw } = req.body || {};
    const row = await db.one('SELECT * FROM users WHERE id = ?', [user(req)]);
    if (!auth.verifyPassword(String(current || ''), row.password_hash)) return res.status(400).json({ error: 'Current password is wrong.' });
    const problem = auth.passwordProblem(nw); if (problem) return res.status(400).json({ error: problem });
    await db.exec('UPDATE users SET password_hash = ? WHERE id = ?', [auth.hashPassword(nw), row.id]);
    await db.exec('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [row.id, req.session.hash]);
    await auth.audit(req, 'password_changed');
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------- users (admin)
  api.get('/users', auth.requireAdmin, wrap(async (req, res) => {
    const rows = await db.query('SELECT id, username, role, created_at, last_login_at FROM users ORDER BY id');
    res.json({ users: rows.map((r) => ({ id: r.id, username: r.username, role: r.role, createdAt: Number(r.created_at), lastLoginAt: r.last_login_at ? Number(r.last_login_at) : null })) });
  }));
  api.post('/users', auth.requireAdmin, wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(String(username || ''))) return res.status(400).json({ error: 'Username: 3-40 letters, numbers, . _ -' });
    const problem = auth.passwordProblem(password); if (problem) return res.status(400).json({ error: problem });
    if (await db.one('SELECT id FROM users WHERE username = ?', [username])) return res.status(409).json({ error: 'That username already exists.' });
    await db.exec('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)', [username, auth.hashPassword(password), 'admin', Date.now()]);
    await auth.audit(req, 'user_created', username);
    res.json({ ok: true });
  }));
  api.post('/users/delete', auth.requireAdmin, wrap(async (req, res) => {
    const id = Number(req.body.id);
    if (id === user(req)) return res.status(400).json({ error: "You can't delete your own account." });
    await db.exec('DELETE FROM sessions WHERE user_id = ?', [id]); await db.exec('DELETE FROM users WHERE id = ?', [id]);
    await auth.audit(req, 'user_deleted', String(id)); res.json({ ok: true });
  }));

  // ------------------------------------------------------------ overview
  api.get('/overview', wrap(async (req, res) => {
    const drafts = await content.listDrafts();
    const revs = await content.listRevisions(5);
    const lastPub = await db.one("SELECT created_at, message FROM revisions WHERE kind = 'publish' ORDER BY id DESC LIMIT 1");
    const m = await media.list({ limit: 1 });
    const pages = await studioPages();
    const postList = await posts.list().catch(() => null);
    const log = await db.query('SELECT a.action, a.detail, a.at, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 8');
    res.json({
      drafts: drafts.length, pages: pages.length, posts: postList ? postList.length : null, media: m.total, revisions: (await db.one("SELECT COUNT(*) AS n FROM revisions WHERE kind = 'publish'")).n * 1,
      lastPublish: lastPub ? { at: Number(lastPub.created_at), message: lastPub.message } : null,
      recent: revs, editSite: editsite.status(), repoDriver: repo.name, siteUrl: config.publicSiteUrl,
      activity: log.map((r) => ({ action: r.action, detail: r.detail, at: Number(r.at), by: r.username })),
    });
  }));

  // -------------------------------------------------------------- studio
  async function studioPages() {
    const f = editsite.safeFile('sitemap.xml'); const out = [];
    const main = ['/', '/services/', '/pricing/', '/packages/', '/about-us/', '/locate-us/', '/contact-us/', '/blog/', '/steam-iron/', '/wash4you-overview/', '/best-dryclean-near-me/', '/best-dryclean-in-gurgaon/'];
    if (f) for (const m of fs.readFileSync(f, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)) { let p; try { p = new URL(m[1]).pathname || '/'; } catch { continue; } out.push(p); }
    const postSlugs = new Set((await repo.list('content/posts/').catch(() => [])).map((f) => f.path.split('/').pop().replace(/\.md$/, '')));
    const group = (p) => main.includes(p) ? 'Main pages' : p.startsWith('/products/') ? 'Products' : p.startsWith('/services/') ? 'Services' : (p.startsWith('/blog/') || postSlugs.has(p.replace(/\//g, ''))) ? 'Blog' : p.startsWith('/laundry-service-') ? 'Area pages' : 'Other';
    const order = { 'Main pages': 0, Services: 1, Products: 2, Blog: 3, 'Area pages': 4, Other: 5 };
    return out.map((p) => ({ path: p, group: group(p), post: postSlugs.has(p.replace(/\//g, '')) })).sort((a, b) => order[a.group] - order[b.group] || (main.indexOf(a.path) < 0 ? 999 : main.indexOf(a.path)) - (main.indexOf(b.path) < 0 ? 999 : main.indexOf(b.path)) || a.path.localeCompare(b.path));
  }
  api.get('/studio/pages', wrap(async (req, res) => res.json({ pages: await studioPages() })));
  api.get('/studio/state', wrap(async (req, res) => res.json({
    layout: await content.readStore('layout'), blocks: await content.readStore('blocks'), styles: await content.readStore('styles'), types: BLOCK_TYPES })));
  api.post('/studio/save', wrap(async (req, res) => {
    const b = req.body || {};
    const changed = b.edits && b.edits.length ? await content.applyEdits(b.edits, user(req)) : {};
    await content.saveStudioDocs({ layout: b.layout, blocks: b.blocks, styles: b.styles }, user(req));
    await content.saveDraftRevision(user(req), 'Draft saved');
    await auth.audit(req, 'draft_saved', Object.keys(changed).join(','));
    res.json({ ok: true, changed });
  }));
  api.post('/save', wrap(async (req, res) => {
    const changed = await content.applyEdits((req.body || {}).edits, user(req));
    await content.saveDraftRevision(user(req), 'Draft saved'); res.json({ ok: true, changed });
  }));
  api.post('/studio/render-block', wrap(async (req, res) => {
    const b = req.body || {};
    if (!BLOCK_TYPES.includes(b.type)) return res.status(400).json({ error: 'unknown block type' });
    const props = cleanDeep(b.props || {}, '', b.type);
    res.json({ html: renderBlock({ id: String(b.id || 'blk-preview').replace(/[^A-Za-z0-9_-]/g, ''), type: b.type, props }, '/', '/') });
  }));
  api.post('/studio/bindings', wrap(async (req, res) => {
    const values = {};
    for (const b of (req.body.bindings || []).slice(0, 100)) { try { values[b] = await content.getBinding(b); } catch { values[b] = null; } }
    res.json({ values });
  }));
  api.post('/studio/upload', wrap(async (req, res) => {
    const r = await media.upload(req.body.name, req.body.dataUrl, user(req));
    await auth.audit(req, 'media_upload', r.path); res.json({ ok: true, path: r.url });
  }));
  // Classic overlay uploads: bind a new image to a field, or overwrite a fixed asset.
  api.post('/upload', wrap(async (req, res) => {
    const { name, dataUrl, binding, file } = req.body || {};
    if (file) {
      const p = 'src/assets/' + String(file).replace(/^\/+/, '');
      await media.replace(p, dataUrl, user(req)); return res.json({ ok: true, path: file });
    }
    if (!binding) return res.status(400).json({ error: 'no binding or file target' });
    const r = await media.upload(name, dataUrl, user(req));
    await content.applyEdits([{ binding, value: r.url }], user(req)); res.json({ ok: true, path: r.url });
  }));

  // ---------------------------------------------------------------- blog
  api.get('/blog', wrap(async (req, res) => res.json({ posts: (await content.readStore('blog')).posts || [] })));
  api.post('/blog', wrap(async (req, res) => {
    const { action } = req.body || {}; const blog = await content.readStore('blog'); const posts = (blog.posts = blog.posts || []);
    const clean = (p) => cleanDeep(p || {});
    if (action === 'create') posts.unshift(clean(req.body.post));
    else if (action === 'update') { const i = +req.body.index; if (!posts[i]) return res.status(404).json({ error: 'post not found' }); posts[i] = clean(req.body.post); }
    else if (action === 'delete') { const i = +req.body.index; if (!posts[i]) return res.status(404).json({ error: 'post not found' }); posts.splice(i, 1); }
    else if (action === 'reorder') { const o = req.body.order; if (!Array.isArray(o) || o.length !== posts.length) return res.status(400).json({ error: 'bad order' }); blog.posts = o.map((i) => posts[i]); }
    else return res.status(400).json({ error: `unknown blog action ${action}` });
    await content.saveStore('blog', blog, user(req)); await auth.audit(req, 'blog_' + action); res.json({ ok: true, posts: blog.posts });
  }));


  // ---------------------------------------------------------- blog posts
  // One Markdown file per article (content/posts/<slug>.md), staged as drafts
  // and published as a commit like any other content. See src/posts.js.
  api.get('/posts', wrap(async (req, res) => res.json({ posts: await posts.list(), categories: await posts.categories(), siteUrl: config.publicSiteUrl.replace(/\/+$/, '') })));
  api.get('/posts/item', wrap(async (req, res) => res.json({ post: await posts.get(String(req.query.slug || '')) })));
  api.get('/posts/slug-check', wrap(async (req, res) => {
    const slug = String(req.query.slug || '');
    const problem = await posts.slugProblem(slug);           // validates the format first
    if (problem) return res.json({ ok: false, problem });
    const taken = !!(await content.getText(`content/posts/${slug}.md`));
    res.json({ ok: !taken, problem: taken ? 'A post with that web address already exists.' : '' });
  }));
  api.post('/posts/save', wrap(async (req, res) => {
    const post = await posts.save(req.body || {}, user(req));
    await auth.audit(req, 'post_saved', post.slug); res.json({ ok: true, post });
  }));
  api.post('/posts/status', wrap(async (req, res) => {
    const post = await posts.setStatus(String((req.body || {}).slug || ''), (req.body || {}).status, user(req));
    await auth.audit(req, 'post_status', `${post.slug}:${post.status}`); res.json({ ok: true, post });
  }));
  api.post('/posts/delete', wrap(async (req, res) => {
    await posts.remove(String((req.body || {}).slug || ''), user(req));
    await auth.audit(req, 'post_deleted', String(req.body.slug)); res.json({ ok: true });
  }));
  api.post('/posts/discard', wrap(async (req, res) => {
    await posts.discard(String((req.body || {}).slug || ''), user(req));
    await auth.audit(req, 'post_discarded', String(req.body.slug)); res.json({ ok: true });
  }));
  api.post('/posts/preview', wrap(async (req, res) => res.json(previewPost((req.body || {}).body))));
  api.post('/posts/publish', wrap(async (req, res) => {
    let r;
    try { r = await posts.publish(String((req.body || {}).slug || ''), String((req.body || {}).message || ''), user(req)); }
    catch (e) { return res.status(e.status || 422).json({ error: e.message }); }
    await auth.audit(req, 'post_published', `${req.body.slug} (${r.files} file(s))`);
    res.json({ ok: true, ...r, steps: r.published ? ['Published to the repository.', 'The site rebuilds automatically; the post is live in a few minutes.'] : [r.message] });
  }));

  // -------------------------------------------------- drafts / publish / revisions
  api.get('/drafts', wrap(async (req, res) => res.json({ drafts: await content.listDrafts() })));
  api.post('/drafts/discard', wrap(async (req, res) => {
    await content.discardDrafts(Array.isArray(req.body.paths) ? req.body.paths : null); await auth.audit(req, 'drafts_discarded'); res.json({ ok: true });
  }));
  api.post('/publish', wrap(async (req, res) => {
    let r;
    try { r = await content.publish(user(req), String((req.body || {}).message || '')); }
    catch (e) { return res.status(422).json({ error: e.message }); }
    await auth.audit(req, 'publish', r.published ? `${r.files} files` : 'nothing');
    res.json({ ok: true, ...r, steps: r.published ? [`Published ${r.files} changed file(s) to the repository.`, 'The site rebuilds automatically; changes are live in a few minutes.'] : [r.message] });
  }));
  api.get('/revisions', wrap(async (req, res) => res.json({ revisions: await content.listRevisions(80) })));
  api.post('/revisions/restore', wrap(async (req, res) => {
    try { const n = await content.restoreRevision(Number(req.body.id), user(req)); await auth.audit(req, 'revision_restored', String(req.body.id)); res.json({ ok: true, files: n }); }
    catch (e) { res.status(404).json({ error: e.message }); }
  }));

  // --------------------------------------------------------------- media
  api.get('/media', wrap(async (req, res) => res.json(await media.list({ q: req.query.q, folder: req.query.folder, offset: +req.query.offset || 0, limit: Math.min(+req.query.limit || 60, 200) }))));
  api.post('/media/upload', wrap(async (req, res) => { const r = await media.upload(req.body.name, req.body.dataUrl, user(req)); await auth.audit(req, 'media_upload', r.path); res.json({ ok: true, ...r }); }));
  api.post('/media/replace', wrap(async (req, res) => { const r = await media.replace(req.body.path, req.body.dataUrl, user(req)); await auth.audit(req, 'media_replace', r.path); res.json({ ok: true, ...r }); }));
  api.post('/media/meta', wrap(async (req, res) => { await media.setMeta(req.body.path, req.body); res.json({ ok: true }); }));
  api.get('/media/refs', wrap(async (req, res) => res.json({ refs: await media.references(String(req.query.path || '')) })));
  api.post('/media/delete', wrap(async (req, res) => { const r = await media.remove(req.body.path, user(req)); await auth.audit(req, 'media_delete', req.body.path); res.json({ ok: true, ...r }); }));

  // ----------------------------------------------------------------- SEO
  const pagePath = (p) => { p = String(p || ''); if (!/^\/[A-Za-z0-9_\-./]*$/.test(p) || p.includes('..')) throw Object.assign(new Error('bad page path'), { status: 400 }); return p.endsWith('/') ? p : p + '/'; };
  api.get('/seo', wrap(async (req, res) => {
    const seo = await content.readStore('seo'); const pages = seo.pages || {};
    if (req.query.path) return res.json({ seo: pages[pagePath(req.query.path)] || {} });
    res.json({ pages });
  }));
  api.post('/seo', wrap(async (req, res) => {
    const p = pagePath(req.body.path); const b = req.body;
    const rec = {};
    if (b.title) rec.title = String(b.title).slice(0, 120);
    if (b.description) rec.description = String(b.description).slice(0, 320);
    if (b.canonical) { if (!/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_\-./%]*$/.test(String(b.canonical))) return res.status(400).json({ error: 'Canonical must be a full https:// URL.' }); rec.canonical = String(b.canonical); }
    if (b.og_image) { const u = cleanUrl(String(b.og_image)); if (!u) return res.status(400).json({ error: 'Invalid social image path.' }); rec.og_image = u; }
    if (b.noindex) rec.noindex = true;
    const seo = await content.readStore('seo'); seo.pages = seo.pages || {};
    if (Object.keys(rec).length) seo.pages[p] = rec; else delete seo.pages[p];
    await content.saveStore('seo', seo, user(req)); await auth.audit(req, 'seo_saved', p); res.json({ ok: true, seo: rec });
  }));

  // --------------------------------------------------- header / footer / menus
  const linkList = (v, max = 30) => {
    if (!Array.isArray(v) || v.length > max) throw Object.assign(new Error('Too many menu items.'), { status: 400 });
    return v.map((x) => {
      const label = String((x && x.label) || '').trim().slice(0, 60); if (!label) throw Object.assign(new Error('Every menu item needs a label.'), { status: 400 });
      const url = x.url === '' ? '' : cleanUrl(String(x.url || '')); if (url === '' && x.url !== '') throw Object.assign(new Error(`Invalid link for "${label}".`), { status: 400 });
      const o = { label, url }; if (x.dropdown === 'services') o.dropdown = 'services'; return o;
    });
  };
  api.get('/menus', wrap(async (req, res) => { const s = await content.readStore('site'); res.json({ nav: s.nav, footer: s.footer, social: s.social, contact: s.contact }); }));
  api.post('/menus', wrap(async (req, res) => {
    const s = await content.readStore('site'); const b = req.body || {};
    if (b.nav) { s.nav = s.nav || {}; if (b.nav.main) s.nav.main = linkList(b.nav.main, 12); if (b.nav.cta) { const l = linkList([b.nav.cta], 1)[0]; s.nav.cta = { label: l.label, url: l.url }; } }
    if (b.footer) { s.footer = s.footer || {}; for (const k of Object.keys(b.footer)) { if (!Array.isArray(s.footer[k])) continue; s.footer[k] = linkList(b.footer[k], 40); } }
    await content.saveStore('site', s, user(req)); await auth.audit(req, 'menus_saved'); res.json({ ok: true });
  }));

  // ---------------------------------------------------------- edit site
  api.post('/edit-site/refresh', auth.requireAdmin, wrap(async (req, res) => {
    try { res.json({ ok: true, status: await editsite.refresh() }); } catch (e) { res.status(502).json({ error: e.message }); }
  }));

  api.use((req, res) => res.status(404).json({ error: 'unknown endpoint' }));

  // -------------------------------------------------------------- pages
  const sendFile = (res, file) => { res.type(mime[path.extname(file)] || 'application/octet-stream'); res.send(fs.readFileSync(file)); };
  const gate = (req, res, next) => (req.session ? next() : res.redirect('/admin/login'));
  app.get('/admin/login', (req, res) => { res.set('Content-Security-Policy', ADMIN_CSP); sendFile(res, path.join(PUBLIC, 'admin', 'login.html')); });
  app.get('/admin/logout', wrap(async (req, res) => { await auth.destroySession(req); auth.setSessionCookie(res, '', 0); res.redirect('/admin/login'); }));
  app.get('/admin/assets/:f', (req, res) => { const f = path.join(PUBLIC, 'admin', path.basename(req.params.f)); fs.existsSync(f) ? sendFile(res, f) : res.status(404).end(); });
  app.get('/admin/overlay/:f', (req, res) => { const f = path.join(PUBLIC, 'studio', path.basename(req.params.f)); fs.existsSync(f) ? sendFile(res, f) : res.status(404).end(); });
  app.get(['/', '/admin', '/admin/'], gate, (req, res, next) => {
    if (req.path === '/' && 'studio' in req.query) return next();   // the visual editor's canvas of the home page
    res.set('Content-Security-Policy', ADMIN_CSP); sendFile(res, path.join(PUBLIC, 'admin', 'index.html')); });
  app.get('/studio', gate, (req, res) => { res.set('Content-Security-Policy', ADMIN_CSP); sendFile(res, path.join(PUBLIC, 'studio', 'studio.html')); });

  // Everything else is the site canvas (the editable build) - signed-in only.
  app.get('*', gate, wrap(async (req, res) => {
    let p = decodeURIComponent(req.path);
    if (/^\/(assets\/)?images\//.test(p)) {                       // staged (draft) images first
      const repoPath = 'src/assets/' + p.replace(/^\/assets\//, '/').replace(/^\//, '');
      const d = await db.one("SELECT data, kind FROM drafts WHERE path = ?", [repoPath]);
      if (d && d.kind === 'bin') { res.type(mime[path.extname(p)] || 'application/octet-stream'); return res.send(Buffer.from(d.data)); }
    }
    const file = editsite.safeFile(p);
    if (!file) {
      const nf = editsite.safeFile('404.html');
      if (nf && req.accepts('html')) return res.status(404).type('html').send(inject(fs.readFileSync(nf, 'utf8'), false));
      return res.status(404).type('text').send('not found');
    }
    if (path.extname(file) === '.html') {
      res.set('Content-Security-Policy', "frame-ancestors 'self'");
      const studioFrame = 'studio' in req.query;
      let html = fs.readFileSync(file, 'utf8');
      if (studioFrame) html = await overlayDrafts(html, repo);
      return res.type('html').send(inject(html, studioFrame));
    }
    sendFile(res, file);
  }));

  // JSON error handler: never leak stack traces.
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong. Your work has not been lost; try again.' : err.message, ...(err.refs ? { refs: err.refs } : {}) });
  });
  return app;
}

function inject(html, studioFrame) {
  const head = '<link rel="stylesheet" href="/admin/overlay/studio-frame.css">';
  const boot = '<script src="/admin/overlay/csrf.js"></script><script>window.__W4U_STUDIO__=true;</script><script src="/admin/overlay/studio-frame.js" defer></script>';
  if (!studioFrame) return html;
  return html.includes('</head>') ? html.replace('</head>', head + '</head>').replace('</body>', boot + '</body>') : html + boot;
}

async function main() {
  // Listen first: Hostinger gives the entry file ~3 s to call listen(), and the
  // database connection must not be allowed to eat into that.
  const app = createApp();
  app.listen(config.port, () => console.log(`Wash4You admin listening on :${config.port} (${config.repoDriver} repo, ${config.dbDriver} db)`));
  await db.init();
  await require('./schema').migrate();
}
// Hostinger loads the entry file through its own wrapper (require.main !== module),
// so start unless the test runner is only importing createApp.
if (require.main === module || !process.env.NODE_TEST_CONTEXT) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { createApp };
