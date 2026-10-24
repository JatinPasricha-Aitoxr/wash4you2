'use strict';
// Static server for the built Wash4You site (entry file for Node hosting).
// Serves the prebuilt pages in this folder. Source, admin and tooling folders
// are never served.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// Local secrets: read .env when present (Hostinger sets real env vars instead).
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !m[1].startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env - fine */ }
const booking = require('./server/booking');
const PORT = parseInt(process.env.PORT || '3000', 10);
const BLOCKED_TOP = new Set(['src', 'cms', 'webapp', 'tools', 'node_modules', 'dist', 'dist-edit', 'dist2', 'content',
  'schemas', 'scripts', 'server', 'templates', 'client-assets', 'admin', 'menu', 'packages-src', '.git', '.github']);
const BLOCKED_FILES = new Set(['package.json', 'package-lock.json', 'requirements.txt', 'build.py', 'index.js',
  'vercel.json', 'readme.md', 'client-guide.md']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json',
};

function resolve(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (p.includes('\0')) return null;
  const full = path.resolve(ROOT, '.' + path.posix.normalize('/' + p));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  const rel = path.relative(ROOT, full).split(path.sep);
  if (rel[0] && (BLOCKED_TOP.has(rel[0].toLowerCase()) || rel[0].startsWith('.'))) return null;
  if (rel.length === 1 && BLOCKED_FILES.has(rel[0].toLowerCase())) return null;
  return full;
}

http.createServer((req, res) => {
  if (booking.handle(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  let file = resolve(req.url);
  const notFound = () => {
    const nf = path.join(ROOT, '404.html');
    res.writeHead(404, { 'Content-Type': TYPES['.html'] });
    res.end(req.method === 'HEAD' ? undefined : (fs.existsSync(nf) ? fs.readFileSync(nf) : 'Not found'));
  };
  if (!file) return notFound();
  try {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!req.url.split('?')[0].endsWith('/')) { res.writeHead(301, { Location: req.url.replace(/^([^?]*)/, '$1/') }); return res.end(); }
      file = path.join(file, 'index.html');
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return notFound();
    const ext = path.extname(file).toLowerCase();
    const long = /\.(css|js|woff2?|png|jpe?g|webp|gif|svg|ico|mp4)$/.test(ext) && /[?&]v=/.test(req.url);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': fs.statSync(file).size,
      'Cache-Control': ext === '.html' ? 'no-cache' : (long ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'),
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch { res.writeHead(500); res.end('Server error'); }
}).listen(PORT, () => console.log(`Wash4You site on :${PORT}`));
