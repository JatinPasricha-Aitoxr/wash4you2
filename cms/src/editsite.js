'use strict';
// The editable build of the site (every page rendered with data-cms bindings).
// Production: downloaded from the repo's `cms-edit` branch (built by GitHub Actions).
// Local development: just the repo's dist-edit/ folder.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('./config');

function dir() { return config.repoDriver === 'local' && !process.env.EDIT_SITE_DIR ? path.join(config.localRepoDir, 'dist-edit') : config.editSiteDir; }

function safeFile(rel) {
  const root = path.resolve(dir());
  let full = path.resolve(root, rel.replace(/^\/+/, ''));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'index.html');
  return fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
}
function status() {
  const root = dir();
  const has = fs.existsSync(path.join(root, 'index.html'));
  return { ready: has, dir: root, builtAt: has ? fs.statSync(path.join(root, 'index.html')).mtimeMs : null };
}
async function refresh() {
  const g = config.github;
  if (!g.token) throw new Error('GITHUB_TOKEN is not set');
  const res = await fetch(`https://api.github.com/repos/${g.owner}/${g.repo}/zipball/${encodeURIComponent(g.editBranch)}`, {
    headers: { Authorization: `Bearer ${g.token}`, 'User-Agent': 'wash4you-cms', Accept: 'application/vnd.github+json' }, redirect: 'follow',
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} downloading the ${g.editBranch} branch. Has the "Build editor site" workflow run yet?`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const root = path.resolve(config.editSiteDir);
  const tmp = root + '.new';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const rel = e.entryName.split('/').slice(1).join('/');          // drop the "<repo>-<sha>/" prefix
    if (!rel || rel.includes('..')) continue;
    const dest = path.resolve(tmp, rel);
    if (!dest.startsWith(tmp + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.getData());
  }
  fs.rmSync(root + '.old', { recursive: true, force: true });
  if (fs.existsSync(root)) fs.renameSync(root, root + '.old');
  fs.renameSync(tmp, root);
  fs.rmSync(root + '.old', { recursive: true, force: true });
  return status();
}
module.exports = { dir, safeFile, status, refresh };
