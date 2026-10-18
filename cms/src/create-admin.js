'use strict';
// Usage: ADMIN_USER=you ADMIN_PASSWORD='long passphrase 123' node src/create-admin.js
// (or interactively:  node src/create-admin.js you)  - password is never stored in plain text.
const db = require('./db');
const { migrate } = require('./schema');
const { hashPassword, passwordProblem } = require('./auth');
(async () => {
  const username = process.env.ADMIN_USER || process.argv[2];
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) { console.error('Set ADMIN_USER and ADMIN_PASSWORD (or pass the username as an argument and set ADMIN_PASSWORD).'); process.exit(1); }
  const problem = passwordProblem(password);
  if (problem) { console.error(problem); process.exit(1); }
  await db.init(); await migrate();
  const existing = await db.one('SELECT id FROM users WHERE username = ?', [username]);
  if (existing) { await db.exec('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), existing.id]); await db.exec('DELETE FROM sessions WHERE user_id = ?', [existing.id]); console.log(`Password updated for ${username}.`); }
  else { await db.exec('INSERT INTO users (username, password_hash, role, created_at) VALUES (?,?,?,?)', [username, hashPassword(password), 'admin', Date.now()]); console.log(`Admin user ${username} created.`); }
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
