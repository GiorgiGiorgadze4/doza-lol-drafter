/*
 * Doza Drafter - local dev server (zero dependencies). The app itself is a pure static site in public/;
 * this only exists so rating edits made in the UI can be written back into the repo.
 *  - serves public/ with no caching
 *  - PUT /__dev/players  writes public/data/players.json (commit it to publish the new ratings)
 *  - live-reloads the page when files in public/ change
 *
 *   npm run dev            (PORT env var, default 5173)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const E = require('../public/engine.js');

const PORT = +process.env.PORT || 5173;
const ROOT = path.join(__dirname, '..', 'public');
const PLAYERS_FILE = path.join(ROOT, 'data', 'players.json');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

// One player per line keeps git diffs readable.
const formatPlayers = (players) => '[\n' + players.map((p) => '  ' + JSON.stringify(p)).join(',\n') + '\n]\n';

function writePlayers(body) {
  const list = JSON.parse(body);
  if (!Array.isArray(list)) throw new Error('Expected an array of players');
  const players = list.map(E.normalizePlayer);
  const names = new Set(players.map((p) => p.name.toLowerCase()));
  if (names.size !== players.length) throw new Error('Player names must be unique');
  fs.mkdirSync(path.dirname(PLAYERS_FILE), { recursive: true });
  fs.writeFileSync(PLAYERS_FILE + '.tmp', formatPlayers(players));
  fs.renameSync(PLAYERS_FILE + '.tmp', PLAYERS_FILE);
  return players.length;
}

const reloaders = new Set();
let reloadTimer = null;
fs.watch(ROOT, { recursive: true }, (_, file) => {
  if (!file || file.startsWith('data')) return; // roster saves come from the page itself
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { for (const res of reloaders) res.write('data: reload\n\n'); }, 100);
});

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/__dev') return send(res, 200, { ok: true });
  if (url.pathname === '/__dev/reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    res.write('retry: 1000\n\n');
    reloaders.add(res);
    return req.on('close', () => reloaders.delete(res));
  }
  if (url.pathname === '/__dev/players' && req.method === 'PUT') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { send(res, 200, { ok: true, count: writePlayers(body) }); }
      catch (e) { send(res, 400, { error: e.message }); }
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('Doza Drafter dev server: http://localhost:' + PORT);
  console.log('Rating edits are saved to public/data/players.json. Commit that file to publish them.');
});
