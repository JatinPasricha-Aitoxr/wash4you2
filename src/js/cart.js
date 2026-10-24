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

  // After a pickup is booked the list is done; the WhatsApp message already holds a copy.
  const clearList = () => { items = []; commit() }

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

  /* ---- pickup booking: details -> SMS code -> Fabklean pickup -> WhatsApp ----
     The Fabklean token lives on the server (server/booking.js); this only talks
     to /api/booking/*. If that service is offline the form degrades to a plain
     WhatsApp handoff, so a booking is never lost. */
  const dialog = root.getElementById('lead-dialog')
  const form = root.getElementById('lead-form')
  const otpForm = root.getElementById('lead-otp')
  const doneBox = root.getElementById('lead-done')
  let conf = null // { enabled, slots, minDate, maxDate } from the server
  let details = null // what the customer typed
  let session = ''

  const api = async (path, body) => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 20000)
    try {
      const r = await fetch('/api/booking/' + path, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      })
      let j = null
      try { j = await r.json() } catch { /* non-JSON */ }
      return { status: r.status, j: j || {} }
    } catch {
      return { status: 0, j: {} }
    } finally { clearTimeout(t) }
  }

  const show = (which) => {
    form.hidden = which !== 'details'
    otpForm.hidden = which !== 'otp'
    doneBox.hidden = which !== 'done'
    const first = (which === 'details' ? form : which === 'otp' ? otpForm : doneBox).querySelector('input,select,a')
    if (first && which !== 'details') first.focus()
  }
  const setErr = (el, msg) => { el.textContent = msg || ''; el.hidden = !msg }
  const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = on ? 'Please wait…' : label }
  const niceDate = (ymd) => {
    const d = new Date(ymd + 'T00:00:00')
    return isNaN(d) ? ymd : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
  }
  const tenDigits = (v) => String(v || '').replace(/\D/g, '').slice(-10)

  async function loadConf() {
    if (conf) return conf
    const r = await api('config')
    conf = r.status === 200 && r.j.enabled ? r.j : { enabled: false }
    return conf
  }

  const openLead = async () => {
    if (!items.length) return
    if (!dialog || typeof dialog.showModal !== 'function') { window.open(buildWhatsApp(), '_blank', 'noopener'); return }
    const c = await loadConf()
    let saved = null
    try { saved = JSON.parse(localStorage.getItem('w4u-lead') || 'null') } catch { /* ignore */ }
    if (saved) ['name', 'phone', 'address'].forEach((k) => { if (saved[k] && form.elements[k]) form.elements[k].value = saved[k] })

    // Booking fields only when the booking service is live.
    form.querySelector('[data-when]').hidden = !c.enabled
    form.elements.date.required = form.elements.slot.required = !!c.enabled
    if (c.enabled) {
      form.elements.date.min = c.minDate
      form.elements.date.max = c.maxDate
      if (!form.elements.date.value) form.elements.date.value = c.minDate
      const sel = form.elements.slot
      if (sel.options.length <= 1) c.slots.forEach((sl) => sel.add(new Option(sl, sl)))
    }
    form.querySelector('[data-lead-submit]').textContent = c.enabled ? 'Send code' : 'Continue to WhatsApp'
    setErr(dialog.querySelector('[data-lead-error]'), '')
    session = ''
    show('details')
    dialog.showModal()
  }

  const finish = (title, text, c) => {
    doneBox.querySelector('[data-done-title]').textContent = title
    doneBox.querySelector('[data-done-text]').textContent = text
    doneBox.querySelector('[data-done-wa]').href = buildWhatsApp(c)
    show('done')
  }

  if (form && otpForm && dialog) {
    // Step 1: details -> send SMS code
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      const err = dialog.querySelector('[data-lead-error]')
      const btn = form.querySelector('[data-lead-submit]')
      if (form.elements.company.value) return // honeypot
      const v = (k) => (form.elements[k].value || '').trim()
      const phone = tenDigits(v('phone'))
      if (v('name').length < 2 || !/^[6-9]\d{9}$/.test(phone) || v('address').length < 8) {
        setErr(err, 'Please add your name, a valid 10-digit mobile number and your full pickup address.')
        return
      }
      if (conf && conf.enabled && (!v('date') || !v('slot'))) { setErr(err, 'Please choose a pickup date and time slot.'); return }
      setErr(err, '')
      details = { name: v('name'), phone, address: v('address'), date: v('date'), slot: v('slot'), notes: v('notes') }
      try { localStorage.setItem('w4u-lead', JSON.stringify({ name: details.name, phone, address: details.address })) } catch { /* ignore */ }

      if (!conf || !conf.enabled) { finish('Almost done', 'Send your list on WhatsApp and we’ll confirm the price and pickup slot.', details); return }

      const label = btn.textContent
      busy(btn, true, label)
      const r = await api('otp', { phone })
      busy(btn, false, label)
      if (r.status === 200 && r.j.ok) {
        otpForm.querySelector('[data-otp-phone]').textContent = '+91 ' + phone
        otpForm.elements.otp.value = ''
        setErr(otpForm.querySelector('[data-otp-error]'), '')
        show('otp')
      } else if (r.status === 400 || r.status === 429) {
        setErr(err, r.j.error || 'Please check your details and try again.')
      } else {
        // Booking service unreachable: keep the customer moving on WhatsApp.
        finish('Continue on WhatsApp', 'Our booking system is busy right now. Send your list on WhatsApp and we’ll book your pickup for you.', details)
      }
    })

    // Step 2: verify code -> create the pickup
    otpForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const err = otpForm.querySelector('[data-otp-error]')
      const btn = otpForm.querySelector('[data-otp-submit]')
      const label = btn.textContent
      busy(btn, true, label)
      try {
        if (!session) {
          const v = await api('verify', { phone: details.phone, otp: otpForm.elements.otp.value })
          if (!(v.status === 200 && v.j.ok)) {
            setErr(err, v.status === 0 || v.status >= 500 ? 'Could not verify right now. Please try again.' : v.j.error || 'That code is not correct.')
            return
          }
          session = v.j.session
        }
        const r = await api('schedule', {
          session, name: details.name, address: details.address,
          date: details.date, slot: details.slot, notes: details.notes,
          items: items.map((i) => ({ name: i.name, qty: i.qty })),
        })
        if (r.status === 200 && r.j.ok) {
          // Build the WhatsApp message from the list first, then clear it.
          finish(`Pickup booked${r.j.orderNo ? ' · ' + r.j.orderNo : ''}`,
            `${niceDate(r.j.date)}, ${r.j.slot}. Send your list on WhatsApp so we can confirm the price.`,
            { ...details, orderNo: r.j.orderNo })
          clearList()
        } else if (r.status === 401) {
          session = ''
          setErr(err, r.j.error || 'Please verify again.')
        } else if (r.status === 400 || r.status === 429) {
          setErr(err, r.j.error || 'Please check your details.')
        } else {
          finish('Continue on WhatsApp', 'We verified your number but could not complete the booking. Send your list on WhatsApp and we’ll book it for you.', details)
        }
      } finally { busy(btn, false, label) }
    })
    otpForm.querySelector('[data-otp-back]').addEventListener('click', () => show('details'))

    dialog.addEventListener('click', (e) => {
      if (e.target === dialog || e.target.closest('[data-lead-close]')) dialog.close()
    })
  }

  function buildWhatsApp(c) {
    const lines = [c && c.orderNo
      ? `Hi Wash4You! I just booked a pickup (${c.orderNo}). Please share the price for:`
      : "Hi Wash4You! I'd like to book a free pickup and get the price for:"]
    items.forEach((it) => {
      const each = it.price || rupee(it.amount)
      lines.push(`• ${it.name} ×${it.qty} — ${each}`)
    })
    lines.push('')
    lines.push(`Subtotal: ${money2(subtotal())}`)
    lines.push(`GST (18%): ${money2(gstAmount())}`)
    lines.push(`Total: ${money2(grandTotal())}`)
    // Every listed rate is a starting price now (data-from is gone), so this
    // is stated once for the whole list instead of tagged onto each line.
    lines.push('Note: all rates are starting prices; the final price depends on the garment and the work it needs.')
    if (c) {
      lines.push('')
      lines.push(`Name: ${c.name}`, `Mobile: ${c.phone}`, `Address: ${c.address}`)
      if (c.date || c.slot) lines.push(`Pickup: ${[c.date && niceDate(c.date), c.slot].filter(Boolean).join(', ')}`)
      if (c.notes) lines.push(`Notes: ${c.notes}`)
    }
    lines.push(c && c.orderNo ? 'Thank you!' : 'Please confirm the price and a pickup slot. Thank you!')
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
    const bookTrigger = e.target.closest('[data-cart-book]')
    if (bookTrigger) { e.preventDefault(); close(); openLead(); return }

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

  // Landed from a "Book pickup" button (?book=1): show the 3-step guide.
  if (/[?&]book=1\b/.test(location.search)) {
    root.querySelectorAll('[data-book-steps]').forEach((el) => { el.hidden = false })
  }

  // First paint from whatever is in storage.
  renderBadges()
  renderDrawer()
  cards.forEach(renderCardControl)
}

/* Attribute-safe escaping for the small strings we inject into aria-labels. */
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
