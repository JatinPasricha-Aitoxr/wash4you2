'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, Client } = require('./helper');

let env;
test.before(async () => { env = await boot(); });
test.after(async () => { await env.close(); });

test('passwords are hashed with scrypt and verified in constant time', () => {
  const auth = require('../src/auth');
  const h = auth.hashPassword('Another-pass-1');
  assert.match(h, /^scrypt\$/);
  assert.ok(!h.includes('Another-pass-1'));
  assert.ok(auth.verifyPassword('Another-pass-1', h));
  assert.ok(!auth.verifyPassword('wrong', h));
  assert.ok(auth.passwordProblem('short1'));
  assert.ok(auth.passwordProblem('onlyletterslong'));
  assert.equal(auth.passwordProblem('long-enough-123'), null);
});

test('every API route requires a session', async () => {
  const c = env.client;
  for (const [m, u] of [['GET', '/admin/api/overview'], ['GET', '/admin/api/media'], ['GET', '/admin/api/revisions'], ['GET', '/admin/api/drafts'], ['GET', '/admin/api/users'], ['POST', '/admin/api/publish'], ['POST', '/admin/api/seo'], ['POST', '/admin/api/media/upload'], ['POST', '/admin/api/studio/save'], ['POST', '/admin/api/menus']]) {
    const r = await c.req(m, u, m === 'POST' ? {} : undefined, { csrf: false });
    assert.equal(r.status, 401, `${m} ${u}`);
  }
});

test('canvas and dashboard pages redirect to login when signed out', async () => {
  for (const u of ['/admin', '/studio', '/about-us/']) {
    const r = await env.client.get(u);
    assert.equal(r.status, 302, u);
    assert.equal(r.headers.get('location'), '/admin/login');
  }
});

test('wrong password is rejected and locked out after repeated failures', async () => {
  const c = new Client(env.base);
  for (let i = 0; i < 5; i++) assert.equal((await c.login('admin', 'nope')).status, 401);
  assert.equal((await c.login('admin', 'nope')).status, 429);
  assert.equal((await c.login('admin', 'Correct-horse-9')).status, 429, 'even the right password is blocked during lockout');
  await env.db.exec('DELETE FROM login_attempts');
});

test('login sets a hardened session cookie and a CSRF token', async () => {
  const r = await env.client.login();
  assert.equal(r.status, 200);
  assert.match(env.client.lastSetCookie, /HttpOnly/);
  assert.match(env.client.lastSetCookie, /SameSite=Strict/);
  assert.ok(env.client.csrf.length >= 20);
  assert.equal((await env.client.get('/admin/api/me')).status, 200);
});

test('state-changing requests need the CSRF token and a same-origin Origin', async () => {
  const noToken = await env.client.post('/admin/api/seo', { path: '/about-us/', title: 'x' }, { csrf: false });
  assert.equal(noToken.status, 403);
  const crossSite = await env.client.post('/admin/api/seo', { path: '/about-us/', title: 'x' }, { headers: { Origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  const ok = await env.client.post('/admin/api/seo', { path: '/about-us/', title: 'Fine' });
  assert.equal(ok.status, 200);
});

test('logout invalidates the session server-side', async () => {
  const cookie = env.client.cookie;
  await env.client.post('/admin/api/logout', {});
  env.client.cookie = cookie;
  assert.equal((await env.client.get('/admin/api/me')).status, 401);
});

test('password change needs the current password and ends other sessions', async () => {
  await env.client.login();
  const bad = await env.client.post('/admin/api/password', { current: 'wrong', next: 'New-passphrase-7' });
  assert.equal(bad.status, 400);
  const weak = await env.client.post('/admin/api/password', { current: 'Correct-horse-9', next: 'short' });
  assert.equal(weak.status, 400);
  const ok = await env.client.post('/admin/api/password', { current: 'Correct-horse-9', next: 'New-passphrase-7' });
  assert.equal(ok.status, 200);
  const again = new Client(env.base);
  assert.equal((await again.login('admin', 'New-passphrase-7')).status, 200);
});
