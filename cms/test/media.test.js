'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, PNG, dataUrl } = require('./helper');

let env, c;
test.before(async () => { env = await boot(); c = env.client; await c.login(); });
test.after(async () => { await env.close(); });

test('valid images upload as drafts with unique names', async () => {
  const a = await c.post('/admin/api/media/upload', { name: 'Shop Front.PNG', dataUrl: dataUrl(PNG) });
  const b = await c.post('/admin/api/media/upload', { name: 'Shop Front.PNG', dataUrl: dataUrl(PNG) });
  assert.equal(a.status, 200);
  assert.match(a.json.path, /^src\/assets\/images\/uploads\/shop-front-[0-9a-f]{8}\.png$/);
  assert.notEqual(a.json.path, b.json.path);
  const list = (await c.get('/admin/api/media?q=shop')).json;
  assert.equal(list.total, 2);
  assert.ok(list.items.every((i) => i.draft));
  const served = await fetch(`${env.base}/${a.json.url}`, { headers: { Cookie: c.cookie } });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
});

test('uploads are validated by content, not by file name', async () => {
  const up = (name, buf, mime) => c.post('/admin/api/media/upload', { name, dataUrl: dataUrl(buf, mime) });
  assert.equal((await up('x.png', Buffer.from('<?php echo 1; ?>'.repeat(5)), 'image/png')).status, 415, 'not an image');
  assert.equal((await up('x.jpg', PNG, 'image/jpeg')).status, 415, 'png bytes named jpg');
  assert.equal((await up('evil.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')).status, 415);
  assert.equal((await up('onclick.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>'), 'image/svg+xml')).status, 415);
  assert.equal((await up('ok.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'), 'image/svg+xml')).status, 200);
  assert.equal((await c.post('/admin/api/media/upload', { name: 'a.png', dataUrl: 'not-a-data-url' })).status, 400);
  const big = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
  assert.equal((await up('big.png', big, 'image/png')).status, 413);
});

test('alt text is saved per image', async () => {
  const a = (await c.get('/admin/api/media?q=free')).json.items[0];
  assert.ok(a, 'seed image listed');
  await c.post('/admin/api/media/meta', { path: a.path, alt: 'A clean shirt' });
  assert.equal((await c.get('/admin/api/media?q=clean')).json.items[0].path, a.path, 'search finds alt text');
});

test('replacing keeps the same type and path', async () => {
  const p = 'src/assets/images/free.png';
  assert.equal((await c.post('/admin/api/media/replace', { path: p, dataUrl: dataUrl(Buffer.from('GIF89a' + 'x'.repeat(40)), 'image/gif') })).status >= 400 ? 400 : 200, 400);
  assert.equal((await c.post('/admin/api/media/replace', { path: p, dataUrl: dataUrl(PNG) })).status, 200);
  assert.equal((await c.post('/admin/api/media/replace', { path: '../../x.png', dataUrl: dataUrl(PNG) })).status, 400);
  assert.equal((await c.post('/admin/api/media/replace', { path: 'src/data/about.json', dataUrl: dataUrl(PNG) })).status, 400);
  await c.post('/admin/api/drafts/discard', {});
});

test('images used by content cannot be deleted', async () => {
  const r = await c.post('/admin/api/media/delete', { path: 'src/assets/images/used.png' });
  assert.equal(r.status, 409);
  assert.ok(r.json.refs.includes('src/data/home.json'));
  assert.ok(fs.existsSync(path.join(env.root, 'src/assets/images/used.png')));
});

test('unused images can be deleted, and the deletion is published', async () => {
  const r = await c.post('/admin/api/media/delete', { path: 'src/assets/images/free.png' });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(env.root, 'src/assets/images/free.png')), 'still there until publish');
  await c.post('/admin/api/publish', { message: 'Remove image' });
  assert.ok(!fs.existsSync(path.join(env.root, 'src/assets/images/free.png')));
});

test('draft uploads can be published into the repository', async () => {
  const up = await c.post('/admin/api/media/upload', { name: 'banner.png', dataUrl: dataUrl(PNG) });
  await c.post('/admin/api/publish', { message: 'Add banner' });
  assert.ok(fs.existsSync(path.join(env.root, up.json.path)));
});

test('path traversal never leaves the edit site', async () => {
  fs.mkdirSync(path.join(env.root, 'edit'), { recursive: true });
  fs.writeFileSync(path.join(env.root, 'edit/index.html'), '<html><head></head><body>ok</body></html>');
  fs.writeFileSync(path.join(env.root, 'secret.txt'), 'nope');
  for (const u of ['/..%2Fsecret.txt', '/%2e%2e/secret.txt', '/..%2f..%2fsecret.txt']) {
    const r = await fetch(env.base + u, { headers: { Cookie: c.cookie } });
    assert.ok(!(await r.text()).includes('nope'), u);
  }
});
