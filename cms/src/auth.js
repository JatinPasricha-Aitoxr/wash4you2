'use strict';
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

const COOKIE = 'w4u_cms';
const MAX_FAILS = 5;                 // per window, per ip and per username
const WINDOW_MS = 15 * 60 * 1000;

// ---- passwords (scrypt, per-user salt) ---------------------------------
const N = 16384, R = 8, P = 1, KEYLEN = 64;
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}
function verifyPassword(password, stored) {
  try {
    const [alg, n, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length,
      { N: +n, r: +r, p: +p });
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
const DUMMY = hashPassword('dummy-password-for-timing');
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use letters and at least one number.';
  return null;
}

// ---- cookies -----------------------------------------------------------
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(res, token, maxAgeSec) {
  const flags = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (config.isProd) flags.push('Secure');
  res.append('Set-Cookie', flags.join('; '));
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- sessions ----------------------------------------------------------
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  await db.exec('INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?,?,?,?,?)',
    [sha(token), userId, csrf, now, now + config.sessionHours * 3600e3]);
  return { token, csrf };
}
async function sessionFromReq(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = await db.one(
    `SELECT s.token_hash, s.csrf, s.expires_at, u.id AS user_id, u.username, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, [sha(token)]);
  if (!row || row.expires_at < Date.now()) return null;
  return { user: { id: row.user_id, username: row.username, role: row.role }, csrf: row.csrf, hash: row.token_hash };
}
async function destroySession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await db.exec('DELETE FROM sessions WHERE token_hash = ?', [sha(token)]);
}

// ---- rate limiting -----------------------------------------------------
async function tooManyFailures(ip, username) {
  const since = Date.now() - WINDOW_MS;
  const a = await db.one('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ?', [ip, since]);
  const b = await db.one('SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND at > ?', [username, since]);
  return Number(a.n) >= MAX_FAILS || Number(b.n) >= MAX_FAILS;
}
const recordFailure = (ip, username) =>
  db.exec('INSERT INTO login_attempts (ip, username, at) VALUES (?,?,?)', [ip, username, Date.now()]);

async function login(ip, username, password) {
  username = String(username || '').trim().slice(0, 64);
  if (await tooManyFailures(ip, username)) return { error: 'Too many attempts. Try again in 15 minutes.', status: 429 };
  const user = await db.one('SELECT * FROM users WHERE username = ?', [username]);
  const ok = verifyPassword(String(password || ''), user ? user.password_hash : DUMMY) && !!user;
  if (!ok) { await recordFailure(ip, username); return { error: 'Wrong username or password.', status: 401 }; }
  await db.exec('DELETE FROM login_attempts WHERE ip = ? OR username = ?', [ip, username]);
  await db.exec('UPDATE users SET last_login_at = ? WHERE id = ?', [Date.now(), user.id]);
  const s = await createSession(user.id);
  return { user: { id: user.id, username: user.username, role: user.role }, ...s };
}

// ---- middleware --------------------------------------------------------
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser / same-origin form posts without Origin
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function loadSession(req, res, next) {
  try { req.session = await sessionFromReq(req); next(); } catch (e) { next(e); }
}
function requireAuth(req, res, next) {
  if (!req.session) return res.status(401).json({ error: 'not authenticated' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session || req.session.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}
// Every state-changing request needs the session's CSRF token and a same-origin Origin header.
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session) return res.status(401).json({ error: 'not authenticated' });
  const given = String(req.headers['x-csrf-token'] || '');
  const want = req.session.csrf;
  const ok = given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
  if (!ok || !sameOrigin(req)) return res.status(403).json({ error: 'CSRF check failed. Reload the page and try again.' });
  next();
}

async function audit(req, action, detail = '') {
  try {
    await db.exec('INSERT INTO audit_log (user_id, action, detail, ip, at) VALUES (?,?,?,?,?)',
      [req && req.session ? req.session.user.id : null, action, String(detail).slice(0, 500),
        req ? (req.ip || '') : '', Date.now()]);
  } catch { /* auditing must never break a request */ }
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, passwordProblem, setSessionCookie, destroySession,
  login, loadSession, requireAuth, requireAdmin, requireCsrf, audit, parseCookies, sha,
};
