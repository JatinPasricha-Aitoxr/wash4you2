'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test file gets its own temp repo + in-memory database.
async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w4u-cms-'));
  fs.mkdirSync(path.join(root, 'src/data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/assets/images/uploads'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/templates'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/data/about.json'), JSON.stringify({ hero: { eyebrow: 'About us', headline: 'Hello' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'src/data/site.json'), JSON.stringify({ nav: { main: [{ label: 'Home', url: '' }], cta: { label: 'Book', url: 'https://x.test' } }, footer: { explore: [{ label: 'Home', url: '' }] } }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'src/data/blog.json'), JSON.stringify({ posts: [{ title: 'A' }, { title: 'B' }] }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'src/data/home.json'), JSON.stringify({ banner: { img: 'images/used.png' } }) + '\n');
  fs.writeFileSync(path.join(root, 'src/assets/images/used.png'), PNG);
  fs.writeFileSync(path.join(root, 'src/assets/images/free.png'), PNG);
  process.env.DB_DRIVER = 'sqlite'; process.env.REPO_DRIVER = 'local'; process.env.LOCAL_REPO_DIR = root;
  process.env.SQLITE_FILE = ':memory:'; process.env.NODE_ENV = 'test'; process.env.EDIT_SITE_DIR = path.join(root, 'edit');
  const db = require('../src/db'); await db.init({ driver: 'sqlite', sqliteFile: ':memory:' });
  await require('../src/schema').migrate();
  const auth = require('../src/auth');
  await db.exec('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)', ['admin', auth.hashPassword('Correct-horse-9'), 'admin', Date.now()]);
  const { createApp } = require('../src/server');
  const server = await new Promise((r) => { const s = createApp().listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client(base);
  return { root, base, server, db, client, close: async () => { server.close(); await db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async req(method, url, body, { csrf = true, headers = {} } = {}) {
    const h = { 'Content-Type': 'application/json', Cookie: this.cookie, ...headers };
    if (csrf && this.csrf && method !== 'GET') h['X-CSRF-Token'] = this.csrf;
    const res = await fetch(this.base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (set.length) { const c = set.map((x) => x.split(';')[0]).join('; '); this.cookie = c; this.lastSetCookie = set.join('\n'); }
    let json = null; const text = await res.text(); try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(url, o) { return this.req('GET', url, undefined, o); }
  post(url, body, o) { return this.req('POST', url, body, o); }
  async login(user = 'admin', pass = 'Correct-horse-9') {
    const r = await this.post('/admin/api/login', { username: user, password: pass }, { csrf: false });
    if (r.json && r.json.csrf) this.csrf = r.json.csrf;
    return r;
  }
}
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;
module.exports = { boot, PNG, dataUrl, Client };
