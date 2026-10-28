-- Wash4You admin portal: MySQL schema (generated from cms/src/schema.js).
-- Import into the database you created in hPanel -> Databases -> phpMyAdmin -> Import.
-- Safe to re-run (CREATE TABLE IF NOT EXISTS). Creates tables only; no users or data.
-- Create the admin login afterwards with: npm run create-admin

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'admin',
  created_at BIGINT NOT NULL,
  last_login_at BIGINT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id INT NOT NULL,
  csrf VARCHAR(64) NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  INDEX (user_id), INDEX (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS login_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(64) NOT NULL,
  username VARCHAR(64) NOT NULL,
  at BIGINT NOT NULL,
  INDEX (ip, at), INDEX (username, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS drafts (
  path VARCHAR(255) PRIMARY KEY,
  content LONGTEXT NULL,
  data LONGBLOB NULL,
  kind VARCHAR(8) NOT NULL DEFAULT 'text',
  updated_by INT NULL,
  updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS revisions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(12) NOT NULL,
  message VARCHAR(255) NOT NULL,
  user_id INT NULL,
  commit_sha VARCHAR(64) NULL,
  created_at BIGINT NOT NULL,
  INDEX (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS revision_files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  revision_id INT NOT NULL,
  path VARCHAR(255) NOT NULL,
  content LONGTEXT NULL,
  data LONGBLOB NULL,
  kind VARCHAR(8) NOT NULL DEFAULT 'text',
  INDEX (revision_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS media_meta (
  path VARCHAR(255) PRIMARY KEY,
  alt VARCHAR(255) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL DEFAULT '',
  uploaded_by INT NULL,
  uploaded_at BIGINT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  action VARCHAR(48) NOT NULL,
  detail VARCHAR(500) NOT NULL DEFAULT '',
  ip VARCHAR(64) NOT NULL DEFAULT '',
  at BIGINT NOT NULL,
  INDEX (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
