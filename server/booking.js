'use strict';
// Website "Book pickup" -> Fabklean CRM. Runs on the Node server so the API
// token never reaches the browser.
//
// Flow: otp (SMS code) -> verify (returns a signed session holding the
// Fabklean customer id) -> schedule (creates the pickup). Fabklean's
// OTP-generate response contains the code itself; it is never forwarded.
const crypto = require('crypto');

const BASE = () => (process.env.FABKLEAN_BASE || 'https://support.fabklean.com').replace(/\/+$/, '');
const STORE = () => (process.env.FABKLEAN_STORE_ID || '').trim();
const TOKEN = () => (process.env.FABKLEAN_TOKEN || '').trim();
const SOURCE = () => (process.env.FABKLEAN_SOURCE || '').trim();
const enabled = () => !!(TOKEN() && STORE());

const SESSION_TTL_MS = 20 * 60 * 1000;
const MAX_BODY = 24 * 1024;
const PHONE_RE = /^[6-9]\d{9}$/;

/* ---------- small helpers ---------- */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('bad json'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

/* in-memory rate limiter: key -> timestamps within window */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 3600e3)) hits.delete(k);
}, 10 * 60 * 1000).unref();

/* ---------- signed session ---------- */
const key = () => crypto.createHash('sha256').update('w4u-session|' + TOKEN()).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

