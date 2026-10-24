/* Book a pickup (/book-pickup/): details -> SMS code -> pickup created in
   Fabklean -> confirmation.

   The Fabklean token lives on the server (server/booking.js); this only talks
   to /api/booking/*. If that service is offline, the page degrades to a
   WhatsApp message carrying the booking details, so a booking is never lost.

   This is separate from the price-list WhatsApp button (cart.js), which is a
   plain pricing chat and never books anything. Items chosen on the price list
   are read from the same localStorage list and added to the pickup's notes. */

const CART_KEY = 'w4u-cart'
const LEAD_KEY = 'w4u-lead'

const readCart = () => {
  try {
    const arr = JSON.parse(localStorage.getItem(CART_KEY) || '[]')
    return Array.isArray(arr) ? arr.filter((i) => i && i.name && i.qty > 0) : []
  } catch { return [] }
}
const clearCart = () => { try { localStorage.setItem(CART_KEY, '[]') } catch { /* ignore */ } }

const niceDate = (ymd) => {
  const d = new Date(ymd + 'T00:00:00')
  return isNaN(d) ? ymd : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
}
const tenDigits = (v) => String(v || '').replace(/\D/g, '').slice(-10)

export function initBooking(root = document) {
  const host = root.querySelector('[data-booking]')
  if (!host) return

  const form = host.querySelector('#book-form')
  const otpForm = host.querySelector('#book-otp')
  const done = host.querySelector('#book-done')
  const steps = Array.from(host.querySelectorAll('[data-progress] li'))
  const waBase = host.dataset.whatsapp || 'https://wa.me/916367600500'
  const items = readCart()

  let conf = null // { enabled, slots, minDate, maxDate }
  let details = null
  let session = ''

  const api = async (path, body) => {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 25000)
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

  const wa = (text) => waBase + (waBase.includes('?') ? '&' : '?') + 'text=' + encodeURIComponent(text)
  const setErr = (el, msg) => { el.textContent = msg || ''; el.hidden = !msg }
  const busy = (btn, on, label) => { btn.disabled = on; btn.textContent = on ? 'Please wait…' : label }

  function show(which) {
    form.hidden = which !== 'details'
    otpForm.hidden = which !== 'otp'
    done.hidden = which !== 'done'
    steps.forEach((li) => {
      if (li.dataset.step === which) li.setAttribute('aria-current', 'step')
      else li.removeAttribute('aria-current')
      li.classList.toggle('is-past', ['details', 'otp', 'done'].indexOf(li.dataset.step) < ['details', 'otp', 'done'].indexOf(which))
    })
    if (which !== 'details') host.querySelector('.book-card').scrollIntoView({ behavior: 'smooth', block: 'start' })
    const first = (which === 'otp' ? otpForm : which === 'done' ? done : null)
    if (first) { const f = first.querySelector('input'); if (f) f.focus() }
  }

  /* ---- price-list items already chosen ---- */
  if (items.length) {
    const box = host.querySelector('[data-book-items]')
    const ul = host.querySelector('[data-book-items-list]')
    items.forEach((i) => {
      const li = document.createElement('li')
      li.textContent = `${i.name} × ${i.qty}`
      ul.appendChild(li)
    })
    box.hidden = false
  }

  /* ---- form setup from live config ---- */
  api('config').then((r) => {
    conf = r.status === 200 && r.j.enabled ? r.j : { enabled: false }
    host.querySelector('[data-when]').hidden = !conf.enabled
    form.elements.date.required = form.elements.slot.required = !!conf.enabled
    if (conf.enabled) {
      form.elements.date.min = conf.minDate
      form.elements.date.max = conf.maxDate
      form.elements.date.value = conf.minDate
      conf.slots.forEach((s) => form.elements.slot.add(new Option(s, s)))
      host.querySelector('[data-submit]').textContent = 'Send verification code'
    } else {
      host.querySelector('[data-submit]').textContent = 'Continue on WhatsApp'
      form.querySelector('.book-fine').textContent = 'Online booking is busy right now, so we’ll take your details on WhatsApp.'
    }
  })

  let saved = null
  try { saved = JSON.parse(localStorage.getItem(LEAD_KEY) || 'null') } catch { /* ignore */ }
  if (saved) ['name', 'phone', 'address'].forEach((k) => { if (saved[k] && form.elements[k]) form.elements[k].value = saved[k] })

  /* ---- outcomes ---- */
  function finishBooked(r) {
    const when = `${niceDate(r.j.date)}, ${r.j.slot}`
    done.querySelector('[data-done-title]').textContent = `Pickup booked${r.j.orderNo ? ' · ' + r.j.orderNo : ''}`
    done.querySelector('[data-done-text]').textContent =
      `${when}. We’ll send your confirmation on WhatsApp to +91 ${details.phone}.`
    done.querySelector('[data-done-primary]').hidden = true
    const help = done.querySelector('[data-done-help]')
    help.hidden = false
    done.querySelector('[data-done-wa]').href = wa(
      `Hi Wash4You! I booked a pickup${r.j.orderNo ? ' (' + r.j.orderNo + ')' : ''} for ${when}. Please confirm. Name: ${details.name}, Mobile: ${details.phone}.`
    )
    clearCart()
    show('done')
  }

  // Booking service unreachable / failed: hand the details to WhatsApp so nothing is lost.
  function finishFallback(why) {
    const lines = ["Hi Wash4You! I'd like to book a free pickup.",
      `Name: ${details.name}`, `Mobile: ${details.phone}`, `Address: ${details.address}`]
    if (details.date || details.slot) lines.push(`Pickup: ${[details.date && niceDate(details.date), details.slot].filter(Boolean).join(', ')}`)
    if (items.length) lines.push('Items: ' + items.map((i) => `${i.name} ×${i.qty}`).join(', '))
    if (details.notes) lines.push(`Notes: ${details.notes}`)
    done.querySelector('[data-done-title]').textContent = 'Continue on WhatsApp'
    done.querySelector('[data-done-text]').textContent = why
    const primary = done.querySelector('[data-done-primary]')
    primary.href = wa(lines.join('\n'))
    primary.hidden = false
    done.querySelector('[data-done-help]').hidden = true
    show('done')
  }

  /* ---- step 1: details -> send the code ---- */
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const err = host.querySelector('[data-error]')
    const btn = host.querySelector('[data-submit]')
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
    try { localStorage.setItem(LEAD_KEY, JSON.stringify({ name: details.name, phone, address: details.address })) } catch { /* ignore */ }

    if (!conf || !conf.enabled) {
      finishFallback('Online booking is busy right now. Send your details on WhatsApp and we’ll book your pickup and confirm there.')
      return
    }
    const label = btn.textContent
    busy(btn, true, label)
    const r = await api('otp', { phone })
    busy(btn, false, label)
    if (r.status === 200 && r.j.ok) {
      host.querySelector('[data-otp-phone]').textContent = '+91 ' + phone
      otpForm.elements.otp.value = ''
      setErr(host.querySelector('[data-otp-error]'), '')
      show('otp')
    } else if (r.status === 400 || r.status === 429) {
      setErr(err, r.j.error || 'Please check your details and try again.')
    } else {
      finishFallback('Our booking system is busy right now. Send your details on WhatsApp and we’ll book your pickup and confirm there.')
    }
  })

  /* ---- step 2: verify code -> create the pickup ---- */
  otpForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const err = host.querySelector('[data-otp-error]')
    const btn = host.querySelector('[data-otp-submit]')
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
      if (r.status === 200 && r.j.ok) finishBooked(r)
      else if (r.status === 401) { session = ''; setErr(err, r.j.error || 'Please verify again.') }
      else if (r.status === 400 || r.status === 429) setErr(err, r.j.error || 'Please check your details.')
      else finishFallback('We verified your number but could not complete the booking. Send your details on WhatsApp and we’ll book it for you.')
    } finally { busy(btn, false, label) }
  })
  otpForm.querySelector('[data-otp-back]').addEventListener('click', () => show('details'))
}
