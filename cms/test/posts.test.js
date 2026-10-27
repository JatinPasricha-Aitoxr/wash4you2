'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { boot, PNG, dataUrl } = require('./helper');

let env, c, posts;
test.before(async () => {
  env = await boot(); c = env.client; await c.login();
  posts = require('../src/posts');   // after boot(): config reads the test environment when first required
  fs.mkdirSync(path.join(env.root, 'about-us'), { recursive: true });        // an existing site page
  fs.mkdirSync(path.join(env.root, 'laundry-service-noida'), { recursive: true });
});
test.after(async () => { await env.close(); });

const BODY = '## Why it matters\n\nSilk needs gentle care, and these tips keep it soft for years.\n\n- Use cool water\n- Dry in the shade\n\n## Quick checklist\n\n1. Read the label\n2. Wash gently';
const good = (o = {}) => ({
  isNew: true, slug: 'silk-care-tips', title: 'Silk care: 5 tips', date: '2026-10-25',
  excerpt: 'Five simple tips to keep silk soft and bright.', meta_description: '', category: 'Silk care',
  author: '', image: '', status: 'published', body: BODY, ...o,
});
const inRepo = (p) => fs.existsSync(path.join(env.root, p));
const readRepo = (p) => fs.readFileSync(path.join(env.root, p), 'utf8');

test('every blog endpoint needs a signed-in session, and writes need the CSRF token', async () => {
  const anon = new (require('./helper').Client)(env.base);
  for (const [m, u] of [['GET', '/admin/api/posts'], ['GET', '/admin/api/posts/item?slug=x'], ['POST', '/admin/api/posts/save'],
    ['POST', '/admin/api/posts/publish'], ['POST', '/admin/api/posts/delete'], ['POST', '/admin/api/posts/preview'], ['POST', '/admin/api/posts/status']]) {
    assert.equal((await anon.req(m, u, m === 'POST' ? {} : undefined, { csrf: false })).status, 401, `${m} ${u}`);
  }
  const noCsrf = await c.post('/admin/api/posts/save', good(), { csrf: false });
  assert.equal(noCsrf.status, 403, 'a signed-in request without the CSRF token is refused');
  assert.equal(inRepo('content/posts/silk-care-tips.md'), false);
});

test('saving a new post stages a draft; nothing reaches the repository until it is published', async () => {
  const r = await c.post('/admin/api/posts/save', good());
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.post.state, 'new');
  assert.equal(inRepo('content/posts/silk-care-tips.md'), false);
  const list = (await c.get('/admin/api/posts')).json.posts;
  assert.equal(list.length, 1);
  assert.equal(list[0].state, 'new');
  assert.equal(list[0].title, 'Silk care: 5 tips');
  const got = (await c.get('/admin/api/posts/item?slug=silk-care-tips')).json.post;
  assert.equal(got.body.trim(), BODY.trim());
  assert.equal(got.category, 'Silk care');
  assert.equal((await c.get('/admin/api/drafts')).json.drafts.some((d) => d.path === 'content/posts/silk-care-tips.md'), true);
});

test('the same address cannot be created twice, and reserved or existing page addresses are refused', async () => {
  assert.equal((await c.post('/admin/api/posts/save', good())).status, 409, 'duplicate of a draft');
  for (const slug of ['pricing', 'admin', 'blog', 'about-us', 'laundry-service-delhi', 'carpet-cleaning-mg-road']) {
    const r = await c.post('/admin/api/posts/save', good({ slug, title: 'Another one' }));
    assert.equal(r.status, 400, slug);
    assert.match(r.json.error, /reserved|already used/i, slug);
  }
  assert.equal((await c.get('/admin/api/posts/slug-check?slug=about-us')).json.ok, false);
  assert.equal((await c.get('/admin/api/posts/slug-check?slug=fresh-address')).json.ok, true);
});

