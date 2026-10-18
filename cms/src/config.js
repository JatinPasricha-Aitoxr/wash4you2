'use strict';
// Environment configuration. Real values come from the host's environment
// (Hostinger hPanel -> Node.js app -> Environment variables). A local `.env`
// file is read for development only; it is gitignored and never required.
const fs = require('fs');
const path = require('path');

function loadDotenv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotenv(path.join(__dirname, '..', '.env'));

const env = process.env;
const config = {
  isProd: env.NODE_ENV === 'production',
  port: parseInt(env.PORT || '3000', 10),
  // 'mysql' in production, 'sqlite' for local development and the tests.
  dbDriver: env.DB_DRIVER || 'mysql',
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: parseInt(env.DB_PORT || '3306', 10),
    user: env.DB_USER || '',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || '',
    sqliteFile: env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'cms.sqlite'),
  },
  // Where the site content lives: 'github' (production) or 'local' (a checkout).
  repoDriver: env.REPO_DRIVER || 'github',
  github: {
    token: env.GITHUB_TOKEN || '',
    owner: env.GITHUB_OWNER || 'JatinPasricha-Aitoxr',
    repo: env.GITHUB_REPO || 'wash4you2',
    branch: env.GITHUB_BRANCH || 'main',
    editBranch: env.GITHUB_EDIT_BRANCH || 'cms-edit',
  },
  localRepoDir: env.LOCAL_REPO_DIR || path.join(__dirname, '..', '..'),
  // The editable build of the site (rendered with data-cms bindings). In
  // production it is downloaded from the cms-edit branch; locally it is the
  // repo's dist-edit/ folder.
  editSiteDir: env.EDIT_SITE_DIR || path.join(__dirname, '..', 'data', 'edit-site'),
  publicSiteUrl: env.PUBLIC_SITE_URL || 'https://wash4you.in',
  sessionHours: parseInt(env.SESSION_HOURS || '12', 10),
  maxUploadBytes: parseInt(env.MAX_UPLOAD_BYTES || String(8 * 1024 * 1024), 10),
};
module.exports = config;
