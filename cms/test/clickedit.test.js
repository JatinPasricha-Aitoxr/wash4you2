'use strict';
// Click-to-edit of existing page content (src/overrides.py) and the "where used?" search.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { boot, PNG } = require('./helper');

let env, c;
test.before(async () => { env = await boot(); c = env.client; await c.login(); });
test.after(async () => { await env.close(); });

const ROOT = path.join(__dirname, '..', '..');
const py = (code, input) => spawnSync('python3', ['-c', code], { cwd: ROOT, input, encoding: 'utf8', timeout: 60000 });
const havePython = py('import jinja2').status === 0;

const PAGE = '<html><head><title>t</title></head><body><header><a href="/">Home</a></header><main id="main"><section>'
  + '<ul><li><strong>5,000+</strong><span>Happy customers</span></li></ul>'
  + '<img src="assets/images/pricing/a.webp" alt="">'
  + '<h1>Premium <span class="accent">Laundry</span> in Gurgaon</h1>'
  + '<button class="q">Question text <span class="i"><svg><path d="M0 0"/></svg></span></button>'
  + '<p>Hello <b>big</b> <a href="/x">world</a></p><script>if (a<b && c>d) { x = "<p>no</p>"; }</script>'
  + '</section></main><footer><p>Footer words</p></footer></body></html>';

const run = (args) => {
  const script = `
import json, re, sys
sys.path.insert(0, 'src')
import overrides as o, studio
html, mode, ovr = json.load(sys.stdin)
edit = mode == 'edit'
out = o.process(html, 'index.html', edit, ovr, set(), studio.sanitize_html)
print(json.dumps(out))`;
  const r = py(script, JSON.stringify(args)); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
};

test('with no stored edits the live page is byte-identical to the template output', { skip: !havePython && 'python3 not available' }, () => {
  assert.equal(run([PAGE, 'live', { t: {}, i: {} }]), PAGE);
});