test('invalid input is rejected with a plain message and nothing is staged', async () => {
  const before = (await c.get('/admin/api/drafts')).json.drafts.length;
  const cases = [
    [{ slug: 'Bad Slug!' }, /web address/], [{ slug: '../etc/passwd' }, /web address/], [{ slug: 'ab' }, /web address/],
    [{ title: 'x' }, /title/], [{ title: 'T'.repeat(141) }, /title/], [{ date: '2026-13-45' }, /date/], [{ date: 'tomorrow' }, /date/],
    [{ excerpt: 'short' }, /summary/], [{ category: '<script>' }, /topic/], [{ image: '../../etc/passwd' }, /cover image/],
    [{ image: 'https://evil.example/x.png' }, /cover image/], [{ image: 'images/x.html' }, /cover image/], [{ body: 'tiny' }, /Write the article/],
    [{ body: 'a'.repeat(60001) }, /too long/],
  ];
  for (const [over, re] of cases) {
    const r = await c.post('/admin/api/posts/save', good({ slug: 'valid-slug', title: 'A fine title', ...over }));
    assert.equal(r.status, 400, JSON.stringify(over).slice(0, 60));
    assert.match(r.json.error, re, JSON.stringify(over).slice(0, 60));
  }
  assert.equal((await c.get('/admin/api/drafts')).json.drafts.length, before);
});

test('the preview escapes HTML and cannot be used to inject script or attributes', async () => {
  const evil = [
    '<script>alert(1)</script> **bold**',
    '[x](javascript:alert(1)) [y](https://a.com/"onmouseover="alert(1))',
    '![a" onerror="alert(1)](images/x.webp) ![b](javascript:alert(1)) ![c](images/../secret.png)',
    '<img src=x onerror=alert(1)>',
  ].join('\n\n');
  const r = (await c.post('/admin/api/posts/preview', { body: evil })).json;
  // Parse the output like a browser would and look at the attributes that really exist.
  const { Parser } = require('htmlparser2');
  const tags = [];
  new Parser({ onopentag: (name, attribs) => tags.push({ name, attribs }) }, { decodeEntities: true }).end(r.html);
  assert.ok(tags.length > 0);
  assert.ok(!tags.some((t) => t.name === 'script' || t.name === 'iframe' || t.name === 'style'), 'no script/iframe/style element');
  for (const t of tags) {
    for (const [k, v] of Object.entries(t.attribs)) {
      assert.ok(!/^on/i.test(k), `no event-handler attribute (<${t.name} ${k}>)`);
      if (k === 'href' || k === 'src') assert.ok(!/^\s*(javascript|data|vbscript):/i.test(v), `no script url in ${k}`);
    }
  }
  const a = tags.filter((t) => t.name === 'a');
  assert.ok(a.every((t) => Object.keys(t.attribs).every((k) => ['href', 'target', 'rel'].includes(k))), 'links carry only href/target/rel');
  assert.ok(a.some((t) => /%22onmouseover/.test(t.attribs.href)), 'the quote in the address was neutralised');
  assert.ok(/<strong>bold<\/strong>/.test(r.html), 'normal markdown still renders');
  assert.ok(Array.isArray(r.toc) && typeof r.readMinutes === 'number');
});

