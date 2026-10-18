'use strict';
// Content repository adapter. The site's content (src/data/*.json and
// src/assets/images/**) lives in Git. Two drivers behind one interface:
//   github - production: reads/writes through the GitHub REST API
//   local  - development/tests: a plain directory on disk
const fs = require('fs');
const path = require('path');
const config = require('./config');

const SAFE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9_\-./ ]+$/;
// The admin may only ever touch these locations in the repo.
const WRITABLE = [/^src\/data\/[A-Za-z0-9_\-/]+\.json$/, /^src\/assets\/images\/[A-Za-z0-9_\-/.]+$/];
function assertWritable(p) {
  if (!SAFE_PATH.test(p) || !WRITABLE.some((re) => re.test(p))) throw new Error(`path not allowed: ${p}`);
}

// ---------------------------------------------------------------- local
function localDriver(root) {
  const abs = (p) => {
    const full = path.resolve(root, p);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('path escapes repository');
    return full;
  };
  const walk = (dir, out) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, out); else out.push(f);
    }
  };
  return {
    name: 'local',
    async read(p) { const f = abs(p); return fs.existsSync(f) ? fs.readFileSync(f) : null; },
    async list(prefix) {
      const out = []; walk(abs(prefix), out);
      return out.map((f) => ({ path: path.relative(root, f).split(path.sep).join('/'), size: fs.statSync(f).size }));
    },
    async commit(files, message) {
      for (const [p, v] of Object.entries(files)) {
        assertWritable(p);
        const f = abs(p);
        if (v === null) { if (fs.existsSync(f)) fs.unlinkSync(f); continue; }
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, v);
      }
      return `local-${Date.now()}`;
    },
  };
}

// --------------------------------------------------------------- github
function githubDriver(g) {
  const api = (p, opts = {}) => fetch(`https://api.github.com/repos/${g.owner}/${g.repo}${p}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${g.token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'wash4you-cms', ...(opts.headers || {}),
    },
  });
  const json = async (res) => {
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  let treeCache = null;
  const invalidate = () => { treeCache = null; };
  async function tree() {
    if (treeCache && Date.now() - treeCache.at < 60e3) return treeCache.items;
    const d = await json(await api(`/git/trees/${encodeURIComponent(g.branch)}?recursive=1`));
    treeCache = { at: Date.now(), items: d.tree.filter((t) => t.type === 'blob') };
    return treeCache.items;
  }
  return {
    name: 'github',
    async read(p) {
      const res = await api(`/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(g.branch)}`,
        { headers: { Accept: 'application/vnd.github.raw+json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub ${res.status} reading ${p}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async list(prefix) {
      return (await tree()).filter((t) => t.path.startsWith(prefix)).map((t) => ({ path: t.path, size: t.size }));
    },
    // One atomic commit for all files (Git Data API).
    async commit(files, message) {
      for (const p of Object.keys(files)) assertWritable(p);
      const ref = await json(await api(`/git/ref/heads/${encodeURIComponent(g.branch)}`));
      const base = await json(await api(`/git/commits/${ref.object.sha}`));
      const entries = [];
      for (const [p, v] of Object.entries(files)) {
        if (v === null) { entries.push({ path: p, mode: '100644', type: 'blob', sha: null }); continue; }
        const blob = await json(await api('/git/blobs', { method: 'POST',
          body: JSON.stringify({ content: Buffer.from(v).toString('base64'), encoding: 'base64' }) }));
        entries.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const t = await json(await api('/git/trees', { method: 'POST',
        body: JSON.stringify({ base_tree: base.tree.sha, tree: entries }) }));
      const c = await json(await api('/git/commits', { method: 'POST',
        body: JSON.stringify({ message, tree: t.sha, parents: [ref.object.sha] }) }));
      await json(await api(`/git/refs/heads/${encodeURIComponent(g.branch)}`, { method: 'PATCH',
        body: JSON.stringify({ sha: c.sha, force: false }) }));
      invalidate();
      return c.sha;
    },
  };
}

function create(overrides = {}) {
  const driver = overrides.driver || config.repoDriver;
  if (driver === 'local') return localDriver(overrides.root || config.localRepoDir);
  if (!config.github.token && !overrides.github) throw new Error('GITHUB_TOKEN is not set');
  return githubDriver(overrides.github || config.github);
}
module.exports = { create, assertWritable, SAFE_PATH };