test('the editor build tags every text and image, including ones with no data field', { skip: !havePython && 'python3 not available' }, () => {
  const out = run([PAGE, 'edit', { t: {}, i: {} }]);
  const tags = [...out.matchAll(/data-cms="overrides:([ti])\.([a-z0-9-]+)\.([0-9a-f]{10})"/g)];
  assert.ok(tags.filter((t) => t[1] === 'i').length === 1, 'the image');
  const texts = out.match(/>(5,000\+|Happy customers|Premium|Laundry|in Gurgaon|Question text|Footer words|Home)</g) || [];
  assert.ok(texts.length >= 7, `expected the stats, headline pieces, the FAQ question and header/footer text to be tagged, got ${texts}`);
  assert.ok(!/overrides:t[^>]*>if \(a/.test(out), 'script code is never tagged');
  // header/footer are shared by every page, the rest belongs to the page
  assert.ok(tags.some((t) => t[2] === 'all') && tags.some((t) => t[2] === 'index-html'));
});

test('a stored edit replaces the text or image; markup, styling and the image path prefix are kept', { skip: !havePython && 'python3 not available' }, () => {
  const edit = run([PAGE, 'edit', { t: {}, i: {} }]);
  const key = (re) => (re.exec(edit) || [])[1];
  const stats = key(/data-cms="overrides:t\.index-html\.([0-9a-f]{10})"[^>]*>5,000\+/);
  const accent = key(/data-cms="overrides:t\.index-html\.([0-9a-f]{10})"[^>]*>Laundry/);
  const para = key(/data-cms="overrides:t\.index-html\.([0-9a-f]{10})"[^>]*>Hello/);
  const img = key(/data-cms="overrides:i\.index-html\.([0-9a-f]{10})"/);
  const live = run([PAGE, 'live', { t: { 'index-html': { [stats]: '9,999+', [accent]: 'Fresh <x>', [para]: '<!--rt--><b>New</b> <script>x</script>text' } }, i: { 'index-html': { [img]: 'images/cutouts/family.webp' } } }]);
  assert.match(live, /<li><strong>9,999\+<\/strong><span>Happy customers<\/span><\/li>/);
  assert.match(live, /<span class="accent">Fresh &lt;x&gt;<\/span>/, 'plain text is escaped and the span keeps its class');
  assert.match(live, /<p><b>New<\/b> xtext<\/p>/, 'rich text is sanitised: the script tag is gone, only its harmless text remains');
  assert.ok(!/<script>x/.test(live));
  assert.match(live, /<img src="assets\/images\/cutouts\/family\.webp"/, 'the assets/ prefix is preserved');
  assert.ok(live.includes('<svg><path'), 'the icon next to edited text is untouched');
  assert.ok(!live.includes('data-cms'), 'no editor markup in the live page');
  // an image path outside images/ is ignored
  const bad = run([PAGE, 'live', { t: {}, i: { 'index-html': { [img]: '../../etc/passwd' } } }]);
  assert.equal(bad, PAGE);
});

test('overrides can only be written through a strict path and value format', async () => {
  const save = (binding, value) => c.post('/admin/api/save', { edits: [{ binding, value }] });
  try {
    assert.equal((await save('overrides:t.index-html.0123456789', 'New text')).status, 200);
    assert.equal((await save('overrides:i.index-html.0123456789', 'images/uploads/x.webp')).status, 200);
    assert.equal((await save('overrides:i.index-html.0123456789', 'https://evil.test/x.png')).status, 400);
    assert.equal((await save('overrides:i.index-html.0123456789', '../../x.png')).status, 400);
    assert.equal((await save('overrides:t.index-html.nothex', 'x')).status, 400);
    assert.equal((await save('overrides:x.index-html.0123456789', 'x')).status, 400);
    assert.equal((await save('overrides:t.Index Html.0123456789', 'x')).status, 400);
    const r = await save('overrides:t.index-html.abcdef0123', '<b onclick=1>hi</b><script>x</script>');
    assert.equal(r.status, 200);
    const got = await env.db.one("SELECT content FROM drafts WHERE path = 'src/data/overrides.json'");
    const d = JSON.parse(got.content);
    assert.equal(d.t['index-html']['0123456789'], 'New text');
    assert.match(d.t['index-html'].abcdef0123, /^<!--rt--><b>hi<\/b>$/, 'markup is sanitised before it is stored');
  } finally { /* shared env is closed in test.after */ }
});

test('"where used?" is exact, covers blog posts and stylesheets, and names the page', async () => {
  const w = (rel, text) => { const f = path.join(env.root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  try {
    fs.mkdirSync(path.join(env.root, 'src/assets/images/pricing'), { recursive: true });
    for (const n of ['shirt', 't-shirt', 'sweatshirt']) fs.writeFileSync(path.join(env.root, `src/assets/images/pricing/${n}.webp`), PNG);
    fs.mkdirSync(path.join(env.root, 'src/assets/images/uploads'), { recursive: true });
    fs.writeFileSync(path.join(env.root, 'src/assets/images/uploads/cover.webp'), PNG);
    w('src/data/products/t-shirt.json', '{"img":"images/pricing/t-shirt.webp"}');
    w('src/data/products/sweatshirt.json', '{"img":"images/pricing/sweatshirt.webp"}');
    w('src/data/products/shirt.json', '{"img":"images/pricing/shirt.webp"}');
    w('content/posts/my-post.md', '---\ntitle: "My great post"\nimage: "images/uploads/cover.webp"\n---\nBody');
    w('src/assets/css/x.css', '.a{background:url(../images/pricing/shirt.webp)}');
    w('src/templates/page-home.html', '<img src="{{ asset_path }}images/pricing/{{ slug }}.webp">');
    const u = async (p) => (await c.get('/admin/api/media/refs?path=' + encodeURIComponent('src/assets/images/' + p))).json;
    const shirt = await u('pricing/shirt.webp');
    assert.deepEqual(shirt.refs.sort(), ['src/assets/css/x.css', 'src/data/products/shirt.json'], 'no false match on t-shirt or sweatshirt');
    assert.ok(shirt.details.some((d) => d.via === 'folder' && d.file === 'src/templates/page-home.html'), 'a template that picks images by name is flagged as a maybe');
    assert.ok(!shirt.refs.includes('src/templates/page-home.html'));
    assert.deepEqual((await u('pricing/t-shirt.webp')).refs, ['src/data/products/t-shirt.json']);
    const cover = await u('uploads/cover.webp');
    assert.deepEqual(cover.refs, ['content/posts/my-post.md']);
    assert.equal(cover.details[0].label, 'Blog post: My great post');
    assert.deepEqual(cover.details[0].pages, ['/my-post/']);
    // and a used cover can no longer be deleted
    assert.equal((await c.post('/admin/api/media/delete', { path: 'src/assets/images/uploads/cover.webp' })).status, 409);
  } finally { /* shared env is closed in test.after */ }
});
