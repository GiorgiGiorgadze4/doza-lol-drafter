/*
 * Doza LoL Drafter - zero-dependency Node server.
 *  - serves the browser app (public/, which also contains the shared rules engine)
 *  - hosts draft rooms; state is authoritative on the server
 *  - realtime updates via Server-Sent Events, actions via POST
 *
 *   node server.js            (PORT env var, default 3000)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./public/engine.js');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOM_TTL_MS = 48 * 3600 * 1000;
const MAX_ROOMS = 500;

const STATIC = {
  '/': path.join(__dirname, 'public'),
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/* ---------------- rooms ---------------- */

// room: { id, keys:{A,B,admin}, state, history:[state...], updatedAt }
const rooms = new Map();
const clients = new Map(); // roomId -> Set<{res, seat}>

function loadRooms() {
  try {
    const arr = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    for (const r of arr) if (Date.now() - r.updatedAt < ROOM_TTL_MS) rooms.set(r.id, r);
    console.log('Loaded ' + rooms.size + ' room(s)');
  } catch (_) { /* first run */ }
}
let saveTimer = null;
function saveRoomsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ROOMS_FILE + '.tmp', JSON.stringify([...rooms.values()]));
      fs.renameSync(ROOMS_FILE + '.tmp', ROOMS_FILE);
    } catch (e) { console.error('save failed', e.message); }
  }, 500);
}

function newId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do { id = Array.from(crypto.randomBytes(6), (b) => alphabet[b % alphabet.length]).join(''); } while (rooms.has(id));
  return id;
}
const token = () => crypto.randomBytes(12).toString('base64url');

function seatOf(room, key) {
  if (!key) return 'spectator';
  if (key === room.keys.admin) return 'admin';
  if (key === room.keys.A) return 'A';
  if (key === room.keys.B) return 'B';
  return 'spectator';
}

function presence(roomId) {
  const p = { A: 0, B: 0, admin: 0, spectator: 0 };
  for (const c of clients.get(roomId) || []) p[c.seat]++;
  return p;
}

function broadcast(room) {
  const msg = 'event: state\ndata: ' + JSON.stringify({ state: room.state, presence: presence(room.id), canUndo: room.history.length > 0, now: Date.now() }) + '\n\n';
  for (const c of clients.get(room.id) || []) c.res.write(msg);
}

function commit(room, next) {
  room.history.push(room.state);
  if (room.history.length > 40) room.history.shift();
  room.state = next;
  room.updatedAt = Date.now();
  saveRoomsSoon();
  broadcast(room);
}

// Clock: auto-pick when a turn expires.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const s = room.state;
    if (s.deadline && !s.paused && now >= s.deadline && s.phase !== 'done') {
      const r = E.apply(s, { type: 'timeout' }, now);
      if (r.ok) commit(room, r.state);
    }
  }
}, 250);

// Cleanup old rooms.
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) if (now - r.updatedAt > ROOM_TTL_MS && !(clients.get(id) || new Set()).size) rooms.delete(id);
  saveRoomsSoon();
}, 3600 * 1000);

// Keep SSE connections alive through proxies.
setInterval(() => {
  for (const set of clients.values()) for (const c of set) c.res.write(': ping\n\n');
}, 20000);

/* ---------------- http helpers ---------------- */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let base = STATIC['/'], rel = pathname;

  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(base, decodeURIComponent(rel)));
  if (!file.startsWith(base)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback
      if (!path.extname(rel)) return serveStatic(req, res, '/index.html');
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- routes ---------------- */

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (parts[1] === 'health') return sendJson(res, 200, { ok: true, rooms: rooms.size });

  if (parts[1] === 'rooms' && parts.length === 2 && req.method === 'POST') {
    if (rooms.size >= MAX_ROOMS) return sendJson(res, 503, { error: 'Server is full, try again later.' });
    const body = await readBody(req);
    let state;
    try { state = E.createDraft(Object.assign({}, body, { now: Date.now() })); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
    const room = { id: newId(), keys: { A: token(), B: token(), admin: token() }, state, history: [], updatedAt: Date.now() };
    room.state.id = room.id;
    rooms.set(room.id, room);
    saveRoomsSoon();
    return sendJson(res, 201, { roomId: room.id, keys: room.keys });
  }

  const room = rooms.get((parts[2] || '').toUpperCase());
  if (parts[1] !== 'rooms' || !room) return sendJson(res, 404, { error: 'Room not found' });
  const key = url.searchParams.get('key') || '';

  // GET /api/rooms/:id  -> snapshot + your seat
  if (parts.length === 3 && req.method === 'GET') {
    return sendJson(res, 200, { state: room.state, seat: seatOf(room, key), presence: presence(room.id), now: Date.now() });
  }

  // GET /api/rooms/:id/events  -> SSE stream
  if (parts[3] === 'events' && req.method === 'GET') {
    const seat = seatOf(room, key);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n');
    res.write('event: hello\ndata: ' + JSON.stringify({ seat }) + '\n\n');
    if (!clients.has(room.id)) clients.set(room.id, new Set());
    const c = { res, seat };
    clients.get(room.id).add(c);
    broadcast(room);
    req.on('close', () => { clients.get(room.id).delete(c); broadcast(room); });
    return;
  }

  // POST /api/rooms/:id/action  {key, action}
  if (parts[3] === 'action' && req.method === 'POST') {
    const body = await readBody(req);
    const seat = seatOf(room, body.key);
    if (seat === 'spectator') return sendJson(res, 403, { error: 'Spectators cannot act' });
    const action = Object.assign({}, body.action || {});

    if (action.type === 'undo') {
      if (seat !== 'admin') return sendJson(res, 403, { error: 'Admin only' });
      const prev = room.history.pop();
      if (!prev) return sendJson(res, 400, { error: 'Nothing to undo' });
      // restart the clock for the restored turn
      const restored = JSON.parse(JSON.stringify(prev));
      if (restored.deadline) {
        const secs = restored.phase === 'swap' ? restored.settings.swapTimer : restored.settings.pickTimer;
        restored.deadline = Date.now() + secs * 1000;
      }
      restored.seq = room.state.seq + 1;
      room.state = restored; room.updatedAt = Date.now();
      saveRoomsSoon(); broadcast(room);
      return sendJson(res, 200, { ok: true });
    }

    // Admin may act on behalf of a team (handy when the organiser drafts for someone).
    action.team = seat === 'admin' && E.TEAMS.includes(body.asTeam) ? body.asTeam : seat;
    if (action.type === 'timeout') return sendJson(res, 400, { error: 'Not allowed' });
    const r = E.apply(room.state, action, Date.now());
    if (!r.ok) return sendJson(res, 400, { error: r.error });
    commit(room, r.state);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message || 'Server error' });
  }
});

loadRooms();
server.listen(PORT, HOST, () => console.log('Doza LoL Drafter running on http://localhost:' + PORT));