test('publishing one post commits just that post and leaves other drafts alone', async () => {
  await c.post('/admin/api/studio/save', { edits: [{ binding: 'about:hero.eyebrow', value: 'Staged, unrelated' }] });
  const r = await c.post('/admin/api/posts/publish', { slug: 'silk-care-tips' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.published, true);
  assert.equal(r.json.files, 1);
  assert.ok(inRepo('content/posts/silk-care-tips.md'));
  const text = readRepo('content/posts/silk-care-tips.md');
  assert.match(text, /^---\ntitle: "Silk care: 5 tips"\n/);
  assert.match(text, /status: "published"/);
  assert.ok(text.includes('## Why it matters'));
  const drafts = (await c.get('/admin/api/drafts')).json.drafts.map((d) => d.path);
  assert.deepEqual(drafts, ['src/data/about.json'], 'the unrelated draft is still staged');
  assert.equal(JSON.parse(readRepo('src/data/about.json')).hero.eyebrow, 'About us', 'and was not published');
  const item = (await c.get('/admin/api/posts')).json.posts[0];
  assert.equal(item.state, 'live');
  assert.ok((await c.get('/admin/api/revisions')).json.revisions.some((x) => x.kind === 'publish' && /Publish post/.test(x.message)));
  assert.equal((await c.post('/admin/api/posts/publish', { slug: 'silk-care-tips' })).json.published, false, 'nothing left to publish');
  await c.post('/admin/api/drafts/discard', {});
});

test('a new cover image and body images are published together with the post that uses them', async () => {
  const up = (await c.post('/admin/api/media/upload', { name: 'cover.png', dataUrl: dataUrl(PNG) })).json;
  const inline = (await c.post('/admin/api/media/upload', { name: 'inline.png', dataUrl: dataUrl(PNG) })).json;
  const spare = (await c.post('/admin/api/media/upload', { name: 'spare.png', dataUrl: dataUrl(PNG) })).json;
  await c.post('/admin/api/posts/save', good({ slug: 'with-pictures', title: 'With pictures', image: up.url, body: `${BODY}\n\n![A folded shirt](${inline.url})` }));
  const r = await c.post('/admin/api/posts/publish', { slug: 'with-pictures' });
  assert.equal(r.json.files, 3, 'post + cover + inline image');
  assert.ok(inRepo(up.path) && inRepo(inline.path));
  assert.equal(inRepo(spare.path), false, 'an unrelated uploaded image stays a draft');
  assert.match(readRepo('content/posts/with-pictures.md'), new RegExp(`image: "${up.url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`));
  await c.post('/admin/api/drafts/discard', {});
});

test('editing a published post shows as edited; saving identical content leaves no draft; unmanaged front matter survives', async () => {
  fs.mkdirSync(path.join(env.root, 'content/posts'), { recursive: true });
  fs.writeFileSync(path.join(env.root, 'content/posts/legacy-post.md'),
    '---\ntitle: "Legacy post"\ndate: "June 08, 2026"\nexcerpt: "An older article written before the admin existed."\ncategory: "Care guides"\ncover_service_slug: "wet-cleaning"\nlegacy_url: "https://wash4you.in/legacy-post/"\nstatus: "published"\n---\n\nThe original body of the legacy post, long enough to be valid content here.\n');
  const g = (await c.get('/admin/api/posts/item?slug=legacy-post')).json.post;
  assert.equal(g.date, '2026-06-08', 'an old "Month D, YYYY" date is shown as a date');
  assert.equal(g.state, 'live');
  // No change -> serialise identically? The file is hand-written, so a draft is created; the next publish rewrites it in the standard form.
  const r = await c.post('/admin/api/posts/save', { ...g, isNew: false, title: 'Legacy post (updated)' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.post.state, 'edited');
  await c.post('/admin/api/posts/publish', { slug: 'legacy-post' });
  const text = readRepo('content/posts/legacy-post.md');
  assert.match(text, /cover_service_slug: "wet-cleaning"/, 'keys the editor does not manage are kept');
  assert.match(text, /legacy_url: "https:\/\/wash4you.in\/legacy-post\/"/);
  assert.match(text, /title: "Legacy post \(updated\)"/);
  const again = (await c.get('/admin/api/posts/item?slug=legacy-post')).json.post;
  const same = await c.post('/admin/api/posts/save', { ...again, isNew: false });
  assert.equal(same.json.post.state, 'live', 'saving the same content again leaves no draft behind');
  assert.equal((await c.get('/admin/api/drafts')).json.drafts.length, 0);
});

test('unpublish hides a post without deleting it, and publishing the change takes it off the site', async () => {
  const r = await c.post('/admin/api/posts/status', { slug: 'silk-care-tips', status: 'draft' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.post.status, 'draft');
  assert.match(readRepo('content/posts/silk-care-tips.md'), /status: "published"/, 'still live until published');
  await c.post('/admin/api/posts/publish', { slug: 'silk-care-tips' });
  assert.match(readRepo('content/posts/silk-care-tips.md'), /status: "draft"/);
  const back = await c.post('/admin/api/posts/status', { slug: 'silk-care-tips', status: 'published' });
  assert.equal(back.json.post.status, 'published');
  await c.post('/admin/api/posts/publish', { slug: 'silk-care-tips' });
  assert.match(readRepo('content/posts/silk-care-tips.md'), /status: "published"/);
});

test('deleting stages a removal that only takes effect on publish; a never-published draft is simply dropped', async () => {
  assert.equal((await c.post('/admin/api/posts/delete', { slug: 'silk-care-tips' })).status, 200);
  assert.ok(inRepo('content/posts/silk-care-tips.md'), 'file stays until the deletion is published');
  assert.equal((await c.get('/admin/api/posts')).json.posts.find((p) => p.slug === 'silk-care-tips').state, 'deleting');
  const r = await c.post('/admin/api/posts/publish', { slug: 'silk-care-tips' });
  assert.equal(r.json.published, true);
  assert.equal(inRepo('content/posts/silk-care-tips.md'), false);
  await c.post('/admin/api/posts/save', good({ slug: 'never-live', title: 'Never live' }));
  await c.post('/admin/api/posts/delete', { slug: 'never-live' });
  assert.equal((await c.get('/admin/api/posts')).json.posts.some((p) => p.slug === 'never-live'), false);
  assert.equal((await c.get('/admin/api/drafts')).json.drafts.length, 0);
});

test('titles with colons, quotes, hashes and non-latin text survive a save and reload unchanged', async () => {
  const titles = ['Silk: the "complete" guide', '# Not a comment', 'yes', "It's 100% — सिल्क की देखभाल", 'Line one\\ntwo'];
  for (const [i, title] of titles.entries()) {
    const slug = `round-trip-${i}`;
    const r = await c.post('/admin/api/posts/save', good({ slug, title, excerpt: `Excerpt with: colon, "quotes" and # hash number ${i}.` }));
    assert.equal(r.status, 200, r.text);
    const g = (await c.get(`/admin/api/posts/item?slug=${slug}`)).json.post;
    assert.equal(g.title, title.replace(/\s+/g, ' ').trim());
    assert.equal(g.excerpt, `Excerpt with: colon, "quotes" and # hash number ${i}.`);
  }
  await c.post('/admin/api/drafts/discard', {});
});

test('front matter written by the admin always parses back to the same values', () => {
  const meta = { title: 'A: "tricky" \\ title', date: '2026-10-25', excerpt: 'x: y # z', category: 'Care guides', status: 'published', legacy_url: 'https://wash4you.in/x/' };
  const back = posts.parse(posts.serialize(meta, 'Body text here.'));
  assert.deepEqual(back.meta, meta);
  assert.equal(back.body.trim(), 'Body text here.');
});

// ---- the preview must render exactly what the real build renders ----
const py = (code) => spawnSync('python3', ['-c', code], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 60000 });
const havePython = (() => { const r = py('import sys; sys.path.insert(0, "src"); import build; print("ok")'); return r.status === 0 && /ok/.test(r.stdout); })();

test('the editor preview renders the same HTML and contents list as the site build', { skip: !havePython && 'python3 / jinja2 not available' }, () => {
  const fixtures = [
    BODY,
    '# Top heading\n\n### Third level\n\nPlain paragraph with **bold**, *italic* and a [link](/pricing/) plus [ext](https://example.com/a?b=1&c=2).',
    '> A quote line\n\n---\n\n1) one\n2) two\n\n* star\n+ plus',
    '![Alt text](images/uploads/x-1a2b.webp) and ![ext](https://cdn.example.com/a.png) and ![bad](javascript:alert(1))',
    '<script>alert(1)</script> & < > "quotes" \'single\'',
    '## Repeat\n\ntext\n\n## Repeat\n\ntext\n\n## Repeat!',
    'Tricky [x](https://a.com/"onmouseover="alert(1)) and *a*b* and 2 * 3 * 4 and snake_case_word',
    'Line one\nline two of the same paragraph\n\nNew paragraph',
    'Unicode: *café* और **हिंदी** [लिंक](/services/)',
  ];
  const script = `
import sys, json
sys.path.insert(0, "src")
import build
out = []
for t in json.loads(sys.stdin.read()):
    html, toc = build.render_post_markdown(t)
    out.append({"html": html, "toc": toc})
print(json.dumps(out))`;
  const r = spawnSync('python3', ['-c', script], { cwd: path.join(__dirname, '..', '..'), input: JSON.stringify(fixtures), encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  const want = JSON.parse(r.stdout);
  fixtures.forEach((f, i) => {
    const got = posts.renderMarkdown(f);
    assert.equal(got.html, want[i].html, `html differs for fixture ${i}:\n${f}`);
    assert.deepEqual(got.toc, want[i].toc, `toc differs for fixture ${i}`);
  });
});

test('a post written by the admin is accepted by the real site build', { skip: !havePython && 'python3 / jinja2 not available' }, async () => {
  const r = await c.post('/admin/api/posts/save', good({ slug: 'build-compat', title: 'Build: compat "check"', excerpt: 'Checks the real build reads it.', category: 'Care guides', image: 'images/used.png' }));
  assert.equal(r.status, 200, r.text);
  await c.post('/admin/api/posts/publish', { slug: 'build-compat' });
  const script = `
import sys, json
from pathlib import Path
sys.path.insert(0, "src")
import build
posts = build.load_posts(Path(${JSON.stringify(path.join(env.root, 'content/posts'))}), "https://wash4you.in")
print(json.dumps([{k: p[k] for k in ("slug", "title", "date_iso", "excerpt", "category", "image", "url", "read_minutes")} for p in posts]))`;
  const out = spawnSync('python3', ['-c', script], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 60000 });
  assert.equal(out.status, 0, out.stderr);
  const built = JSON.parse(out.stdout).find((p) => p.slug === 'build-compat');
  assert.ok(built, 'the build found the post');
  assert.equal(built.title, 'Build: compat "check"');
  assert.equal(built.date_iso, '2026-10-25');
  assert.equal(built.category, 'Care guides');
  assert.equal(built.image, 'images/used.png');
  assert.equal(built.url, 'https://wash4you.in/build-compat/');
});

test('a broken post file is skipped by the build instead of stopping the whole site', { skip: !havePython && 'python3 / jinja2 not available' }, () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'w4u-posts-'));
  fs.writeFileSync(path.join(dir, 'broken.md'), '---\ntitle: "unterminated\nstatus: [oops\n---\nbody');
  fs.writeFileSync(path.join(dir, 'untitled.md'), '---\nstatus: "published"\n---\nbody here');
  fs.writeFileSync(path.join(dir, 'fine.md'), '---\ntitle: "Fine"\ndate: "2026-10-25"\nexcerpt: "ok"\nstatus: "published"\n---\n\nA fine post body.');
  const script = `
import sys, json
from pathlib import Path
sys.path.insert(0, "src")
import build
print(json.dumps([p["slug"] for p in build.load_posts(Path(${JSON.stringify(dir)}), "https://wash4you.in")]))`;
  const out = spawnSync('python3', ['-c', script], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 60000 });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim().split('\n').pop()), ['fine']);
  assert.match(out.stdout, /WARNING: skipping post broken\.md/);
  assert.match(out.stdout, /WARNING: skipping post untitled\.md/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('discard reverts edits to the live version, cancels a staged deletion and drops a never-published draft', async () => {
  await c.post('/admin/api/posts/save', good({ slug: 'discard-me', title: 'Discard me' }));
  await c.post('/admin/api/posts/publish', { slug: 'discard-me' });
  const live = readRepo('content/posts/discard-me.md');
  const g = (await c.get('/admin/api/posts/item?slug=discard-me')).json.post;
  await c.post('/admin/api/posts/save', { ...g, isNew: false, title: 'Changed my mind' });
  assert.equal((await c.get('/admin/api/posts')).json.posts.find((p) => p.slug === 'discard-me').state, 'edited');
  assert.equal((await c.post('/admin/api/posts/discard', { slug: 'discard-me' })).status, 200);
  assert.equal((await c.get('/admin/api/posts/item?slug=discard-me')).json.post.title, 'Discard me', 'back to the live title');
  assert.equal(readRepo('content/posts/discard-me.md'), live, 'the repository was never touched');
  await c.post('/admin/api/posts/delete', { slug: 'discard-me' });
  assert.equal((await c.get('/admin/api/posts')).json.posts.find((p) => p.slug === 'discard-me').state, 'deleting');
  await c.post('/admin/api/posts/discard', { slug: 'discard-me' });
  assert.equal((await c.get('/admin/api/posts')).json.posts.find((p) => p.slug === 'discard-me').state, 'live', 'deletion cancelled');
  await c.post('/admin/api/posts/save', good({ slug: 'only-a-draft', title: 'Only a draft' }));
  await c.post('/admin/api/posts/discard', { slug: 'only-a-draft' });
  assert.equal((await c.get('/admin/api/posts')).json.posts.some((p) => p.slug === 'only-a-draft'), false);
  assert.equal((await c.post('/admin/api/posts/discard', { slug: '../x' })).status, 404);
});

test('the address check validates the format before it looks anything up', async () => {
  for (const bad of ['../../etc/passwd', 'A B', 'x/y', '%2e%2e', '']) {
    const r = await c.get('/admin/api/posts/slug-check?slug=' + encodeURIComponent(bad));
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false, JSON.stringify(bad));
    assert.ok(r.json.problem, JSON.stringify(bad));
  }
});

test('without the yaml package the admin still reads and writes its own front matter', () => {
  const meta = { title: 'A: "tricky" \\ title', date: '2026-10-25', excerpt: 'x: y # z', category: 'Care guides', status: 'published', image: 'images/a.webp' };
  const text = posts.serialize(meta, 'Body.');
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)[1];
  assert.deepEqual(posts.parseLite(fm), meta, 'round-trips through the built-in reader');
  assert.deepEqual(posts.parseLite('title: Plain title\nexcerpt: folded\n  across two lines\nstatus: published'), { title: 'Plain title', excerpt: 'folded across two lines', status: 'published' });
  assert.throws(() => posts.parseLite('title: ok\n- not a key'), /unsupported/);
});
