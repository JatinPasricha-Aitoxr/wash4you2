'use strict';
// Studio widgets and styles: the Node preview must match the real site build, and the style
// validator must keep what the editor writes and refuse anything that is not a known value.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { renderBlock, BLOCK_TYPES } = require('../src/blocks');
const { validateStyles, validateBlocks } = require('../src/content');

const ROOT = path.join(__dirname, '..', '..');
const py = (code, input) => spawnSync('python3', ['-c', code], { cwd: ROOT, input, encoding: 'utf8', timeout: 60000 });
const havePython = py('import jinja2').status === 0;
const norm = (h) => h.replace(/&#34;/g, '&quot;').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();   // &#34; and &quot; are the same character

const FIXTURES = {
  button: { label: 'Book now', url: 'https://app.wash4you.in/x', kind: 'on-navy', align: 'left' },
  image: { image: 'images/a.webp', alt: 'Alt', caption: 'Cap', width: '480', align: 'right', url: '/pricing/' },
  features: { eyebrow: 'E', title: 'T <b>', columns: '4', items: [{ icon: '🧺', title: 'A & B', text: 'Text' }, { icon: '', title: 'C', text: '' }] },
  testimonials: { eyebrow: '', title: 'Say', items: [{ quote: 'Great "service"', name: 'Asha', detail: 'Sector 49' }, { quote: 'Fine', name: 'Ravi', detail: '' }] },
  columns: { eyebrow: '', title: 'Cols', columns: '3', items: [{ title: 'One', text: 'a' }, { title: '', text: 'b' }, { title: 'Three', text: 'c' }] },
  pricing: { eyebrow: '', title: 'Prices', note: 'GST extra', button_label: 'Book', button_url: '/contact-us/', items: [{ name: 'Shirt', note: 'steam', price: '₹69' }, { name: 'Suit', note: '', price: '₹399' }] },
  divider: { style: 'dots' },
};

test('every widget type the editor offers is known to the validator and has a preview', () => {
  for (const t of Object.keys(FIXTURES)) {
    assert.ok(BLOCK_TYPES.includes(t), t);
    assert.ok(renderBlock({ id: 'b1', type: t, props: FIXTURES[t] }).startsWith('<section'), t);
  }
  const ok = validateBlocks({ pages: { 'page:/': Object.keys(FIXTURES).map((t, i) => ({ id: 'w' + i, type: t, props: FIXTURES[t] })) } });
  assert.equal(ok.pages['page:/'].length, Object.keys(FIXTURES).length);
  assert.throws(() => validateBlocks({ pages: { 'page:/': [{ id: 'x', type: 'nope', props: {} }] } }));
});

test('the editor preview of each new widget matches the site build exactly', { skip: !havePython && 'python3 / jinja2 not available' }, () => {
  const script = `
import json, sys
sys.path.insert(0, 'src')
import studio
env = studio.make_env()
fx = json.load(sys.stdin)
print(json.dumps({t: studio.render_block(env, {"id": "b1", "type": t, "props": p}, "/", "/") for t, p in fx.items()}))`;
  const r = py(script, JSON.stringify(FIXTURES));
  assert.equal(r.status, 0, r.stderr);
  const site = JSON.parse(r.stdout);
  for (const t of Object.keys(FIXTURES)) {
    assert.equal(norm(renderBlock({ id: 'b1', type: t, props: FIXTURES[t] })), norm(site[t]), `preview differs from the site build for "${t}"`);
  }
});

test('script and handlers in widget text cannot reach the page', () => {
  const html = renderBlock({ id: 'b1', type: 'features', props: { title: '<img src=x onerror=alert(1)>', items: [{ icon: '<script>x</script>', title: '"><svg onload=1>', text: '<b onclick=1>t</b>' }] } });
  assert.ok(!/<script|onerror=|onload=|onclick=/i.test(html.replace(/&lt;[^&]*&gt;/g, '')), html);
});

test('style validation keeps the new section, text and global settings and refuses everything else', () => {
  const s = validateStyles({
    sections: { 'page:/': { a1: { bgImage: 'images/x.webp', bgOverlay: '40', gradFrom: '#112233', gradTo: '#445566', gradAngle: '90', marginTop: '-20', radius: '16', shadow: true, maxWidth: '900', minHeight: '300' } } },
    elements: { 'home:hero.title': { fontFamily: 'fraunces', lineHeight: '1.3', letterSpacing: '0.02em' } },
    global: { '--font-display': 'georgia', '--font-sans': 'url(javascript:x)', '--navy': '#0d2350', '--evil': 'red;background:url(x)' },
  });
  const a1 = s.sections['page:/'].a1;
  assert.equal(a1.bgImage, 'images/x.webp'); assert.equal(a1.shadow, true); assert.equal(a1.marginTop, '-20');
  assert.equal(s.elements['home:hero.title'].fontFamily, 'fraunces');
  assert.equal(s.global['--font-display'], 'georgia');
  assert.equal(s.global['--navy'], '#0d2350');
  assert.equal(s.global['--font-sans'], undefined, 'a font must be a known key, not CSS');
  assert.equal(s.global['--evil'], undefined);
});

test('the site build turns the new styles into safe CSS', { skip: !havePython && 'python3 / jinja2 not available' }, () => {
  const styles = {
    sections: { 'page:/': { a1: { color: '#ffffff', bgImage: 'images/x.webp', bgOverlay: '40', marginTop: '-20', radius: '16', shadow: true, maxWidth: '900', gradFrom: '#112233', gradTo: '#445566' },
                            a2: { gradFrom: '#112233', gradTo: '#445566', gradAngle: '90' }, a3: { bgImage: '../../etc/passwd' } } },
    elements: { 'home:hero.title': { fontFamily: 'fraunces', letterSpacing: '0.02em', color: '#fff' }, 'home:x': { fontFamily: 'evil;color:red' } },
    global: { '--font-display': 'georgia', '--font-sans': 'nope', '--navy': '#0d2350' },
  };
  const r = py(`import json,sys; sys.path.insert(0,'src'); import studio; print(studio.css(json.load(sys.stdin)))`, JSON.stringify(styles));
  assert.equal(r.status, 0, r.stderr);
  const css = r.stdout;
  assert.match(css, /--font-display:Georgia/); assert.ok(!css.includes('--font-sans'));
  assert.match(css, /\[data-sec="a1"\]\{[^}]*background-image:linear-gradient\(rgba\(11,30,60,0\.4\),rgba\(11,30,60,0\.4\)\),url\('\.\.\/images\/x\.webp'\)/);
  assert.match(css, /margin-top:-20px/); assert.match(css, /border-radius:16px/); assert.match(css, /overflow:hidden/); assert.match(css, /box-shadow:/);
  assert.match(css, /\[data-sec="a1"\] \.wrap\{max-width:900px/);
  assert.match(css, /\[data-sec="a2"\]\{[^}]*linear-gradient\(90deg,#112233,#445566\)/);
  assert.match(css, /\[data-sec="a1"\]\[data-block\] :is\(h1,h2,h3[^)]*\)\{color:inherit !important\}/);
  assert.ok(!css.includes('etc/passwd'), 'a path outside images/ must be dropped');
  assert.match(css, /\[data-sid="home:hero\.title"\]\{[^}]*font-family:'Fraunces'/);
  assert.ok(!css.includes('evil'), 'unknown font keys must be dropped');
});
