'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boot, PNG, dataUrl } = require('./helper');

let env, c;
test.before(async () => { env = await boot(); c = env.client; await c.login(); });
test.after(async () => { await env.close(); });
const repoJson = (p) => JSON.parse(fs.readFileSync(path.join(env.root, p), 'utf8'));

test('a text edit becomes a draft and does not touch the repo until publish', async () => {
  const r = await c.post('/admin/api/studio/save', { edits: [{ binding: 'about:hero.eyebrow', value: 'About Wash4You' }] });
  assert.equal(r.status, 200);
  assert.equal(repoJson('src/data/about.json').hero.eyebrow, 'About us');
  const b = await c.post('/admin/api/studio/bindings', { bindings: ['about:hero.eyebrow'] });
  assert.equal(b.json.values['about:hero.eyebrow'], 'About Wash4You');
  assert.equal((await c.get('/admin/api/drafts')).json.drafts.length, 1);
});

test('publish commits every draft, records a revision and clears drafts', async () => {
  const r = await c.post('/admin/api/publish', { message: 'First publish' });
  assert.equal(r.status, 200);
  assert.equal(r.json.files, 1);
  assert.equal(repoJson('src/data/about.json').hero.eyebrow, 'About Wash4You');
  assert.equal(repoJson('src/data/about.json').hero.headline, 'Hello', 'untouched fields survive');
  assert.equal((await c.get('/admin/api/drafts')).json.drafts.length, 0);
  const revs = (await c.get('/admin/api/revisions')).json.revisions;
  assert.ok(revs.some((x) => x.kind === 'publish' && x.message === 'First publish'));
  assert.equal((await c.post('/admin/api/publish', {})).json.published, false, 'publishing with no drafts is a no-op');
});

test('a revision can be restored as a draft, then published', async () => {
  await c.post('/admin/api/studio/save', { edits: [{ binding: 'about:hero.eyebrow', value: 'Second' }] });
  await c.post('/admin/api/publish', { message: 'Second' });
  assert.equal(repoJson('src/data/about.json').hero.eyebrow, 'Second');
  const first = (await c.get('/admin/api/revisions')).json.revisions.find((x) => x.message === 'First publish');
  const r = await c.post('/admin/api/revisions/restore', { id: first.id });
  assert.equal(r.status, 200);
  assert.equal(repoJson('src/data/about.json').hero.eyebrow, 'Second', 'restore alone changes nothing live');
  await c.post('/admin/api/publish', { message: 'Restore first' });
  assert.equal(repoJson('src/data/about.json').hero.eyebrow, 'About Wash4You');
  assert.equal((await c.post('/admin/api/revisions/restore', { id: 99999 })).status, 404);
});

test('a failed publish keeps the drafts so no work is lost', async () => {
  await c.post('/admin/api/studio/save', { edits: [{ binding: 'about:hero.headline', value: 'Keep me' }] });
  const repoMod = require('../src/repo');
  const orig = repoMod.create;
  const { Content } = require('../src/content');
  const failing = new Content({ read: async () => null, list: async () => [], commit: async () => { throw new Error('GitHub 502'); } });
  await assert.rejects(() => failing.publish(1, 'x'), /GitHub 502/);
  const drafts = (await c.get('/admin/api/drafts')).json.drafts;
  assert.equal(drafts.length, 1);
  await c.post('/admin/api/drafts/discard', {});
  assert.equal((await c.get('/admin/api/drafts')).json.drafts.length, 0);
  void orig;
});

test('rich text and custom HTML are sanitised before they are stored', async () => {
  const evil = '<!--rt--><p onclick="x()">Hi <script>alert(1)</script><a href="javascript:alert(1)">bad</a><b>ok</b></p>';
  await c.post('/admin/api/studio/save', { edits: [{ binding: 'about:hero.headline', value: evil }],
    blocks: { pages: { 'page:about-us/': [{ id: 'blk-abc123', type: 'html', props: { html: '<img src=x onerror=alert(1)><script>alert(2)</script><p>fine</p><iframe src="https://evil.test"></iframe>' } }] } } });
  const stored = (await c.post('/admin/api/studio/bindings', { bindings: ['about:hero.headline'] })).json.values['about:hero.headline'];
  assert.ok(!/script|onclick|javascript:/i.test(stored), stored);
  assert.ok(stored.includes('<b>ok</b>'));
  const blocks = (await c.get('/admin/api/studio/state')).json.blocks;
  const html = blocks.pages['page:about-us/'][0].props.html;
  assert.ok(!/script|onerror|iframe/i.test(html), html);
  assert.ok(html.includes('<p>fine</p>'));
  await c.post('/admin/api/drafts/discard', {});
});