function signSession(data) {
  const payload = b64u(JSON.stringify({ ...data, exp: Date.now() + SESSION_TTL_MS }));
  const mac = crypto.createHmac('sha256', key()).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function readSession(tok) {
  if (typeof tok !== 'string' || !tok.includes('.')) return null;
  const [payload, mac] = tok.split('.');
  const want = crypto.createHmac('sha256', key()).update(payload).digest('base64url');
  const a = Buffer.from(mac || ''), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}

/* ---------- Fabklean client ---------- */
async function fk(path, { method = 'GET', body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(BASE() + path, {
      method,
      redirect: 'manual',
      signal: ctl.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'ApiToken ' + TOKEN(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: r.status, json, text };
  } finally { clearTimeout(timer); }
}

/* ---------- pickup config (slots) ---------- */
let cfg = null;
async function getConfig() {
  if (cfg && Date.now() - cfg.at < 10 * 60 * 1000) return cfg.data;
  const r = await fk(`/api/appConfigProperties/properties?type=SALESORDER&contextId=${STORE()}`, {
    method: 'POST',
    body: { Keys: 'PICKUP_SLOTS,DEFAULT_PICKUPDATE' },
  });
  if (r.status !== 200 || !r.json) throw new Error('config ' + r.status);
  const slots = String(r.json.PICKUP_SLOTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const minDays = Math.max(0, parseInt(r.json.DEFAULT_PICKUPDATE, 10) || 0);
  const data = { slots, minDays };
  cfg = { at: Date.now(), data };
  return data;
}

/* ---------- date helpers (store runs on IST) ---------- */
const IST = 5.5 * 3600e3;
const istDate = (ms = Date.now()) => new Date(ms + IST).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

/* ---------- handlers ---------- */
async function otp(req, res) {
  const b = await readJson(req);
  const phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
  if (!PHONE_RE.test(phone)) return send(res, 400, { ok: false, error: 'Enter a valid 10-digit mobile number.' });
  if (limited('otp-ip:' + clientIp(req), 10, 3600e3) || limited('otp-ph:' + phone, 3, 10 * 60e3))
    return send(res, 429, { ok: false, error: 'Too many codes requested. Please wait a few minutes.' });

  const r = await fk(`/api/userInfos/otp/receive?storeId=${STORE()}`, {
    method: 'POST',
    body: { countryCode: '+91', phoneNumber: phone, source: 'APP' },
  });
  // r.json.verificationCode is the OTP itself - deliberately dropped.
  if (r.status >= 200 && r.status < 300) return send(res, 200, { ok: true });
  return send(res, 502, { ok: false, error: 'Could not send the code right now.' });
}

async function verify(req, res) {
  const b = await readJson(req);
  const phone = String(b.phone || '').replace(/\D/g, '').slice(-10);
  const code = String(b.otp || '').replace(/\D/g, '');
  if (!PHONE_RE.test(phone) || code.length < 4 || code.length > 8)
    return send(res, 400, { ok: false, error: 'Enter the code from the SMS.' });
  if (limited('vf-ph:' + phone, 8, 10 * 60e3) || limited('vf-ip:' + clientIp(req), 30, 3600e3))
    return send(res, 429, { ok: false, error: 'Too many attempts. Please wait a few minutes.' });

  const r = await fk(
    `/api/userInfos/otp/verify/${encodeURIComponent(code)}.json?phnNumber=${phone}&storeId=${STORE()}`,
    { method: 'POST', body: { deviceId: 'web', deviceType: 'Web', fcmToken: '' } }
  );
  const u = r.json && r.json.userInfo;
  if (r.status !== 200 || !u || !u.id)
    return send(res, 400, { ok: false, error: 'That code is not correct. Please try again.' });

  const known = u.name && String(u.name).replace(/\D/g, '') !== phone ? String(u.name) : '';
  return send(res, 200, {
    ok: true,
    session: signSession({ uid: u.id, ph: phone, nm: known }),
    name: known,
  });
}

async function schedule(req, res) {
  const b = await readJson(req);
  const s = readSession(b.session);
  if (!s) return send(res, 401, { ok: false, error: 'Your verification expired. Please verify your number again.' });
  if (limited('sc-ip:' + clientIp(req), 10, 3600e3) || limited('sc-ph:' + s.ph, 5, 3600e3))
    return send(res, 429, { ok: false, error: 'Too many bookings from this number. Please call us.' });

  const name = String(b.name || s.nm || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const address = String(b.address || '').trim().replace(/[ \t]+/g, ' ').slice(0, 300);
  const notes = String(b.notes || '').trim().slice(0, 300);
  if (name.length < 2 || address.length < 8)
    return send(res, 400, { ok: false, error: 'Please add your name and full pickup address.' });

  const conf = await getConfig();
  const today = istDate();
  const first = addDays(today, conf.minDays);
  const date = String(b.date || first);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < first || date > addDays(today, 30))
    return send(res, 400, { ok: false, error: 'Please choose a pickup date within the next 30 days.' });
  const slot = String(b.slot || '').trim();
  if (conf.slots.length && !conf.slots.includes(slot))
    return send(res, 400, { ok: false, error: 'Please choose one of the pickup time slots.' });

  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 80)
    .map((i) => ({ name: String(i.name || '').slice(0, 60), qty: Math.min(99, Math.max(1, parseInt(i.qty, 10) || 1)) }))
    .filter((i) => i.name);
  const itemLine = items.length ? 'Items: ' + items.map((i) => `${i.name} x${i.qty}`).join(', ') : '';
  const customerNotes = ['Website booking', itemLine, notes && 'Notes: ' + notes].filter(Boolean).join(' | ').slice(0, 900);

  // New customers arrive with their phone number as the name - give them the real one.
  // Awaited (not fire-and-forget): updating the customer while the pickup is being
  // created once made Fabklean reject the pickup after it had already saved it.
  if (!s.nm) {
    await fk(`/api/userInfos/${s.uid}.json?contextId=${STORE()}&ts=${Date.now()}`, {
      method: 'PUT',
      body: { id: s.uid, firstName: name, phoneNumber: s.ph },
    }).catch(() => {});
  }

  const [y, m, d] = date.split('-');
  const body = {
    consumerInfo: { id: s.uid, name: s.nm || name, phoneNumber: s.ph },
    customerType: 'user',
    invoiceStatus: 'UNPAID',
    workflowStatus: 'PICKUP',
    supplyPlace: 'PD',
    customerNotes,
    shippingAddress: address,
    value6: slot,
    value7: slot,
    promoCode: '',
    orderDate: today,
    expectedDate: `${d}/${m}/${y} 00:00`,
    supplyDate: Date.parse(date + 'T00:00:00Z'),
  };
  if (SOURCE()) body.value10 = SOURCE();

  const r = await fk(`/api/salesOrders/schedulePickup.json?contextId=${STORE()}`, { method: 'POST', body });
  if (r.status === 200 && r.json && r.json.orderCreate === 'success')
    return send(res, 200, { ok: true, orderNo: String(r.json.orderIdStr || ''), date, slot });
  console.error('schedule not ok:', r.status, String(r.text || '').slice(0, 200));
  return send(res, 502, { ok: false, error: 'We could not create the pickup right now.' });
}

async function config(req, res) {
  if (!enabled()) return send(res, 200, { enabled: false });
  try {
    const c = await getConfig();
    const today = istDate();
    return send(res, 200, { enabled: true, slots: c.slots, minDate: addDays(today, c.minDays), maxDate: addDays(today, 30) });
  } catch {
    return send(res, 200, { enabled: false });
  }
}

const ROUTES = {
  'GET /api/booking/config': config,
  'POST /api/booking/otp': otp,
  'POST /api/booking/verify': verify,
  'POST /api/booking/schedule': schedule,
};

// Returns true when it handled the request.
function handle(req, res) {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/booking/')) return false;
  const fn = ROUTES[`${req.method} ${url}`];
  if (!fn) { send(res, ROUTES[`GET ${url}`] || ROUTES[`POST ${url}`] ? 405 : 404, { ok: false }); return true; }
  if (url !== '/api/booking/config' && !enabled()) { send(res, 503, { ok: false, error: 'Booking is offline.' }); return true; }
  fn(req, res).catch((e) => {
    if (e && e.code === 413) return send(res, 413, { ok: false, error: 'Too large.' });
    if (e && e.code === 400) return send(res, 400, { ok: false, error: 'Bad request.' });
    // Never log request bodies or the token.
    console.error('booking error:', e && e.name, e && e.message);
    send(res, 502, { ok: false, error: 'Booking is temporarily unavailable.' });
  });
  return true;
}

module.exports = { handle, enabled };
