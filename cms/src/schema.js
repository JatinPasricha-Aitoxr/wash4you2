'use strict';
const db = require('./db');

// Idempotent schema setup (safe to run on every start). Content lives in the
// GitHub repo; MySQL holds accounts, sessions, drafts, revisions, media
// metadata and the audit log.
const MYSQL = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'admin',
  created_at BIGINT NOT NULL,
  last_login_at BIGINT NULL
) CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id INT NOT NULL,
  csrf VARCHAR(64) NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  INDEX (user_id), INDEX (expires_at)
) CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS login_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(64) NOT NULL,
  username VARCHAR(64) NOT NULL,
  at BIGINT NOT NULL,
  INDEX (ip, at), INDEX (username, at)
) CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS drafts (
  path VARCHAR(255) PRIMARY KEY,
  content LONGTEXT NULL,
  data LONGBLOB NULL,
  kind VARCHAR(8) NOT NULL DEFAULT 'text',
  updated_by INT NULL,
  updated_at BIGINT NOT NULL
) CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS revisions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(12) NOT NULL,
  message VARCHAR(255) NOT NULL,
  user_id INT NULL,
  commit_sha VARCHAR(64) NULL,
  created_at BIGINT NOT NULL,
  INDEX (created_at)
) CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS revision_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  revision_id INT NOT NULL,
  path VARCHAR(255) NOT NULL,
  content LONGTEXT NULL,
  data LONGBLOB NULL,
  kind VARCHAR(8) NOT NULL DEFAULT 'text',
  INDEX (revision_id)
) CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS media_meta (
  path VARCHAR(255) PRIMARY KEY,
  alt VARCHAR(255) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL DEFAULT '',
  uploaded_by INT NULL,
  uploaded_at BIGINT NULL
) CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  action VARCHAR(48) NOT NULL,
  detail VARCHAR(500) NOT NULL DEFAULT '',
  ip VARCHAR(64) NOT NULL DEFAULT '',
  at BIGINT NOT NULL,
  INDEX (at)
) CHARACTER SET utf8mb4;
`;

const SQLITE = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL, username TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  path TEXT PRIMARY KEY, content TEXT, data BLOB,
  kind TEXT NOT NULL DEFAULT 'text', updated_by INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, message TEXT NOT NULL, user_id INTEGER,
  commit_sha TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revision_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL, path TEXT NOT NULL,
  content TEXT, data BLOB, kind TEXT NOT NULL DEFAULT 'text'
);
CREATE TABLE IF NOT EXISTS media_meta (
  path TEXT PRIMARY KEY, alt TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
  uploaded_by INTEGER, uploaded_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL
);
`;

async function migrate() {
  await db.script(db.driver() === 'sqlite' ? SQLITE : MYSQL);
}
module.exports = { migrate };
