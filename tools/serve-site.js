'use strict';
// serve-site.js - minimal static server for the ompjob docs site.
//
//   node tools/serve-site.js <rootDir> [port]
//
// Deliberately narrow, because this sits behind a public hostname:
//   - binds 127.0.0.1 only, so the port is unreachable except via the tunnel
//   - never lists a directory; a directory resolves to its index.html or 404
//   - refuses any path that escapes the root after normalization
//   - serves GET/HEAD only
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', 'site'));
const port = Number(process.argv[3] || 8795);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveTarget(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); }
  catch { return null; }
  // Normalize first, THEN confirm containment: catches ../ and encoded variants.
  const abs = path.resolve(root, '.' + path.posix.normalize(p));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      const idx = path.join(abs, 'index.html');
      return fs.existsSync(idx) ? idx : null;   // never a listing
    }
    return abs;
  } catch { return null; }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD' });
    return res.end('method not allowed\n');
  }

  const file = resolveTarget(req.url || '/');
  const headers = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'public, max-age=300',
  };

  if (!file) {
    const custom = path.join(root, '404.html');
    if (fs.existsSync(custom)) {
      const body = fs.readFileSync(custom);
      res.writeHead(404, Object.assign({}, headers, {
        'content-type': TYPES['.html'], 'content-length': body.length }));
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    res.writeHead(404, Object.assign({}, headers, { 'content-type': 'text/plain' }));
    return res.end('not found\n');
  }

  let body;
  try { body = fs.readFileSync(file); }
  catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    return res.end('read error\n');
  }

  res.writeHead(200, Object.assign({}, headers, {
    'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': body.length,
  }));
  res.end(req.method === 'HEAD' ? undefined : body);
});

// Loopback only: Cloudflare Tunnel is the sole path in.
server.listen(port, '127.0.0.1', () => {
  console.log('ompjob docs on http://127.0.0.1:' + port + ' from ' + root);
});
