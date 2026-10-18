'use strict';
// One tiny async interface over MySQL (production) and node:sqlite (local
// development and tests): query(sql, params) -> rows, exec(sql, params) -> {insertId, changes}.
// SQL is kept portable (`?` placeholders, no vendor functions).
const config = require('./config');

let impl = null;

async function init(overrides = {}) {
  const driver = overrides.driver || config.dbDriver;
  if (driver === 'sqlite') {
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('fs');
    const path = require('path');
    const file = overrides.sqliteFile || config.db.sqliteFile;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    impl = {
      driver,
      async query(sql, params = []) { return db.prepare(sql).all(...params); },
      async exec(sql, params = []) {
        const r = db.prepare(sql).run(...params);
        return { insertId: Number(r.lastInsertRowid), changes: Number(r.changes) };
      },
      async script(sql) { db.exec(sql); },
      async close() { db.close(); },
    };
  } else {
    const mysql = require('mysql2/promise');
    const c = overrides.db || config.db;
    const pool = mysql.createPool({
      host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
      waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4', multipleStatements: false,
    });
    impl = {
      driver,
      async query(sql, params = []) { const [rows] = await pool.query(sql, params); return rows; },
      async exec(sql, params = []) {
        const [r] = await pool.query(sql, params);
        return { insertId: r.insertId, changes: r.affectedRows };
      },
      async script(sql) {
        for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await pool.query(stmt);
      },
      async close() { await pool.end(); },
    };
  }
  return impl;
}

const get = () => { if (!impl) throw new Error('db not initialised'); return impl; };
module.exports = {
  init,
  query: (...a) => get().query(...a),
  one: async (...a) => (await get().query(...a))[0] || null,
  exec: (...a) => get().exec(...a),
  script: (...a) => get().script(...a),
  close: async () => { if (impl) { await impl.close(); impl = null; } },
  driver: () => get().driver,
};