test('layout, widgets and styles are validated', async () => {
  const bad = (body) => c.post('/admin/api/studio/save', body);
  const r1 = await bad({ blocks: { pages: { 'page:x/': [{ id: 'blk-1', type: 'evil', props: {} }] } } });
  assert.ok(r1.status >= 400, 'unknown widget type is refused');
  const r2 = await bad({ layout: { pages: { '../../etc/passwd': { order: [], hidden: [] } } } });
  assert.ok(r2.status >= 400, 'bad layout key is refused');
  const ok = await bad({ styles: { sections: { 'page:x/': { s1: { bg: '#fff', color: 'url(javascript:alert(1))', padTop: '20' } } }, elements: {}, global: { '--navy': '#123456', '--x': 'red;}body{display:none' } } });
  assert.equal(ok.status, 200);
  const st = (await c.get('/admin/api/studio/state')).json.styles;
  assert.equal(st.sections['page:x/'].s1.bg, '#fff');
  assert.equal(st.sections['page:x/'].s1.color, undefined, 'unsafe CSS value dropped');
  assert.equal(st.global['--navy'], '#123456');
  assert.equal(st.global['--x'], undefined);
  await c.post('/admin/api/drafts/discard', {});
});

test('only allow-listed stores and safe paths can be edited', async () => {
  for (const binding of ['secrets:token', 'about:../x', 'about:hero.__proto__.x', '../etc:passwd', 'noColon']) {
    const r = await c.post('/admin/api/studio/save', { edits: [{ binding, value: 'x' }] });
    assert.ok(r.status >= 400, binding);
  }
  const lay = await c.post('/admin/api/studio/save', { edits: [{ binding: 'layout:pages', value: {} }] });
  assert.ok(lay.status >= 400, 'layout must go through its validated endpoint');
});

test('drafts that are not valid JSON cannot be published', async () => {
  const { Content } = require('../src/content');
  const content = new Content(require('../src/repo').create());
  await content.saveDraftText('src/data/about.json', '{ not json', 1);
  const r = await c.post('/admin/api/publish', {});
  assert.equal(r.status, 422);
  await c.post('/admin/api/drafts/discard', {});
});

test('the repository adapter refuses paths outside content folders', async () => {
  const { assertWritable } = require('../src/repo');
  for (const p of ['../../.env', 'src/build.py', '.github/workflows/x.yml', 'cms/src/server.js', 'src/data/../../x.json', '/etc/passwd']) assert.throws(() => assertWritable(p), /not allowed/, p);
  assert.doesNotThrow(() => assertWritable('src/data/about.json'));
  assert.doesNotThrow(() => assertWritable('src/assets/images/uploads/x-1.png'));
});

test('SEO overrides are validated and stored per page', async () => {
  assert.equal((await c.post('/admin/api/seo', { path: '../x', title: 'a' })).status, 400);
  assert.equal((await c.post('/admin/api/seo', { path: '/about-us/', canonical: 'javascript:alert(1)' })).status, 400);
  const ok = await c.post('/admin/api/seo', { path: '/about-us', title: 'T', description: 'D', noindex: true });
  assert.equal(ok.status, 200);
  const got = await c.get('/admin/api/seo?path=/about-us/');
  assert.deepEqual(got.json.seo, { title: 'T', description: 'D', noindex: true });
  await c.post('/admin/api/seo', { path: '/about-us/' });
  assert.deepEqual((await c.get('/admin/api/seo?path=/about-us/')).json.seo, {});
  await c.post('/admin/api/drafts/discard', {});
});

test('menus reject unsafe links and keep the rest of the site settings', async () => {
  const bad = await c.post('/admin/api/menus', { nav: { main: [{ label: 'X', url: 'javascript:alert(1)' }] } });
  assert.equal(bad.status, 400);
  const ok = await c.post('/admin/api/menus', { nav: { main: [{ label: 'Home', url: '' }, { label: 'Pricing', url: 'pricing/' }] } });
  assert.equal(ok.status, 200);
  const m = (await c.get('/admin/api/menus')).json;
  assert.equal(m.nav.main.length, 2);
  assert.equal(m.nav.cta.label, 'Book', 'CTA untouched');
  await c.post('/admin/api/drafts/discard', {});
});

test('blog posts can be created, reordered and deleted as drafts', async () => {
  await c.post('/admin/api/blog', { action: 'create', post: { title: 'New <script>x</script>' } });
  let posts = (await c.get('/admin/api/blog')).json.posts;
  assert.equal(posts.length, 3);
  assert.equal((await c.post('/admin/api/blog', { action: 'reorder', order: [1, 0] })).status, 400);
  await c.post('/admin/api/blog', { action: 'delete', index: 0 });
  assert.equal((await c.get('/admin/api/blog')).json.posts.length, 2);
  await c.post('/admin/api/drafts/discard', {});
  void dataUrl; void PNG;
});

test('widget previews escape content and refuse unknown types', async () => {
  const r = await c.post('/admin/api/studio/render-block', { id: 'blk-1', type: 'heading', props: { title: '<img src=x onerror=alert(1)>', text: '<!--rt--><p>ok</p><script>x</script>' } });
  assert.equal(r.status, 200);
  assert.ok(!/<img src=x/.test(r.json.html) && !/<script/.test(r.json.html));
  assert.ok(r.json.html.includes('<p>ok</p>'));
  assert.equal((await c.post('/admin/api/studio/render-block', { type: 'nope', props: {} })).status, 400);
});
