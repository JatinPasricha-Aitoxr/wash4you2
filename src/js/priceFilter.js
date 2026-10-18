/* ============================================================================
 * src/js/priceFilter.js
 *
 * Live filter for the pricing page's 58 item cards, plus the category chips.
 *
 * The finder markup ships with `hidden` on it and is only revealed here. With
 * no JS a search box that does nothing is worse than no search box, and the
 * chips are plain anchors so they would still work — but showing half a
 * control is the wrong compromise. All or nothing.
 *
 * What it does:
 *   - filters cards by name as you type, across every category at once,
 *   - hides a whole category section when nothing in it matches,
 *   - announces the count through aria-live so it is not a purely visual
 *     result,
 *   - marks the chip for the category you are currently looking at.
 *
 * Deliberately NOT a fuzzy search. On a price list, "sar" should find "Saree"
 * and nothing else; a fuzzy matcher would surface "Sports Shoes" for that and
 * make the list feel broken.
 * ========================================================================== */

let teardown = null;

const norm = (s) => (s || '').toLowerCase().trim();

// "pants" has to find "Pant/Trouser": strip a plural 's' and require every
// typed word to appear, with a few everyday synonyms.
const ALIASES = { pants: ['pant', 'trouser'], trousers: ['pant', 'trouser'], tee: ['t-shirt'], tshirt: ['t-shirt'], suits: ['suit'], rug: ['carpet'], rugs: ['carpet'], shoes: ['shoe', 'sneaker'] };
const stem = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const matches = (text, q) =>
  q.split(/\s+/).every((w) => {
    const forms = ALIASES[w] || [w, stem(w)];
    return forms.some((f) => text.includes(f));
  });

export function initPriceFilter() {
  if (teardown) teardown();
  if (typeof document === 'undefined') return (teardown = () => {});

  const finder = document.querySelector('[data-price-finder]');
  if (!finder) return (teardown = () => {});

  const input = finder.querySelector('[data-price-search]');
  const clear = finder.querySelector('[data-price-clear]');
  const count = finder.querySelector('[data-price-count]');
  const chips = Array.from(finder.querySelectorAll('.price-chip'));
  const cats = Array.from(document.querySelectorAll('[data-price-cat]'));
  const cards = Array.from(document.querySelectorAll('[data-price-item]'));
  if (!input || !cards.length) return (teardown = () => {});

  // Cache the searchable string once rather than reading the DOM per keystroke.
  const index = cards.map((card) => ({
    el: card,
    text: norm(card.getAttribute('data-name') + ' ' + card.getAttribute('data-slug')),
  }));

  finder.hidden = false;

  const apply = () => {
    const q = norm(input.value);
    let shown = 0;

    index.forEach(({ el, text }) => {
      const hit = !q || matches(text, q);
      el.hidden = !hit;
      if (hit) shown++;
    });

    // A category with no surviving cards is noise: hide the whole band, not
    // just its grid, or the page fills with empty headings.
    cats.forEach((cat) => {
      const any = Array.from(cat.querySelectorAll('[data-price-item]')).some((c) => !c.hidden);
      cat.hidden = !!q && !any;
      const empty = cat.querySelector('[data-price-empty]');
      if (empty) empty.hidden = true;
    });

    clear.hidden = !q;
    finder.classList.toggle('is-filtering', !!q);

    if (!q) {
      count.textContent = '';
    } else if (shown === 0) {
      count.textContent = 'No items match “' + input.value.trim() + '”. Try a fabric or garment name.';
    } else {
      count.textContent =
        shown === 1
          ? '1 item matches “' + input.value.trim() + '”.'
          : shown + ' items match “' + input.value.trim() + '”.';
    }
  };

  const onInput = () => apply();
  const onClear = () => {
    input.value = '';
    apply();
    input.focus();
  };
  // Escape clears rather than blurring — the browser's own behaviour for
  // type=search varies, and clearing is what people expect here.
  const onKey = (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      onClear();
    }
  };

  input.addEventListener('input', onInput);
  clear.addEventListener('click', onClear);
  input.addEventListener('keydown', onKey);

  /* Which category am I in? Marks the matching chip. Rooted on the viewport
     with a band across the middle, so the chip changes when a section is
     genuinely the one being read, not when its top edge grazes the fold. */
  let observer = null;
  if ('IntersectionObserver' in window) {
    // Track WHICH sections are currently in the band and pick the first in
    // document order, rather than reacting to whichever entry fired last.
    // Acting on the last entry left the previous section's chip marked when
    // two bands changed state in the same callback.
    const inBand = new Set();
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) inBand.add(e.target.id);
          else inBand.delete(e.target.id);
        });
        const current = cats.map((c) => c.id).find((id) => inBand.has(id));
        chips.forEach((c) =>
          c.classList.toggle('is-current', !!current && c.getAttribute('href') === '#' + current)
        );
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: 0 }
    );
    cats.forEach((c) => observer.observe(c));
  }

  apply();

  const cleanup = () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKey);
    clear.removeEventListener('click', onClear);
    if (observer) observer.disconnect();
    if (teardown === cleanup) teardown = null;
  };

  teardown = cleanup;
  return cleanup;
}
