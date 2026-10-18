'use strict';
// Server-side preview renderer for Studio widgets. Mirrors src/templates/_blocks.html
// (the production renderer) so the editor canvas shows what will be published.
const sanitizeHtml = require('sanitize-html');
const { RT } = require('./content');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RT_OPTS = {
  allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'span', 'blockquote'],
  allowedAttributes: { a: ['href', 'target', 'rel'], span: ['style'] },
  allowedStyles: { span: { color: [/^#[0-9a-f]{3,8}$/i, /^rgb\([\d\s,]+\)$/] } },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
};
const out = (v) => (typeof v === 'string' && v.startsWith(RT) ? sanitizeHtml(v.slice(RT.length), RT_OPTS) : esc(v));
const href = (u, root) => {
  u = String(u || '').trim();
  return /^(https?:|tel:|mailto:|#)/i.test(u) ? u : root + u.replace(/^\/+/, '');
};
const btn = (label, url, root, kind = 'cta') => label
  ? `<a class="btn btn--${kind} btn--lg" href="${esc(href(url, root))}"${/^https?/i.test(String(url || '')) ? ' target="_blank" rel="noopener"' : ''}>${esc(label)}</a>` : '';
const PLUS = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

const R = {
  hero: (p, root, asset) => `<section class="section studio-block studio-hero" style="${p.image ? `background-image:linear-gradient(rgba(11,30,60,.62),rgba(11,30,60,.62)),url('${esc(asset + p.image)}');background-size:cover;background-position:center;` : ''}">
  <div class="wrap studio-hero__inner">
    ${p.eyebrow ? `<p class="eyebrow">${out(p.eyebrow)}</p>` : ''}
    <h2 class="studio-hero__title">${out(p.title || 'Your headline here')}</h2>
    ${p.text ? `<div class="studio-hero__text studio-body">${out(p.text)}</div>` : ''}
    ${p.button_label ? `<div class="studio-actions">${btn(p.button_label, p.button_url, root)}</div>` : ''}
  </div></section>`,
  heading: (p, root) => { const al = p.align || 'center'; return `<section class="section studio-block studio-text studio-text--${esc(al)}">
  <div class="wrap wrap--narrow">
    ${p.eyebrow ? `<p class="eyebrow${al === 'center' ? ' eyebrow--center' : ''}">${out(p.eyebrow)}</p>` : ''}
    <h2>${out(p.title || 'Add a heading')}</h2>
    ${p.text ? `<div class="studio-body">${out(p.text)}</div>` : ''}
    ${p.button_label ? `<div class="studio-actions">${btn(p.button_label, p.button_url, root)}</div>` : ''}
  </div></section>`; },
  image_text: (p, root, asset) => `<section class="section studio-block poster-feature"><div class="wrap">
  <div class="poster-feature__grid poster-feature__grid--${esc(p.side || 'left')}">
    <div class="poster-feature__art">${p.image ? `<img src="${esc(asset + p.image)}" alt="${esc(p.alt || p.title || '')}" loading="lazy" decoding="async">` : '<div class="studio-placeholder">Choose an image</div>'}</div>
    <div class="poster-feature__copy">
      ${p.eyebrow ? `<p class="eyebrow">${out(p.eyebrow)}</p>` : ''}
      <h2>${out(p.title || 'Add a heading')}</h2>
      ${p.text ? `<div class="poster-feature__lede studio-body">${out(p.text)}</div>` : ''}
      ${btn(p.button_label, p.button_url, root)}
    </div></div></div></section>`,
  gallery: (p, root, asset) => {
    const imgs = (p.images || []).filter((i) => i && i.src);
    const cols = Math.min(parseInt(p.columns, 10) || 3, 3);
    return `<section class="section studio-block photo-gallery"><div class="wrap">
  ${p.title || p.eyebrow ? `<div class="section-head section-head--center">${p.eyebrow ? `<p class="eyebrow eyebrow--center">${out(p.eyebrow)}</p>` : ''}${p.title ? `<h2>${out(p.title)}</h2>` : ''}</div>` : ''}
  <div class="photo-gallery__cols photo-gallery__cols--${cols}">${imgs.length ? imgs.map((im) => `<figure class="photo-gallery__item"><img src="${esc(asset + im.src)}" alt="${esc(im.alt || im.caption || '')}" loading="lazy" decoding="async">${im.caption ? `<figcaption>${out(im.caption)}</figcaption>` : ''}</figure>`).join('') : '<div class="studio-placeholder">Add images to this gallery</div>'}</div>
  </div></section>`;
  },
  cta: (p, root) => `<section class="section studio-block section--tight"><div class="wrap"><div class="cta-band">
  <h2>${out(p.title || 'Ready to book?')}</h2>
  ${p.text ? `<div class="studio-body">${out(p.text)}</div>` : ''}
  <div class="btn-row">${btn(p.button_label, p.button_url, root)}${btn(p.button2_label, p.button2_url, root, 'on-navy')}</div>
  </div></div></section>`,
  stats: (p) => `<section class="section studio-block stat-strip"><div class="wrap">
  ${p.lead ? `<p class="stat-strip__lead">${out(p.lead)}</p>` : ''}
  <ul class="stat-strip__list">${(p.items || []).map((it) => `<li><strong>${out(it.value)}</strong><span>${out(it.label)}</span></li>`).join('')}</ul>
  </div></section>`,
  faq: (p) => `<section class="section studio-block section--wash"><div class="wrap wrap--narrow">
  <div class="section-head section-head--center"><h2>${out(p.title || 'Frequently asked questions')}</h2></div>
  <div class="faq">${(p.items || []).map((f, i) => `<div class="faq-item"><button class="faq-item__question" type="button" aria-expanded="false" aria-controls="studio-faq-${i + 1}">${out(f.q)}<span class="faq-item__icon">${PLUS}</span></button><div class="faq-item__answer" id="studio-faq-${i + 1}" role="region"><div>${out(f.a)}</div></div></div>`).join('')}</div>
  </div></section>`,
  video: (p) => { const e = embed(p.url); return `<section class="section studio-block"><div class="wrap wrap--narrow">
  ${p.title ? `<div class="section-head section-head--center"><h2>${out(p.title)}</h2></div>` : ''}
  ${e ? `<div class="studio-video"><iframe src="${esc(e)}" title="${esc(p.title || 'Video')}" loading="lazy" allowfullscreen allow="accelerometer; encrypted-media; picture-in-picture"></iframe></div>` : '<div class="studio-placeholder">Paste a YouTube or Vimeo link</div>'}
  </div></section>`; },
  spacer: (p) => `<section class="studio-block studio-spacer" style="height:${Math.min(Math.max(parseInt(p.height, 10) || 48, 8), 400)}px" aria-hidden="true"></section>`,
  html: (p) => `<section class="section studio-block studio-html"><div class="wrap">${p.html || ''}</div></section>`,
};
function embed(url) {
  url = String(url || '').trim();
  let m = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/.exec(url);
  if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
  m = /vimeo\.com\/(?:video\/)?(\d+)/.exec(url);
  return m ? `https://player.vimeo.com/video/${m[1]}` : '';
}
function renderBlock(block, root = '/', asset = '/') {
  const fn = R[block.type];
  if (!fn) return '';
  let html = fn(block.props || {}, root, asset).trim();
  html = html.replace(/^<section\b/, `<section data-block="${esc(block.id)}" data-block-type="${esc(block.type)}"`);
  return html;
}
module.exports = { renderBlock, BLOCK_TYPES: Object.keys(R) };
