/* Pickup list ("cart").

   A static-host cart: state lives in localStorage, and "Book my pickup"
   composes a pre-filled WhatsApp message with the whole itemised list —
   the same handoff pattern the contact form uses. No backend, no payment.

   The module is defensive: it runs on every page (to keep the header badge
   and drawer in sync from storage) but does nothing costly when there are no
   price cards. A throw here is caught by main.js's boot() and never takes the
   rest of the page down.

   Prices are indicative only. 'from' items and GST are called out in the UI
   and in the message, so the total never reads as a binding quote.
*/

const KEY = 'w4u-cart'

// GST is itemised in the summary (req 8): Subtotal / GST (18%) / Total.
const GST_RATE = 0.18

const rupee = (n) => '₹' + Math.round(n).toLocaleString('en-IN')

// Round to paise. Used for the GST line and the two money lines it sits
// between, so the three read as one consistent invoice.
const round2 = (n) => Math.round(n * 100) / 100
const money2 = (n) =>
  '₹' + round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((i) => i && i.slug && i.qty > 0) : []
  } catch {
    return []
  }
}

function write(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    /* private mode / quota — the in-memory copy still drives this page */
  }
}

export function initCart(root = document) {
  const drawer = root.getElementById('cart-drawer')
  // The drawer lives in base.html, so it is present on every page. If it is
  // somehow absent, there is nothing to wire.
  if (!drawer) return

  const backdrop = root.getElementById('cart-backdrop')
  const toggle = root.getElementById('cart-toggle')
  const closeBtn = root.getElementById('cart-close')
  const body = drawer.querySelector('[data-cart-body]')
  const emptyEl = drawer.querySelector('[data-cart-empty]')
  const footEl = drawer.querySelector('[data-cart-foot]')
  const subtotalEl = drawer.querySelector('[data-cart-subtotal]')
  const gstEl = drawer.querySelector('[data-cart-gst]')
  const totalEl = drawer.querySelector('[data-cart-total]')
  const bookBtn = drawer.querySelector('[data-cart-book]')
  const clearBtn = drawer.querySelector('[data-cart-clear]')
  const waBase = drawer.getAttribute('data-whatsapp') || 'https://wa.me/916367600500'

  const cards = Array.from(root.querySelectorAll('[data-price-item]'))
  const cardBySlug = new Map(cards.map((c) => [c.dataset.slug, c]))

  let items = read()
  let lastFocus = null

  const find = (slug) => items.find((i) => i.slug === slug)
  const count = () => items.reduce((n, i) => n + i.qty, 0)
  const subtotal = () => items.reduce((n, i) => n + (Number(i.amount) || 0) * i.qty, 0)
  const gstAmount = () => round2(subtotal() * GST_RATE)
  const grandTotal = () => round2(subtotal() + gstAmount())

  /* ---- persistence + full re-render ---- */
  const commit = () => {
    items = items.filter((i) => i.qty > 0)
    write(items)
    renderBadges()
    renderDrawer()
    cards.forEach(renderCardControl)
  }

  const add = (data, delta = 1) => {
    let it = find(data.slug)
    if (!it) {
      if (delta <= 0) return
      it = {
        slug: data.slug,
        name: data.name,
        amount: Number(data.amount) || 0,
        price: data.price || '',
        img: data.img || '',
        from: data.from === '1' || data.from === true,
        qty: 0,
      }
      items.push(it)
    }
    it.qty += delta
    if (it.qty < 0) it.qty = 0
    commit()
  }

  const setQty = (slug, qty) => {
    const it = find(slug)
    if (!it) return
    it.qty = Math.max(0, qty)
    commit()
  }

  /* ---- header + toolbar count badges ---- */
  function renderBadges() {
    const n = count()
    root.querySelectorAll('[data-cart-count]').forEach((el) => { el.textContent = String(n) })
    root.querySelectorAll('[data-pick-bar]').forEach((el) => { el.hidden = n === 0 })
    root.querySelectorAll('[data-cart-book]').forEach((el) => { el.href = buildWhatsApp() })
    if (toggle) {
      toggle.hidden = n === 0
      toggle.classList.toggle('has-items', n > 0)
    }
  }

  /* ---- the Add button / qty stepper inside each price card ---- */
  function renderCardControl(card) {
    const control = card.querySelector('[data-cart-control]')
    if (!control) return
    const slug = card.dataset.slug
    const it = find(slug)
    const name = card.dataset.name || 'item'

    if (!it || it.qty === 0) {
      control.innerHTML =
        `<button class="price-card__add" type="button" data-add aria-label="Add ${escapeAttr(name)} to your pickup list">` +
        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> Add to Cart</button>`
      return
    }
    control.innerHTML =
      `<div class="qty" role="group" aria-label="Quantity for ${escapeAttr(name)}">` +
      `<button class="qty__btn" type="button" data-dec aria-label="Remove one ${escapeAttr(name)}">` +
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg></button>` +
      `<span class="qty__n" aria-live="polite">${it.qty}</span>` +
      `<button class="qty__btn" type="button" data-inc aria-label="Add one more ${escapeAttr(name)}">` +
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>` +
      `</div>`
  }

  /* ---- the drawer list ---- */
  function renderDrawer() {
    const empty = items.length === 0
    if (emptyEl) emptyEl.hidden = !empty
    if (footEl) footEl.hidden = empty
    if (body) body.hidden = empty

    if (body) {
      body.innerHTML = ''
      items.forEach((it) => {
        const li = document.createElement('li')
        li.className = 'cart-line'
        li.dataset.slug = it.slug

        const media = document.createElement('div')
        media.className = 'cart-line__media'
        if (it.img) {
          const img = document.createElement('img')
          img.src = it.img
          img.alt = ''
          img.width = 56
          img.height = 56
          img.loading = 'lazy'
          media.appendChild(img)
        }

        const info = document.createElement('div')
        info.className = 'cart-line__info'
        const nm = document.createElement('span')
        nm.className = 'cart-line__name'
        nm.textContent = it.name
        const pr = document.createElement('span')
        pr.className = 'cart-line__price'
        pr.textContent = it.price || rupee(it.amount)
        info.append(nm, pr)

        const ctrl = document.createElement('div')
        ctrl.className = 'cart-line__control'
        ctrl.innerHTML =
          `<div class="qty qty--sm" role="group" aria-label="Quantity for ${escapeAttr(it.name)}">` +
          `<button class="qty__btn" type="button" data-dec aria-label="Remove one ${escapeAttr(it.name)}">` +
          `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg></button>` +
          `<span class="qty__n">${it.qty}</span>` +
          `<button class="qty__btn" type="button" data-inc aria-label="Add one more ${escapeAttr(it.name)}">` +
          `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>` +
          `</div>` +
          `<button class="cart-line__remove" type="button" data-remove aria-label="Remove ${escapeAttr(it.name)} from your list">` +
          `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7m2 0-.7 11a2 2 0 0 1-2 1.9H9.7a2 2 0 0 1-2-1.9L7 7"/></svg></button>`

        li.append(media, info, ctrl)
        body.appendChild(li)
      })
    }

    // Subtotal / GST (18%) / Total — recomputed live on every quantity change.
    if (subtotalEl) subtotalEl.textContent = money2(subtotal())
    if (gstEl) gstEl.textContent = money2(gstAmount())
    if (totalEl) totalEl.textContent = money2(grandTotal())
    if (bookBtn) bookBtn.href = buildWhatsApp()
    root.querySelectorAll('[data-cart-book]').forEach((el) => { el.href = buildWhatsApp() })
  }

  // The WhatsApp button is a pricing chat: it opens a conversation with the
  // selected items pre-filled so we can quote. It never books anything -
  // "Book a pickup" is a separate link to the external booking page.
  function buildWhatsApp() {
    const lines = ["Hi Wash4You! I'd like the price for:"]
    items.forEach((it) => {
      const each = it.price || rupee(it.amount)
      lines.push(`• ${it.name} ×${it.qty} — ${each}`)
    })
    lines.push('')
    lines.push(`Subtotal: ${money2(subtotal())}`)
    lines.push(`GST (18%): ${money2(gstAmount())}`)
    lines.push(`Total: ${money2(grandTotal())}`)
    // Every listed rate is a starting price, so this is stated once for the list.
    lines.push('Note: all rates are starting prices; the final price depends on the garment and the work it needs.')
    lines.push('Please confirm the price. Thank you!')
    return waBase + (waBase.includes('?') ? '&' : '?') + 'text=' + encodeURIComponent(lines.join('\n'))
  }

  /* ---- open / close ---- */
  const isOpen = () => drawer.classList.contains('is-open')
  const open = () => {
    if (isOpen()) return
    lastFocus = document.activeElement
    drawer.classList.add('is-open')
    drawer.setAttribute('aria-hidden', 'false')
    if (backdrop) backdrop.hidden = false
    if (toggle) toggle.setAttribute('aria-expanded', 'true')
    document.body.classList.add('cart-lock')
    if (closeBtn) closeBtn.focus()
  }
  const close = () => {
    if (!isOpen()) return
    const back = lastFocus instanceof HTMLElement ? lastFocus : toggle
    if (back && document.body.contains(back) && !back.hidden) back.focus()
    const active = document.activeElement
    if (active && drawer.contains(active) && active.blur) active.blur()
    drawer.classList.remove('is-open')
    drawer.setAttribute('aria-hidden', 'true')
    if (backdrop) backdrop.hidden = true
    if (toggle) toggle.setAttribute('aria-expanded', 'false')
    document.body.classList.remove('cart-lock')
    lastFocus = null
  }

  /* ---- events (delegated) ---- */
  root.addEventListener('click', (e) => {
    const openTrigger = e.target.closest('[data-cart-open], #cart-toggle')
    if (openTrigger) { e.preventDefault(); open(); return }

    const card = e.target.closest('[data-price-item]')
    if (card) {
      if (e.target.closest('[data-add], [data-inc]')) { add(card.dataset, 1); return }
      if (e.target.closest('[data-dec]')) { add(card.dataset, -1); return }
    }

    const line = e.target.closest('.cart-line')
    if (line) {
      const slug = line.dataset.slug
      if (e.target.closest('[data-remove]')) { setQty(slug, 0); return }
      if (e.target.closest('[data-inc]')) { const it = find(slug); if (it) setQty(slug, it.qty + 1); return }
      if (e.target.closest('[data-dec]')) { const it = find(slug); if (it) setQty(slug, it.qty - 1); return }
    }

    if (e.target.closest('[data-cart-clear]')) { items = []; commit(); return }
    if (closeBtn && e.target.closest('#cart-close')) { close(); return }
    if (backdrop && e.target === backdrop) { close(); return }
  })

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close()
  })

  // Reflect storage changes made in other tabs.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { items = read(); renderBadges(); renderDrawer(); cards.forEach(renderCardControl) }
  })

  // First paint from whatever is in storage.
  renderBadges()
  renderDrawer()
  cards.forEach(renderCardControl)
}

/* Attribute-safe escaping for the small strings we inject into aria-labels. */
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
