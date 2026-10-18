/* Doza LoL Drafter - browser app (vanilla JS, hash router). */
(function () {
  'use strict';
  const E = window.DraftEngine;
  const { ROLES, ROLE_NAMES } = E;
  const $app = document.getElementById('app');

  /* =========================================================
   * Utilities
   * ======================================================= */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('doza.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('doza.' + k, JSON.stringify(v)); } catch (_) { toast('Could not save (localStorage full or blocked)', 'err'); } },
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const qs = (sel, el) => (el || document).querySelector(sel);

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 4500 : 2500);
  }
  function stars(n, opts) {
    opts = opts || {};
    let s = '<span class="stars' + (opts.edit ? ' edit' : '') + '"' + (opts.attrs || '') + '>';
    for (let i = 1; i <= 5; i++) s += '<i class="' + (i <= n ? 'on' : '') + '" data-v="' + i + '">★</i>';
    return s + '</span>';
  }
  const roleTag = (r) => '<span class="role ' + r + '" title="' + ROLE_NAMES[r] + '">' + r + '</span>';
  const bestRole = (p) => ROLES.reduce((b, r) => (p.ratings[r] > p.ratings[b] ? r : b), ROLES[0]);
  const bestRating = (p) => Math.max(...ROLES.map((r) => p.ratings[r]));
  const sumRating = (p) => ROLES.reduce((s, r) => s + p.ratings[r], 0);
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'ok'); }
    catch (_) { prompt('Copy this:', text); }
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function fmtDate(ms) { return new Date(ms).toLocaleString(); }
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = 880; g.gain.value = 0.06;
      o.connect(g); g.connect(ctx.destination); o.start();
      o.frequency.setValueAtTime(660, ctx.currentTime + 0.12);
      o.stop(ctx.currentTime + 0.25);
    } catch (_) { /* no audio */ }
  }

  /* =========================================================
   * Data: player pool, setup, rooms, local drafts, history
   * ======================================================= */
  const SAMPLE = [
    ['Doza', 4, 3, 5, 2, 2], ['Kruger', 5, 3, 2, 1, 2], ['Vexa', 2, 2, 3, 5, 3], ['Mirko', 2, 5, 3, 2, 3],
    ['Luka', 1, 2, 2, 3, 5], ['Ivy', 3, 4, 3, 3, 3], ['Brann', 4, 2, 1, 2, 4], ['Sela', 2, 3, 4, 4, 2],
    ['Torvin', 3, 3, 2, 2, 4], ['Nika', 2, 4, 4, 1, 3], ['Ralph', 3, 1, 2, 4, 3], ['Jinxo', 1, 2, 3, 5, 2],
    ['Grom', 5, 4, 2, 1, 1], ['Pela', 2, 2, 2, 3, 4],
  ];
  function samplePool() {
    return SAMPLE.map(([name, ...v]) => ({ id: uid(), name, ratings: Object.fromEntries(ROLES.map((r, i) => [r, v[i]])) }));
  }
  function getPool() {
    let p = LS.get('pool', null);
    if (!p) { p = samplePool(); LS.set('pool', p); }
    return p;
  }
  const setPool = (p) => LS.set('pool', p);

  function defaultSetup() {
    return {
      selected: [], teamNames: { A: '', B: '' },
      captains: { A: { playerId: '', name: '' }, B: { playerId: '', name: '' } },
      settings: Object.assign({}, E.DEFAULT_SETTINGS),
    };
  }
  function getSetup() {
    const s = Object.assign(defaultSetup(), LS.get('setup', {}));
    s.settings = Object.assign({}, E.DEFAULT_SETTINGS, s.settings);
    return s;
  }
  const setSetup = (s) => LS.set('setup', s);

  const getRooms = () => LS.get('rooms', []);
  function rememberRoom(r) {
    const rooms = getRooms().filter((x) => !(x.id === r.id && x.key === r.key));
    rooms.unshift(Object.assign({ at: Date.now() }, r));
    LS.set('rooms', rooms.slice(0, 30));
  }
  const getLocals = () => LS.get('local', {});
  const setLocals = (l) => LS.set('local', l);
  const getHistory = () => LS.get('history', []);
  function saveToHistory(state, mode) {
    const h = getHistory();
    if (h.some((x) => x.id === state.id && x.finishedAt === state.finishedAt)) return;
    h.unshift({ id: state.id, finishedAt: state.finishedAt, mode, state });
    LS.set('history', h.slice(0, 200));
    toast('Draft saved to history', 'ok');
  }

  /* =========================================================
   * Server detection
   * ======================================================= */
  let SERVER = null;
  async function checkServer() {
    const el = document.getElementById('server-status');
    if (location.protocol === 'file:') SERVER = false;
    else {
      try { const r = await fetch('api/health', { cache: 'no-store' }); SERVER = r.ok && (await r.json()).ok === true; }
      catch (_) { SERVER = false; }
    }
    el.className = 'server-status ' + (SERVER ? 'on' : 'off');
    el.textContent = SERVER ? 'Online server' : 'Offline (local mode only)';
    return SERVER;
  }

  /* =========================================================
   * Router
   * ======================================================= */
  let cleanup = null;
  function route() {
    if (cleanup) { try { cleanup(); } catch (_) { } cleanup = null; }
    $app.onclick = $app.oninput = $app.onchange = null;
    document.onkeydown = null;
    document.title = 'Doza Drafter';
    const h = location.hash.slice(1) || '/';
    const [path, query] = h.split('?');
    const q = new URLSearchParams(query || '');
    const parts = path.split('/').filter(Boolean);
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (parts[0] || 'home')));
    window.scrollTo(0, 0);
    switch (parts[0]) {
      case undefined: return viewHome();
      case 'players': return viewPlayers();
      case 'setup': return viewSetup();
      case 'history': return parts[1] != null ? viewHistoryItem(+parts[1]) : viewHistory();
      case 'rules': return viewRules();
      case 'room': return viewRoom(parts[1].toUpperCase(), q.get('k') || '');
      case 'local': return viewLocal(parts[1]);
      default: location.hash = '#/';
    }
  }

  /* =========================================================
   * Home
   * ======================================================= */
  function viewHome() {
    const rooms = getRooms();
    const locals = Object.entries(getLocals()).sort((a, b) => b[1].state.createdAt - a[1].state.createdAt);
    const seatLabel = { A: 'Captain A', B: 'Captain B', admin: 'Organizer', spectator: 'Spectator' };
    $app.innerHTML = `
      <section class="hero">
        <h1>Captain Draft</h1>
        <p>Two captains draft 10 players one by one. Every pick is a player <b>and</b> a role, worth that player's star rating on it. Each team has a star cap, so the teams stay balanced.</p>
        <div class="row" style="justify-content:center">
          <a class="btn gold big" href="#/setup">New draft</a>
          <a class="btn big" href="#/players">Manage players</a>
        </div>
      </section>
      <div class="grid2">
        <div class="panel">
          <h2>Join a room</h2>
          <p class="muted">Paste the invite link you were sent, or enter a 6-letter room code to watch.</p>
          <form class="row" id="join">
            <input class="grow" name="code" placeholder="Invite link or room code" autocomplete="off">
            <button class="btn primary">Join</button>
          </form>
          ${SERVER === false ? '<p class="alert warn small" style="margin-top:12px">No draft server found. Online rooms need the Node server (<span class="kbd">npm start</span>). Local hot-seat drafts still work.</p>' : ''}
        </div>
        <div class="panel">
          <h2>Your drafts</h2>
          <div class="list">
            ${locals.map(([id, l]) => `
              <div class="list-item">
                <span class="badge gold">Local</span>
                <div class="grow"><b>${esc(l.state.teamNames.A)}</b> vs <b>${esc(l.state.teamNames.B)}</b>
                  <div class="small muted">${fmtDate(l.state.createdAt)} · ${l.state.phase}</div></div>
                <a class="btn small" href="#/local/${id}">Open</a>
                <button class="btn small danger" data-act="del-local" data-id="${id}">✕</button>
              </div>`).join('')}
            ${rooms.map((r, i) => `
              <div class="list-item">
                <span class="badge ${r.seat === 'A' ? 'blue' : r.seat === 'B' ? 'red' : ''}">${seatLabel[r.seat] || r.seat}</span>
                <div class="grow"><span class="code">${esc(r.id)}</span> ${r.teamNames ? `· <b>${esc(r.teamNames.A)}</b> vs <b>${esc(r.teamNames.B)}</b>` : ''}
                  <div class="small muted">${fmtDate(r.at)}</div></div>
                <a class="btn small" href="#/room/${r.id}?k=${encodeURIComponent(r.key || '')}">Open</a>
                <button class="btn small danger" data-act="del-room" data-i="${i}">✕</button>
              </div>`).join('')}
            ${!rooms.length && !locals.length ? '<p class="muted">No drafts yet. Start one from <a href="#/setup">New draft</a>.</p>' : ''}
          </div>
        </div>
      </div>
      <div class="panel">
        <h2>How it works</h2>
        <div class="grid3">
          <div><h3>1 · Rate players</h3><p class="muted">On <a href="#/players">Players</a>, rate everyone 1–5 stars on each role. It's saved in this browser, and you can export or import it as JSON or CSV.</p></div>
          <div><h3>2 · Pick 10 &amp; captains</h3><p class="muted">Choose the 10 players for tonight and two captains. The app sets a star cap per team from what the players could score at their best.</p></div>
          <div><h3>3 · Draft</h3><p class="muted">Send each captain their link. They pick one by one in snake order and give each pick a role. Picks that would break the cap, or leave the draft unfinishable, are blocked.</p></div>
        </div>
      </div>`;

    qs('#join').onsubmit = (e) => {
      e.preventDefault();
      const v = e.target.code.value.trim();
      if (!v) return;
      const m = v.match(/#\/room\/([A-Za-z0-9]+)(\?k=([^&\s]+))?/);
      if (m) location.hash = '#/room/' + m[1].toUpperCase() + (m[3] ? '?k=' + m[3] : '');
      else if (/^[A-Za-z0-9]{4,8}$/.test(v)) {
        const known = getRooms().find((r) => r.id === v.toUpperCase());
        location.hash = '#/room/' + v.toUpperCase() + (known ? '?k=' + encodeURIComponent(known.key) : '');
      } else toast('That is not a room code or invite link', 'err');
    };
    $app.onclick = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'del-local' && confirm('Delete this local draft?')) {
        const l = getLocals(); delete l[b.dataset.id]; setLocals(l); viewHome();
      }
      if (b.dataset.act === 'del-room') {
        const r = getRooms(); r.splice(+b.dataset.i, 1); LS.set('rooms', r); viewHome();
      }
    };
  }

  /* =========================================================
   * Players (pool editor)
   * ======================================================= */
  function viewPlayers() {
    let sort = { key: 'name', dir: 1 };
    let search = '';
    $app.innerHTML = `
      <div class="panel">
        <div class="row" style="margin-bottom:12px">
          <h2 style="margin:0">Player pool</h2>
          <span class="badge" id="pcount"></span>
          <input id="search" placeholder="Search…" class="right" style="width:200px">
        </div>
        <p class="muted small">Click the stars to rate each role from 1 (can't play it) to 5 (main or very strong). Changes save automatically.</p>
        <div class="table-wrap">
          <table class="tbl" id="ptable">
            <thead><tr>
              <th class="sortable" data-sort="name">Name</th>
              ${ROLES.map((r) => `<th class="sortable" data-sort="${r}">${roleTag(r)}</th>`).join('')}
              <th class="sortable" data-sort="best">Best</th>
              <th class="sortable" data-sort="sum">Total</th>
              <th></th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <form class="row" id="add" style="margin-top:14px">
          <input name="name" placeholder="New player name" maxlength="32" required>
          <button class="btn primary">+ Add player</button>
        </form>
      </div>
      <div class="panel">
        <h2>Import / Export</h2>
        <p class="muted small">JSON: an array of <span class="kbd">{"name":"Doza","ratings":{"TOP":4,"JNG":3,"MID":5,"ADC":2,"SUP":2}}</span>.
        CSV: one player per line as <span class="kbd">name,top,jng,mid,adc,sup</span>. Importing adds new players and updates existing ones with the same name.</p>
        <textarea id="io" placeholder="Paste JSON or CSV here…"></textarea>
        <div class="row" style="margin-top:10px">
          <button class="btn primary" data-act="import">Import from text</button>
          <label class="btn">Import file<input type="file" id="file" accept=".json,.csv,.txt" hidden></label>
          <button class="btn" data-act="export">Export JSON</button>
          <button class="btn" data-act="export-csv">Copy as CSV</button>
          <span class="grow"></span>
          <button class="btn" data-act="sample">Add sample players</button>
          <button class="btn danger" data-act="clear">Delete all</button>
        </div>
      </div>`;

    function drawTable() {
      const pool = getPool();
      qs('#pcount').textContent = pool.length + ' players';
      let rows = pool.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()));
      const val = (p) => sort.key === 'name' ? p.name.toLowerCase() : sort.key === 'best' ? bestRating(p) : sort.key === 'sum' ? sumRating(p) : p.ratings[sort.key];
      rows.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * (sort.key === 'name' ? sort.dir : -sort.dir));
      qs('#ptable tbody').innerHTML = rows.map((p) => `
        <tr data-pid="${p.id}">
          <td><input class="name" value="${esc(p.name)}" maxlength="32" data-act="rename"></td>
          ${ROLES.map((r) => `<td>${stars(p.ratings[r], { edit: true, attrs: ` data-role="${r}"` })}</td>`).join('')}
          <td>${roleTag(bestRole(p))}</td>
          <td class="muted">${sumRating(p)}</td>
          <td><button class="btn small danger" data-act="del" title="Delete">✕</button></td>
        </tr>`).join('') || '<tr><td colspan="9" class="muted">No players.</td></tr>';
    }
    drawTable();

    function importText(text) {
      text = text.trim();
      if (!text) return toast('Nothing to import', 'err');
      let incoming = [];
      try {
        if (text[0] === '[' || text[0] === '{') {
          const data = JSON.parse(text);
          incoming = (Array.isArray(data) ? data : data.players || []).map((p) => E.normalizePlayer(Object.assign({ id: uid() }, p)));
        } else {
          for (const line of text.split(/\r?\n/)) {
            const c = line.split(/[,;\t]/).map((x) => x.trim());
            if (c.length < 6 || !c[0] || isNaN(+c[1])) continue; // skips header lines
            incoming.push(E.normalizePlayer({ id: uid(), name: c[0], ratings: Object.fromEntries(ROLES.map((r, i) => [r, +c[i + 1]])) }));
          }
        }
      } catch (e) { return toast('Could not parse: ' + e.message, 'err'); }
      if (!incoming.length) return toast('No players found in input', 'err');
      const pool = getPool();
      let added = 0, updated = 0;
      for (const p of incoming) {
        const ex = pool.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
        if (ex) { ex.ratings = p.ratings; updated++; } else { pool.push(p); added++; }
      }
      setPool(pool); drawTable();
      toast(`Imported: ${added} added, ${updated} updated`, 'ok');
    }

    qs('#search').oninput = (e) => { search = e.target.value; drawTable(); };
    qs('#add').onsubmit = (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      const pool = getPool();
      if (pool.some((p) => p.name.toLowerCase() === name.toLowerCase())) return toast('Name already exists', 'err');
      pool.push({ id: uid(), name, ratings: { TOP: 3, JNG: 3, MID: 3, ADC: 3, SUP: 3 } });
      setPool(pool); e.target.reset(); drawTable();
    };
    qs('#file').onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      f.text().then(importText); e.target.value = '';
    };
    $app.onchange = (e) => {
      if (e.target.dataset.act !== 'rename') return;
      const pid = e.target.closest('tr').dataset.pid;
      const name = e.target.value.trim();
      const pool = getPool();
      if (!name || pool.some((p) => p.id !== pid && p.name.toLowerCase() === name.toLowerCase())) {
        toast('Name must be unique and not empty', 'err'); return drawTable();
      }
      pool.find((p) => p.id === pid).name = name; setPool(pool);
    };
    $app.onclick = (e) => {
      const th = e.target.closest('th[data-sort]');
      if (th) { sort = { key: th.dataset.sort, dir: sort.key === th.dataset.sort ? -sort.dir : 1 }; return drawTable(); }
      const star = e.target.closest('.stars.edit i');
      if (star) {
        const pid = star.closest('tr').dataset.pid, role = star.parentElement.dataset.role;
        const pool = getPool(); pool.find((p) => p.id === pid).ratings[role] = +star.dataset.v;
        setPool(pool); return drawTable();
      }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'del') {
        const pid = b.closest('tr').dataset.pid;
        const pool = getPool(); const p = pool.find((x) => x.id === pid);
        if (confirm('Delete ' + p.name + '?')) { setPool(pool.filter((x) => x.id !== pid)); drawTable(); }
      } else if (act === 'import') importText(qs('#io').value);
      else if (act === 'export') {
        const json = JSON.stringify(getPool().map(({ name, ratings }) => ({ name, ratings })), null, 2);
        qs('#io').value = json; download('doza-players.json', json);
      } else if (act === 'export-csv') {
        const csv = 'name,top,jng,mid,adc,sup\n' + getPool().map((p) => [p.name, ...ROLES.map((r) => p.ratings[r])].join(',')).join('\n');
        qs('#io').value = csv; copy(csv);
      } else if (act === 'sample') { importText(JSON.stringify(samplePool())); }
      else if (act === 'clear' && confirm('Delete ALL players from this browser?')) { setPool([]); drawTable(); }
    };
  }

  /* =========================================================
   * Setup (choose 10 + captains + rules)
   * ======================================================= */
  function viewSetup() {
    const setup = getSetup();
    const pool = getPool();
    setup.selected = setup.selected.filter((id) => pool.some((p) => p.id === id));
    let search = '';
    const st = setup.settings;

    $app.innerHTML = `
      <div class="grid2" style="align-items:start">
        <div class="panel">
          <div class="row" style="margin-bottom:10px">
            <h2 style="margin:0">Tonight's 10</h2>
            <span class="badge" id="selcount"></span>
            <span class="grow"></span>
            <input id="search" placeholder="Search…" style="width:140px">
            <button class="btn small" data-act="random">Random</button>
            <button class="btn small" data-act="clearsel">Clear</button>
          </div>
          <div class="pick-pool" id="selpool"></div>
          <p class="small muted" style="margin-top:10px">Missing someone? Add them on <a href="#/players">Players</a>.</p>
        </div>
        <div>
          <div class="panel">
            <h2>Teams &amp; captains</h2>
            <label class="check" style="margin-bottom:12px"><input type="checkbox" data-set="captainsArePlayers" ${st.captainsArePlayers ? 'checked' : ''}> Captains are among the 10 players</label>
            <div class="grid2" id="caps"></div>
          </div>
          <div class="panel">
            <h2>Rules</h2>
            <div class="fields">
              <label class="field">Cap tolerance
                <input type="number" min="0" max="10" data-set="tolerance" value="${st.tolerance}">
                <span class="hint">Stars allowed above an even split</span></label>
              <label class="field">Fixed cap
                <input type="number" min="0" max="25" data-set="capOverride" value="${st.capOverride}">
                <span class="hint">0 = automatic</span></label>
              <label class="field">Min role rating
                <select data-set="minRoleRating">${[1, 2, 3].map((v) => `<option value="${v}" ${st.minRoleRating == v ? 'selected' : ''}>${v}★${v === 1 ? ' (any role)' : ''}</option>`).join('')}</select>
                <span class="hint">Can't place a player on a role rated lower</span></label>
              <label class="field">Pick timer (s)
                <input type="number" min="0" max="600" data-set="pickTimer" value="${st.pickTimer}">
                <span class="hint">0 = no timer. When time runs out, the best legal pick is made</span></label>
              <label class="field">Pick order
                <select data-set="pickOrder">
                  <option value="snake" ${st.pickOrder === 'snake' ? 'selected' : ''}>Snake (A B B A A B…)</option>
                  <option value="alternate" ${st.pickOrder === 'alternate' ? 'selected' : ''}>Alternate (A B A B…)</option>
                </select></label>
              <label class="field">Swap phase (s)
                <input type="number" min="0" max="600" data-set="swapTimer" value="${st.swapTimer}">
                <span class="hint">0 = no timer</span></label>
            </div>
            <label class="check" style="margin-top:12px"><input type="checkbox" data-set="swapPhase" ${st.swapPhase ? 'checked' : ''}> Role-swap phase after the draft (captains can swap roles inside their own team; the cap still applies)</label>
          </div>
          <div class="panel" id="preview"></div>
        </div>
      </div>`;

    const save = () => setSetup(setup);

    function drawSel() {
      qs('#selcount').textContent = setup.selected.length + ' / 10';
      qs('#selcount').className = 'badge ' + (setup.selected.length === 10 ? 'ok' : '');
      const list = pool.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => (setup.selected.includes(b.id) - setup.selected.includes(a.id)) || a.name.localeCompare(b.name));
      qs('#selpool').innerHTML = list.map((p) => `
        <div class="pp ${setup.selected.includes(p.id) ? 'sel' : ''}" data-pid="${p.id}">
          <input type="checkbox" ${setup.selected.includes(p.id) ? 'checked' : ''} tabindex="-1">
          <div class="grow">
            <div class="nm">${esc(p.name)}</div>
            <div class="mini">${ROLES.map((r) => `<span>${r} <b>${p.ratings[r]}</b></span>`).join('')}</div>
          </div>
          ${roleTag(bestRole(p))}
        </div>`).join('') || '<p class="muted">Your player pool is empty. <a href="#/players">Add players</a>.</p>';
    }

    function drawCaps() {
      const sel = setup.selected.map((id) => pool.find((p) => p.id === id));
      for (const t of E.TEAMS) if (setup.captains[t].playerId && !setup.selected.includes(setup.captains[t].playerId)) setup.captains[t].playerId = '';
      qs('#caps').innerHTML = E.TEAMS.map((t) => `
        <div>
          <label class="field">Team ${t} name
            <input data-team="${t}" value="${esc(setup.teamNames[t])}" placeholder="Team ${t}" maxlength="32"></label>
          ${st.captainsArePlayers ? `
          <label class="field" style="margin-top:8px">Captain ${t}
            <select data-cap="${t}">
              <option value="">— choose a player —</option>
              ${sel.map((p) => `<option value="${p.id}" ${setup.captains[t].playerId === p.id ? 'selected' : ''} ${setup.captains[E.other(t)].playerId === p.id ? 'disabled' : ''}>${esc(p.name)}</option>`).join('')}
            </select></label>` : `
          <label class="field" style="margin-top:8px">Captain ${t} name
            <input data-capname="${t}" value="${esc(setup.captains[t].name)}" placeholder="Captain ${t}" maxlength="32"></label>`}
        </div>`).join('');
    }

    function buildOpts() {
      return {
        players: setup.selected.map((id) => pool.find((p) => p.id === id)),
        captains: {
          A: { playerId: st.captainsArePlayers ? setup.captains.A.playerId : null, name: st.captainsArePlayers ? '' : setup.captains.A.name },
          B: { playerId: st.captainsArePlayers ? setup.captains.B.playerId : null, name: st.captainsArePlayers ? '' : setup.captains.B.name },
        },
        teamNames: { A: setup.teamNames.A, B: setup.teamNames.B },
        settings: st,
      };
    }

    function drawPreview() {
      const el = qs('#preview');
      let err = null, s = null;
      if (setup.selected.length !== 10) err = 'Select exactly 10 players (' + setup.selected.length + ' selected).';
      else if (st.captainsArePlayers && (!setup.captains.A.playerId || !setup.captains.B.playerId)) err = 'Choose both captains (or untick "Captains are among the 10 players").';
      else { try { s = E.createDraft(Object.assign(buildOpts(), { firstPick: 'A' })); } catch (e) { err = e.message; } }
      const avg = s ? (s.best / 10).toFixed(1) : '–';
      el.innerHTML = `
        <h2>Preview</h2>
        ${err ? `<div class="alert err">${esc(err)}</div>` : `
        <div class="stat-grid">
          <div class="stat"><div class="v">${s.best}</div><div class="k">Best possible total</div></div>
          <div class="stat"><div class="v">${s.cap}★</div><div class="k">Cap per team</div></div>
          <div class="stat"><div class="v">${avg}</div><div class="k">Avg ★ per player</div></div>
          <div class="stat"><div class="v">${s.order.length}</div><div class="k">Picks</div></div>
        </div>
        ${s.autoCapRaised ? `<div class="alert warn small" style="margin-top:10px">The cap was raised by ${s.autoCapRaised} so a full draft is still possible.</div>` : ''}
        <p class="small muted" style="margin-top:12px">Pick order (the first pick is a coin flip, and the team that picks second gets blue side):</p>
        <div class="order-strip">${s.order.map((t) => `<span class="${t}">${t}</span>`).join('')}</div>
        <div class="alert ok small" style="margin-top:12px">Ready. Each team can bring at most <b>${s.cap}★</b>; an even split of the best total would be ${s.best % 2 ? Math.floor(s.best / 2) + '–' + Math.ceil(s.best / 2) : s.best / 2}★ each.</div>`}
        <div class="row" style="margin-top:14px">
          <button class="btn gold" data-act="online" ${err || !SERVER ? 'disabled' : ''}>Create online room</button>
          <button class="btn primary" data-act="local" ${err ? 'disabled' : ''}>Local hot-seat draft</button>
        </div>
        ${SERVER ? '' : '<p class="small muted" style="margin-top:8px">Online rooms need the Node server to be running.</p>'}`;
    }

    drawSel(); drawCaps(); drawPreview();

    qs('#search').oninput = (e) => { search = e.target.value; drawSel(); };
    $app.oninput = (e) => {
      const t = e.target;
      if (t.dataset.team) { setup.teamNames[t.dataset.team] = t.value; save(); }
      else if (t.dataset.capname) { setup.captains[t.dataset.capname].name = t.value; save(); }
      else if (t.dataset.set && t.type === 'number') { st[t.dataset.set] = +t.value; save(); drawPreview(); }
    };
    $app.onchange = (e) => {
      const t = e.target;
      if (t.dataset.cap) { setup.captains[t.dataset.cap].playerId = t.value; save(); drawCaps(); drawPreview(); }
      else if (t.dataset.set) {
        st[t.dataset.set] = t.type === 'checkbox' ? t.checked : t.tagName === 'SELECT' && t.dataset.set !== 'pickOrder' ? +t.value : t.type === 'number' ? +t.value : t.value;
        save(); if (t.dataset.set === 'captainsArePlayers') drawCaps(); drawPreview();
      }
    };
    $app.onclick = async (e) => {
      const card = e.target.closest('.pp');
      if (card) {
        const id = card.dataset.pid;
        if (setup.selected.includes(id)) setup.selected = setup.selected.filter((x) => x !== id);
        else if (setup.selected.length >= 10) return toast('Already 10 selected', 'err');
        else setup.selected.push(id);
        save(); drawSel(); drawCaps(); drawPreview(); return;
      }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'random') {
        const ids = pool.map((p) => p.id).sort(() => Math.random() - 0.5).slice(0, 10);
        setup.selected = ids; save(); drawSel(); drawCaps(); drawPreview();
      } else if (b.dataset.act === 'clearsel') { setup.selected = []; save(); drawSel(); drawCaps(); drawPreview(); }
      else if (b.dataset.act === 'local') {
        let s;
        try { s = E.createDraft(buildOpts()); } catch (err) { return toast(err.message, 'err'); }
        const id = 'L' + uid();
        s.id = id;
        const l = getLocals(); l[id] = { state: s, history: [] }; setLocals(l);
        location.hash = '#/local/' + id;
      } else if (b.dataset.act === 'online') {
        b.disabled = true;
        try {
          const r = await fetch('api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildOpts()) });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Could not create room');
          const tn = { A: setup.teamNames.A || 'Team A', B: setup.teamNames.B || 'Team B' };
          LS.set('keys.' + d.roomId, d.keys);
          rememberRoom({ id: d.roomId, key: d.keys.admin, seat: 'admin', teamNames: tn });
          location.hash = '#/room/' + d.roomId + '?k=' + encodeURIComponent(d.keys.admin);
        } catch (err) { toast(err.message, 'err'); b.disabled = false; }
      }
    };
  }

  /* =========================================================
   * Draft HUD (shared by online, local and history views)
   * ======================================================= */
  const roomLink = (id, key) => location.origin + location.pathname + '#/room/' + id + (key ? '?k=' + encodeURIComponent(key) : '');

  function createDraftView(ctx) {
    // ctx: { mode: 'online'|'local'|'view', seat, act(action, team), undo(), now(), keys?, onDone(state) }
    const ui = { sel: null, role: null, filter: 'ALL', swapSel: null, actAs: '', lastSeq: null, presence: null, canUndo: false, wasMyTurn: false };
    let state = null;
    let ticker = null;

    function myTeams() {
      if (ctx.mode === 'local') return ['A', 'B'];
      if (ctx.mode === 'view') return [];
      if (ctx.seat === 'A' || ctx.seat === 'B') return [ctx.seat];
      if (ctx.seat === 'admin' && ui.actAs) return [ui.actAs];
      return [];
    }
    const isAdmin = () => ctx.mode === 'local' || ctx.seat === 'admin';
    const act = (action, team) => ctx.act(action, team);

    function update(newState, extra) {
      const prevSeq = state ? state.seq : null;
      state = newState;
      if (extra) Object.assign(ui, extra);
      ui.lastSeq = prevSeq;
      draw();
      ui.lastSeq = state.seq; // only animate a fresh pick once
      if (state.phase === 'done' && ctx.onDone) ctx.onDone(state);
    }

    function isTurn(t) {
      if (state.phase === 'draft') return E.currentTeam(state) === t;
      if (state.phase === 'captains') return !state.locked[t];
      if (state.phase === 'swap' || state.phase === 'lobby') return !state.ready[t];
      return false;
    }

    function phaseInfo() {
      const s = state;
      const N = s.order.length;
      switch (s.phase) {
        case 'lobby': return { label: 'Lobby', who: 'Waiting for both captains' };
        case 'captains': return { label: 'Captain roles', who: 'Captains pick their own roles' };
        case 'draft': { const t = E.currentTeam(s); return { label: `Pick ${s.pickIndex + 1} of ${N}`, who: esc(s.teamNames[t]) + ' is picking', team: t }; }
        case 'swap': return { label: 'Swap phase', who: 'Swap roles inside your team' };
        case 'done': return { label: 'Draft complete', who: 'GLHF' };
      }
      return { label: s.phase, who: '' };
    }

    function banner(t) {
      const s = state, side = s.sides[t];
      const used = E.teamStars(s, t), pct = Math.min(100, (used / s.cap) * 100);
      const online = ctx.mode === 'online' && ui.presence;
      const capName = s.captains[t].name;
      const status = s.phase === 'lobby' ? (s.ready[t] ? ' · <b style="color:var(--ok)">READY</b>' : '')
        : s.phase === 'swap' ? (s.ready[t] ? ' · <b style="color:var(--ok)">READY</b>' : ' · swapping…') : '';
      return `
        <div class="team-banner ${side} ${isTurn(t) && s.phase !== 'done' ? 'turn' : ''}">
          <div class="tn">${esc(s.teamNames[t])}</div>
          <div class="sub">${online ? `<span class="dot ${ui.presence[t] ? 'on' : ''}" title="${ui.presence[t] ? 'connected' : 'offline'}"></span>` : ''}Captain ${esc(capName)} · <span class="badge ${side}">${side} side</span>${s.firstPick === t ? ' · first pick' : ''}${status}</div>
          <div class="budget">
            <div class="bar"><div class="fill ${used >= s.cap ? 'full' : ''}" style="width:${pct}%"></div></div>
            <div class="lbl"><span><b>${used}</b> / ${s.cap}★ used</span><span>${s.cap - used}★ left · ${E.openRoles(s, t).length} open</span></div>
          </div>
        </div>`;
    }

    function slotsHtml(t) {
      const s = state;
      const last = s.log[s.log.length - 1];
      const fresh = ui.lastSeq != null && s.seq !== ui.lastSeq && last && last.team === t && (last.kind === 'pick' || last.kind === 'captain') ? last.role : null;
      const canSwap = s.phase === 'swap' && myTeams().includes(t) && !s.ready[t];
      return `<div class="slots ${s.sides[t]}-side">` + ROLES.map((r) => {
        const pid = s.teams[t].slots[r];
        const p = pid && E.playerById(s, pid);
        if (!p) {
          const pend = s.captains[t].playerId && !s.locked[t] ? `<span class="small">reserved for ${esc(E.playerById(s, s.captains[t].playerId).name)}?</span>` : '<span class="small">empty</span>';
          return `<div class="slot empty">${roleTag(r)}${pend}<span></span></div>`;
        }
        let alt = '';
        let cls = '';
        if (canSwap) {
          cls = ' swappable';
          if (ui.swapSel && ui.swapSel.team === t) {
            if (ui.swapSel.role === r) cls += ' swap-sel';
            else {
              const c = E.checkSwap(s, t, ui.swapSel.role, r);
              alt = `<div class="alt">${c.ok ? `swap → ${c.delta >= 0 ? '+' : ''}${c.delta}★` : esc(c.reason)}</div>`;
            }
          }
        }
        const isCap = s.captains[t].playerId === pid;
        return `<div class="slot filled${cls}${fresh === r ? ' new' : ''}" data-team="${t}" data-role="${r}">
          ${roleTag(r)}
          <div><div class="pn">${esc(p.name)}${isCap ? '<span class="cap">♛ CAPT</span>' : ''}</div>${stars(p.ratings[r])}${alt}</div>
          <div class="sv">${p.ratings[r]}</div>
        </div>`;
      }).join('') + '</div>';
    }

    function pcard(p, legalRoles, clickable, turnTeam) {
      const open = turnTeam ? E.openRoles(state, turnTeam) : [];
      const has = legalRoles && legalRoles.size > 0;
      return `<div class="pcard ${ui.sel === p.id ? 'sel' : ''} ${clickable ? '' : 'idle'} ${turnTeam && !has ? 'nolegal' : ''}" data-pid="${p.id}">
        <div class="nm"><span>${esc(p.name)}</span>${roleTag(bestRole(p))}</div>
        <div class="rr">${ROLES.map((r) => `<span class="rl ${open.includes(r) ? 'open' : ''}">${r}</span>
          <span class="${legalRoles && legalRoles.has(r) ? 'hl' : ''}">${stars(p.ratings[r])}</span>`).join('')}</div>
      </div>`;
    }

    function centerDraft() {
      const s = state;
      const turn = E.currentTeam(s);
      const mine = myTeams().includes(turn);
      const legal = E.legalPicks(s, turn);
      const legalBy = new Map();
      for (const l of legal) { if (!legalBy.has(l.playerId)) legalBy.set(l.playerId, new Set()); legalBy.get(l.playerId).add(l.role); }
      let list = E.pool(s);
      if (ui.sel && !list.some((p) => p.id === ui.sel)) ui.sel = null;
      const f = ui.filter;
      list = list.slice().sort((a, b) => f === 'ALL' ? (bestRating(b) - bestRating(a) || sumRating(b) - sumRating(a)) : (b.ratings[f] - a.ratings[f] || bestRating(b) - bestRating(a)));
      let lock = '';
      if (mine) {
        const p = ui.sel && E.playerById(s, ui.sel);
        if (p) {
          const opts = E.openRoles(s, turn).map((r) => {
            const c = E.checkPick(s, turn, p.id, r);
            return `<button class="role-btn ${ui.role === r ? 'on' : ''}" data-pickrole="${r}" ${c.ok ? '' : 'disabled'} title="${c.ok ? '' : esc(c.reason)}">
              ${roleTag(r)} ${stars(p.ratings[r])}
              ${c.ok ? `<span class="small muted">→ ${E.teamStars(s, turn) + p.ratings[r]}/${s.cap}★</span>` : `<span class="why">${esc(c.reason)}</span>`}
            </button>`;
          }).join('');
          const ok = ui.role && E.checkPick(s, turn, p.id, ui.role).ok;
          lock = `<div class="lockbar">
            <div><div class="small muted">Selected</div><div style="font-weight:700;font-size:16px">${esc(p.name)}</div></div>
            <div class="role-btns grow">${opts}</div>
            <button class="btn gold big" data-act="lockin" ${ok ? '' : 'disabled'}>Lock in</button>
          </div>`;
        } else {
          lock = `<div class="lockbar"><b style="color:var(--gold2)">Your pick!</b><span class="muted">Choose a player, then a role. Highlighted stars mark legal role options.</span></div>`;
        }
      } else {
        lock = `<div class="lockbar"><span class="muted">Waiting for <b>${esc(s.teamNames[turn])}</b> to pick…</span></div>`;
      }
      return `
        <div class="center-head">
          <h2 style="margin:0">Available players</h2><span class="badge">${E.pool(s).length}</span>
          <div class="tabs right">${['ALL', ...ROLES].map((r) => `<button class="${ui.filter === r ? 'on' : ''}" data-filter="${r}">${r === 'ALL' ? 'Best' : r}</button>`).join('')}</div>
        </div>
        <div class="pool">${list.map((p) => pcard(p, legalBy.get(p.id), mine, turn)).join('')}</div>
        ${lock}`;
    }

    function centerCaptains() {
      const s = state;
      return `<h2>Captains lock their roles</h2>
        <p class="muted">Captains are players too. Each captain picks their own role first; it counts toward their team's cap.</p>
        <div class="grid2">${E.TEAMS.map((t) => {
          const pid = s.captains[t].playerId;
          if (!pid) return `<div class="lobby-cap"><div class="tn">${esc(s.teamNames[t])}</div><p class="muted">Captain isn't playing.</p></div>`;
          const p = E.playerById(s, pid);
          const lockedRole = ROLES.find((r) => s.teams[t].slots[r] === pid);
          const can = myTeams().includes(t) && !s.locked[t];
          return `<div class="lobby-cap ${s.locked[t] ? 'ready' : ''}">
            <div class="tn">${esc(p.name)}</div><div class="small muted">${esc(s.teamNames[t])}</div>
            <div style="margin-top:12px">${lockedRole ? `Locked: ${roleTag(lockedRole)} ${stars(p.ratings[lockedRole])}`
              : can ? `<div class="role-btns" style="justify-content:center">${ROLES.map((r) => {
                const c = E.checkCaptainLock(s, t, r);
                return `<button class="role-btn" data-caplock="${r}" data-team="${t}" ${c.ok ? '' : 'disabled'} title="${esc(c.reason || '')}">${roleTag(r)}${stars(p.ratings[r])}${c.ok ? '' : `<span class="why">${esc(c.reason)}</span>`}</button>`;
              }).join('')}</div>`
              : '<span class="muted">Choosing…</span>'}</div>
          </div>`;
        }).join('')}</div>`;
    }

    function centerLobby() {
      const s = state;
      const mine = myTeams();
      return `<h2>Lobby</h2>
        <p class="muted">The draft starts when both captains click Ready${isAdmin() ? ', or when you force-start it' : ''}. The first pick was decided by coin flip: <b>${esc(s.teamNames[s.firstPick])}</b>.</p>
        <div class="grid2">${E.TEAMS.map((t) => `
          <div class="lobby-cap ${s.ready[t] ? 'ready' : ''}">
            <div class="tn">${esc(s.teamNames[t])}</div>
            <div class="small muted">Captain ${esc(s.captains[t].name)}${ctx.mode === 'online' && ui.presence ? (ui.presence[t] ? ' · connected' : ' · not connected') : ''}</div>
            <div style="margin-top:12px">${ctx.mode === 'local' ? '' : mine.includes(t)
              ? `<button class="btn ${s.ready[t] ? '' : 'gold'}" data-act="ready" data-team="${t}" data-v="${!s.ready[t]}">${s.ready[t] ? 'Not ready' : 'Ready'}</button>`
              : `<span class="badge ${s.ready[t] ? 'ok' : ''}">${s.ready[t] ? 'Ready' : 'Not ready'}</span>`}</div>
          </div>`).join('')}</div>
        ${isAdmin() ? `<div class="row" style="margin-top:14px;justify-content:center"><button class="btn gold big" data-act="force">Start draft</button></div>` : ''}
        <h3 style="margin-top:20px">The 10 players</h3>
        <div class="pool">${s.players.map((p) => pcard(p, null, false, null)).join('')}</div>`;
    }

    function centerSwap() {
      const s = state;
      const mine = myTeams();
      return `<h2>Swap phase</h2>
        <p class="muted">Want to shuffle roles? Click two players on your team to swap their roles. The cap still applies. Click Ready when you're happy with the lineup.</p>
        <div class="grid2">${E.TEAMS.map((t) => `
          <div class="lobby-cap ${s.ready[t] ? 'ready' : ''}">
            <div class="tn">${esc(s.teamNames[t])}</div>
            <div class="small muted">${E.teamStars(s, t)} / ${s.cap}★</div>
            <div style="margin-top:12px">${mine.includes(t)
              ? `<button class="btn ${s.ready[t] ? '' : 'gold'}" data-act="ready" data-team="${t}" data-v="${!s.ready[t]}" ${s.ready[t] ? 'disabled' : ''}>${s.ready[t] ? 'Ready ✓' : 'Ready'}</button>`
              : `<span class="badge ${s.ready[t] ? 'ok' : ''}">${s.ready[t] ? 'Ready' : 'Swapping…'}</span>`}</div>
          </div>`).join('')}</div>`;
    }

    function centerDone() {
      const s = state;
      const a = E.teamStars(s, 'A'), b = E.teamStars(s, 'B');
      return `<div style="text-align:center">
          <h1>Draft complete</h1>
          <div class="final">${E.TEAMS.map((t) => `<div class="lobby-cap"><div class="tn">${esc(s.teamNames[t])}</div>
            <div class="vs">${E.teamStars(s, t)}★</div><span class="badge ${s.sides[t]}">${s.sides[t]} side</span>
            <div class="small muted" style="margin-top:6px">Estimated win: ${Math.round(E.winChance(E.teamStars(s, t), E.teamStars(s, E.other(t))) * 100)}%</div></div>`).join('')}</div>
          <p class="muted" style="margin-top:14px">Difference: ${Math.abs(a - b)}★ · cap was ${s.cap}★</p>
          <div class="row" style="justify-content:center">
            <button class="btn gold" data-act="copy">Copy lineup for Discord</button>
            <button class="btn" data-act="export">Download JSON</button>
            <button class="btn primary" data-act="again">New draft with these 10</button>
          </div>
        </div>`;
    }

    function bottom() {
      const s = state;
      const L = s.sides.A === 'blue' ? 'A' : 'B', R = E.other(L);
      const sl = E.teamStars(s, L), sr = E.teamStars(s, R);
      const p = E.winChance(sl, sr);
      const nm = (id) => esc((E.playerById(s, id) || {}).name || '?');
      const log = s.log.slice().reverse().map((e) => {
        if (e.kind === 'swap') return `<div class="${e.team}">${esc(s.teamNames[e.team])} swapped ${roleTag(e.r1)} ↔ ${roleTag(e.r2)}</div>`;
        const p = E.playerById(s, e.playerId);
        return `<div class="${e.team}">${e.kind === 'captain' ? '♛' : '#' + e.n} <b>${esc(s.teamNames[e.team])}</b> → ${nm(e.playerId)} ${roleTag(e.role)} ${stars(p.ratings[e.role])}${e.auto ? ' <span class="badge">auto</span>' : ''}</div>`;
      }).join('') || '<span class="muted small">No picks yet.</span>';

      let admin = '';
      if (isAdmin() && ctx.mode !== 'view') {
        const links = ctx.mode === 'online' && ctx.keys ? `
          <h3 style="margin-top:14px">Invite links</h3>
          ${[['Captain A', ctx.keys.A, 'A'], ['Captain B', ctx.keys.B, 'B'], ['Spectators', '', null]].map(([lbl, k, t]) => `
            <div class="share" style="margin-bottom:6px"><span class="small">${t ? esc(s.teamNames[t]) : lbl}</span>
              <input readonly value="${esc(roomLink(s.id, k))}"><button class="btn small" data-copy="${esc(roomLink(s.id, k))}">Copy</button></div>`).join('')}` : '';
        admin = `<div class="panel"><h2>${ctx.mode === 'local' ? 'Controls' : 'Organizer'}</h2>
          <div class="row">
            ${s.deadline || s.paused ? `<button class="btn" data-act="${s.paused ? 'resume' : 'pause'}">${s.paused ? '▶ Resume' : '⏸ Pause timer'}</button>` : ''}
            <button class="btn" data-act="undo" ${ui.canUndo ? '' : 'disabled'}>↶ Undo</button>
            ${ctx.mode === 'online' ? `<label class="field" style="flex-direction:row;align-items:center;gap:6px">Act as
              <select data-actas><option value="">Nobody</option>${E.TEAMS.map((t) => `<option value="${t}" ${ui.actAs === t ? 'selected' : ''}>${esc(s.teamNames[t])}</option>`).join('')}</select></label>` : ''}
          </div>${links}</div>`;
      } else if (ctx.mode === 'online') {
        admin = `<div class="panel"><h2>Room <span class="code">${esc(s.id)}</span></h2>
          <p class="small muted">You are ${ctx.seat === 'spectator' ? 'spectating' : 'captain of <b>' + esc(s.teamNames[ctx.seat]) + '</b>'}.</p>
          <div class="share"><span class="small">Spectate</span><input readonly value="${esc(roomLink(s.id))}"><button class="btn small" data-copy="${esc(roomLink(s.id))}">Copy</button></div></div>`;
      }

      return `<div class="grid3" style="margin-top:16px">
        <div class="panel">
          <h2>Balance</h2>
          <div class="meter"><div class="a" style="width:${(p * 100).toFixed(1)}%"></div><div class="b"></div></div>
          <div class="meter-lbl"><span><b>${esc(s.teamNames[L])}</b> ${sl}★ · ${Math.round(p * 100)}%</span><span>${Math.round((1 - p) * 100)}% · ${sr}★ <b>${esc(s.teamNames[R])}</b></span></div>
          <p class="small muted" style="margin-top:12px">Pick order</p>
          <div class="order-strip">${s.order.map((t, i) => `<span class="${t} ${i < s.pickIndex || s.phase === 'swap' || s.phase === 'done' ? 'done' : ''} ${s.phase === 'draft' && i === s.pickIndex ? 'now' : ''}">${t}</span>`).join('')}</div>
          <p class="small muted" style="margin-top:12px">Cap ${s.cap}★ · min role ${s.settings.minRoleRating}★ · ${s.settings.pickTimer ? s.settings.pickTimer + 's per pick' : 'no timer'}</p>
        </div>
        <div class="panel"><h2>Pick log</h2><div class="log">${log}</div></div>
        ${admin || '<div></div>'}
      </div>`;
    }

    function draw() {
      const s = state;
      const L = s.sides.A === 'blue' ? 'A' : 'B', R = E.other(L);
      const pi = phaseInfo();
      let center = '';
      if (s.phase === 'lobby') center = centerLobby();
      else if (s.phase === 'captains') center = centerCaptains();
      else if (s.phase === 'draft') center = centerDraft();
      else if (s.phase === 'swap') center = centerSwap();
      else center = centerDone();

      const conn = ctx.mode === 'online' && ui.disconnected ? '<div class="alert warn" style="margin-bottom:12px">Connection lost. Reconnecting…</div>' : '';
      $app.innerHTML = conn + `
        <div class="hud">
          <div class="hud-top">
            ${banner(L)}
            <div class="clock">
              <div class="phase">${pi.label}</div>
              <div class="time" id="clock-time">${s.deadline || s.paused ? '' : '∞'}</div>
              <div class="who">${pi.who}</div>
              <div class="tbar"><div id="clock-bar" style="width:${s.deadline ? 100 : 0}%"></div></div>
            </div>
            ${banner(R)}
          </div>
          <aside>${slotsHtml(L)}</aside>
          <section class="hud-center panel">${center}</section>
          <aside>${slotsHtml(R)}</aside>
        </div>
        ${bottom()}`;
      tick();

      // Your-turn notification
      const myTurn = s.phase === 'draft' && myTeams().includes(E.currentTeam(s)) && ctx.mode === 'online';
      if (myTurn && !ui.wasMyTurn) beep();
      ui.wasMyTurn = myTurn;
      document.title = (myTurn ? '▶ YOUR PICK · ' : '') + s.teamNames.A + ' vs ' + s.teamNames.B;
    }

    function tick() {
      const el = document.getElementById('clock-time'), bar = document.getElementById('clock-bar');
      if (!el || !state) return;
      let rem;
      if (state.paused) rem = state.pausedRemaining;
      else if (state.deadline) rem = Math.max(0, state.deadline - ctx.now());
      else return;
      const secs = Math.ceil(rem / 1000);
      el.textContent = state.paused ? '⏸ ' + secs : secs;
      el.classList.toggle('low', !state.paused && secs <= 10);
      const total = (state.phase === 'swap' ? state.settings.swapTimer : state.settings.pickTimer) * 1000;
      if (bar && total) bar.style.width = Math.min(100, (rem / total) * 100) + '%';
      if (ctx.onTick && !state.paused && rem <= 0) ctx.onTick();
    }
    ticker = setInterval(tick, 200);

    // ---------- interaction ----------
    const turnTeam = () => {
      const t = E.currentTeam(state);
      return t && myTeams().includes(t) ? t : null;
    };
    function lockIn() {
      const t = turnTeam();
      if (!t || !ui.sel || !ui.role) return;
      const action = { type: 'pick', playerId: ui.sel, role: ui.role };
      ui.sel = null; ui.role = null;
      act(action, t);
    }
    $app.onclick = (e) => {
      if (!state) return;
      const cp = e.target.closest('[data-copy]');
      if (cp) return copy(cp.dataset.copy);
      const f = e.target.closest('[data-filter]');
      if (f) { ui.filter = f.dataset.filter; return draw(); }
      const card = e.target.closest('.pcard');
      if (card && state.phase === 'draft' && turnTeam()) {
        ui.sel = card.dataset.pid;
        const t = turnTeam();
        const legal = E.legalPicks(state, t).filter((l) => l.playerId === ui.sel).sort((a, b) => b.stars - a.stars);
        ui.role = legal.length ? legal[0].role : null;
        return draw();
      }
      const pr = e.target.closest('[data-pickrole]');
      if (pr) { ui.role = pr.dataset.pickrole; return draw(); }
      const cl = e.target.closest('[data-caplock]');
      if (cl) return act({ type: 'lockCaptain', role: cl.dataset.caplock }, cl.dataset.team);
      const slot = e.target.closest('.slot.swappable');
      if (slot) {
        const t = slot.dataset.team, r = slot.dataset.role;
        if (!ui.swapSel || ui.swapSel.team !== t) { ui.swapSel = { team: t, role: r }; return draw(); }
        if (ui.swapSel.role === r) { ui.swapSel = null; return draw(); }
        const r1 = ui.swapSel.role; ui.swapSel = null;
        const c = E.checkSwap(state, t, r1, r);
        if (!c.ok) { toast(c.reason, 'err'); return draw(); }
        return act({ type: 'swap', r1, r2: r }, t);
      }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      switch (b.dataset.act) {
        case 'lockin': return lockIn();
        case 'ready': return act({ type: 'ready', value: b.dataset.v === 'true' }, b.dataset.team);
        case 'force': return act({ type: 'forceStart' }, 'admin');
        case 'pause': return act({ type: 'pause' }, 'admin');
        case 'resume': return act({ type: 'resume' }, 'admin');
        case 'undo': return ctx.undo();
        case 'copy': return copy(E.summary(state));
        case 'export': return download('draft-' + state.id + '.json', JSON.stringify(state, null, 2));
        case 'again': {
          const setup = getSetup();
          const pool = getPool();
          // map draft players back to pool ids by name (pool ids may differ for imported drafts)
          setup.selected = state.players.map((p) => (pool.find((x) => x.id === p.id || x.name.toLowerCase() === p.name.toLowerCase()) || {}).id).filter(Boolean);
          setSetup(setup);
          location.hash = '#/setup';
        }
      }
    };
    $app.onchange = (e) => {
      if (e.target.matches('[data-actas]')) { ui.actAs = e.target.value; ui.sel = null; draw(); }
    };
    document.onkeydown = (e) => {
      if (e.key === 'Enter' && state && state.phase === 'draft' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) lockIn();
      if (e.key === 'Escape') { ui.sel = null; ui.role = null; ui.swapSel = null; if (state) draw(); }
    };

    return {
      update,
      setMeta(extra) { Object.assign(ui, extra); if (state) draw(); },
      destroy() { clearInterval(ticker); document.onkeydown = null; },
      get state() { return state; },
    };
  }

  /* =========================================================
   * Online room
   * ======================================================= */
  function viewRoom(id, key) {
    $app.innerHTML = '<div class="panel"><h2>Connecting to room <span class="code">' + esc(id) + '</span>…</h2></div>';
    let es = null, offset = 0, dead = false, view = null, seat = 'spectator';

    const ctx = {
      mode: 'online', seat, keys: null,
      now: () => Date.now() + offset,
      async act(action, team) {
        const body = { key, action };
        if (seat === 'admin' && E.TEAMS.includes(team)) body.asTeam = team;
        try {
          const r = await fetch('api/rooms/' + id + '/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const d = await r.json();
          if (!r.ok) toast(d.error || 'Action failed', 'err');
        } catch (_) { toast('Network error', 'err'); }
      },
      undo() { return ctx.act({ type: 'undo' }); },
      onDone(s) { saveToHistory(s, 'online'); },
    };

    (async () => {
      let d;
      try {
        const r = await fetch('api/rooms/' + id + '?key=' + encodeURIComponent(key), { cache: 'no-store' });
        d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Room not found');
      } catch (e) {
        if (dead) return;
        $app.innerHTML = `<div class="panel"><h2>Room ${esc(id)} unavailable</h2><p class="muted">${esc(e.message)}. The room may have expired (after 48h) or the server is down.</p><a class="btn" href="#/">Back</a></div>`;
        return;
      }
      if (dead) return;
      seat = ctx.seat = d.seat;
      if (seat === 'admin') ctx.keys = LS.get('keys.' + id, null);
      if (key && seat === 'spectator') toast('That invite key is not valid. Joining as spectator.', 'err');
      rememberRoom({ id, key: seat === 'spectator' ? '' : key, seat, teamNames: d.state.teamNames });
      offset = d.now - Date.now();
      view = createDraftView(ctx);
      view.update(d.state, { presence: d.presence });

      es = new EventSource('api/rooms/' + id + '/events?key=' + encodeURIComponent(key));
      es.addEventListener('state', (ev) => {
        const m = JSON.parse(ev.data);
        offset = m.now - Date.now();
        view.update(m.state, { presence: m.presence, canUndo: m.canUndo, disconnected: false });
      });
      es.onerror = () => { if (!dead && view) view.setMeta({ disconnected: true }); };
    })();

    cleanup = () => { dead = true; if (es) es.close(); if (view) view.destroy(); };
  }

  /* =========================================================
   * Local hot-seat draft
   * ======================================================= */
  function viewLocal(id) {
    const locals = getLocals();
    const rec = locals[id];
    if (!rec) { $app.innerHTML = '<div class="panel"><h2>Local draft not found</h2><a class="btn" href="#/">Back</a></div>'; return; }
    let history = rec.history || [];
    function persist(state) {
      const l = getLocals(); l[id] = { state, history: history.slice(-40) }; setLocals(l);
    }
    function commit(next) {
      history.push(view.state);
      persist(next);
      view.update(next, { canUndo: history.length > 0 });
    }
    const ctx = {
      mode: 'local', seat: 'admin',
      now: () => Date.now(),
      act(action, team) {
        const r = E.apply(view.state, Object.assign({}, action, { team }), Date.now());
        if (!r.ok) return toast(r.error, 'err');
        commit(r.state);
      },
      undo() {
        const prev = history.pop();
        if (!prev) return;
        const s = JSON.parse(JSON.stringify(prev));
        if (s.deadline) s.deadline = Date.now() + (s.phase === 'swap' ? s.settings.swapTimer : s.settings.pickTimer) * 1000;
        s.seq = view.state.seq + 1;
        persist(s);
        view.update(s, { canUndo: history.length > 0 });
      },
      onTick() {
        const r = E.apply(view.state, { type: 'timeout' }, Date.now());
        if (r.ok) commit(r.state);
      },
      onDone(s) { saveToHistory(s, 'local'); },
    };
    // Resuming an old local draft: give the current turn a fresh clock instead of insta-autopicking.
    const s0 = rec.state;
    if (s0.deadline && !s0.paused && s0.deadline < Date.now()) s0.deadline = Date.now() + (s0.phase === 'swap' ? s0.settings.swapTimer : s0.settings.pickTimer) * 1000;
    const view = createDraftView(ctx);
    view.update(s0, { canUndo: history.length > 0 });
    cleanup = () => view.destroy();
  }

  /* =========================================================
   * History
   * ======================================================= */
  function viewHistory() {
    const h = getHistory();
    $app.innerHTML = `<div class="panel">
      <div class="row" style="margin-bottom:12px"><h2 style="margin:0">Finished drafts</h2><span class="badge">${h.length}</span>
        <span class="grow"></span>
        <button class="btn small" data-act="export" ${h.length ? '' : 'disabled'}>Export all</button>
        <label class="btn small">Import<input type="file" id="hfile" accept=".json" hidden></label>
        <button class="btn small danger" data-act="clear" ${h.length ? '' : 'disabled'}>Clear</button></div>
      <div class="list">${h.map((x, i) => {
        const s = x.state, a = E.teamStars(s, 'A'), b = E.teamStars(s, 'B');
        return `<div class="list-item">
          <span class="badge ${x.mode === 'online' ? 'blue' : 'gold'}">${x.mode}</span>
          <div class="grow"><b>${esc(s.teamNames.A)}</b> ${a}★ vs ${b}★ <b>${esc(s.teamNames.B)}</b>
            <div class="small muted">${fmtDate(s.finishedAt)} · cap ${s.cap}★ · Δ ${Math.abs(a - b)}★</div></div>
          <a class="btn small" href="#/history/${i}">View</a>
          <button class="btn small" data-act="copy" data-i="${i}">Copy</button>
          <button class="btn small danger" data-act="del" data-i="${i}">✕</button>
        </div>`;
      }).join('') || '<p class="muted">No finished drafts yet. They are saved here automatically when a draft ends.</p>'}</div></div>`;
    qs('#hfile').onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      f.text().then((t) => {
        try {
          const arr = JSON.parse(t);
          const list = (Array.isArray(arr) ? arr : [arr]).map((x) => (x.state ? x : { id: x.id, finishedAt: x.finishedAt, mode: 'import', state: x }))
            .filter((x) => x.state && x.state.teams && x.state.players);
          LS.set('history', list.concat(getHistory()).slice(0, 200));
          toast('Imported ' + list.length + ' draft(s)', 'ok'); viewHistory();
        } catch (err) { toast('Invalid file: ' + err.message, 'err'); }
      });
    };
    $app.onclick = (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const hist = getHistory();
      if (b.dataset.act === 'export') download('doza-history.json', JSON.stringify(hist, null, 2));
      if (b.dataset.act === 'copy') copy(E.summary(hist[+b.dataset.i].state));
      if (b.dataset.act === 'del') { hist.splice(+b.dataset.i, 1); LS.set('history', hist); viewHistory(); }
      if (b.dataset.act === 'clear' && confirm('Clear all history?')) { LS.set('history', []); viewHistory(); }
    };
  }

  function viewHistoryItem(i) {
    const x = getHistory()[i];
    if (!x) { location.hash = '#/history'; return; }
    const view = createDraftView({ mode: 'view', seat: 'spectator', now: () => Date.now(), act() { }, undo() { } });
    view.update(x.state);
    cleanup = () => view.destroy();
  }

  /* =========================================================
   * Rules page
   * ======================================================= */
  function viewRules() {
    $app.innerHTML = `<div class="panel rules">
      <h1>Draft rules</h1>
      <h2>Ratings</h2>
      <p>Every player is rated <b>1–5 stars</b> on each role (Top, Jungle, Mid, Bot/ADC, Support). A player's value on a team is their rating <b>on the role they were drafted to</b>. A 5★ mid placed on support with 2★ counts as 2★, and plays like it.</p>
      <h2>The star cap</h2>
      <ul>
        <li>The app finds the <b>best possible total</b>: the most stars the 10 players can reach across the 10 role slots when everyone is placed perfectly.</li>
        <li>Each team's cap is <b>half of that, rounded up, plus the tolerance</b> (default +1). You can also set a fixed cap.</li>
        <li>A pick is <b>legal</b> only if it keeps the team at or under the cap <b>and</b> the rest of the draft can still finish with both teams under the cap. You can never get stuck at the last pick.</li>
        <li>If you run low on stars, you can place a strong player on a weaker role. That costs fewer stars, but the player is weaker there too. Planning this is part of the strategy.</li>
      </ul>
      <h2>Draft flow</h2>
      <ol>
        <li><b>Lobby</b>: the organizer sends each captain their private link. The draft starts when both click Ready, or when the organizer force-starts it.</li>
        <li><b>Captain roles</b> (when captains are players): each captain locks their own role first. It counts toward their cap.</li>
        <li><b>Picks</b>: one player at a time in <b>snake order</b> (A B B A A B B A…), so getting the first pick is balanced out. The first pick is a coin flip, and the other team gets <b>blue side</b>.</li>
        <li>Every pick is a <b>player + role</b> and is final. When the timer runs out, the highest-rated legal pick is made automatically.</li>
        <li><b>Swap phase</b> (optional): captains can swap roles between their own players, for example if two of them agree to trade lanes. The cap still applies. Both click Ready to finish.</li>
      </ol>
      <h2>Win estimate</h2>
      <p>The balance bar uses an Elo-style curve where each star of difference is worth about 7 percentage points near an even matchup. It's only a rough guide.</p>
      <h2>Saving</h2>
      <p>Your player pool, setup, local drafts, room links and finished drafts are stored in this browser's <span class="kbd">localStorage</span>. Use export and import to move them to another browser or share them. Online rooms live on the server for 48 hours.</p>
      <h2>Tips for fair ratings</h2>
      <ul>
        <li>5★ = among the best in your group on that role. 3★ = solid. 1★ = can't or won't play it.</li>
        <li>Rate relative to your own group, not to the whole ladder.</li>
        <li>After a few games, re-check the ratings of players who keep winning or losing lopsided games.</li>
      </ul>
    </div>`;
  }

  /* ========================================================= */
  window.addEventListener('hashchange', route);
  checkServer().then(route);
})();
