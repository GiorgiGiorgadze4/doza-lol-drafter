/* Doza LoL Drafter - browser app (vanilla JS, hash router). */
(function () {
  "use strict";
  const E = window.DraftEngine;
  const AU = window.AuctionEngine;
  const { ROLES, ROLE_NAMES } = E;
  const $app = document.getElementById("app");

  /* =========================================================
   * Utilities
   * ======================================================= */
  const LS = {
    get(k, d) {
      try {
        const v = localStorage.getItem("doza." + k);
        return v == null ? d : JSON.parse(v);
      } catch (_) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("doza." + k, JSON.stringify(v));
      } catch (_) {
        toast("Could not save (localStorage full or blocked)", "err");
      }
    },
  };
  const esc = (s) =>
    String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const uid = () =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const qs = (sel, el) => (el || document).querySelector(sel);

  function toast(msg, kind) {
    const el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = msg;
    document.getElementById("toasts").appendChild(el);
    setTimeout(() => el.remove(), kind === "err" ? 4500 : 2500);
  }
  function stars(n, opts) {
    opts = opts || {};
    let s =
      '<span class="stars' +
      (opts.edit ? " edit" : "") +
      '"' +
      (opts.attrs || "") +
      ">";
    for (let i = 1; i <= 5; i++)
      s +=
        '<i class="' +
        (i <= n ? "on" : i - 0.5 <= n ? "half" : "") +
        '" data-v="' +
        i +
        '">★</i>';
    return s + "</span>";
  }
  // "/ 24★" for capped drafts, just "★" when there is no cap
  const capTxt = (s) => (s.cap != null ? " / " + s.cap + "★" : "★");
  // team total colored by how far it is over the star limit (yellow up to 3 over, red beyond)
  const totalHtml = (s, t) => {
    const v = E.teamStars(s, t);
    return `<b class="lim-${E.limitLevel(s, v)}" data-total="${t}">${v}</b>`;
  };
  const roleTag = (r) =>
    '<span class="role ' +
    r +
    '" title="' +
    ROLE_NAMES[r] +
    '">' +
    r +
    "</span>";
  const bestRole = (p) =>
    ROLES.reduce((b, r) => (p.ratings[r] > p.ratings[b] ? r : b), ROLES[0]);
  const bestRating = (p) => Math.max(...ROLES.map((r) => p.ratings[r]));
  const sumRating = (p) => ROLES.reduce((s, r) => s + p.ratings[r], 0);
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard", "ok");
    } catch (_) {
      prompt("Copy this:", text);
    }
  }
  function download(name, text) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function fmtDate(ms) {
    return new Date(ms).toLocaleString();
  }
  /* =========================================================
   * Data: player pool, setup, local drafts, history
   *
   * The roster lives in data/players.json, committed with the site.
   *  - dev mode (npm run dev): edits are written straight back to that file
   *  - static hosting: edits stay in this browser as an override on top of the published roster.
   *    If the published file changes (a new commit), the override is dropped so everyone sees the new data.
   * ======================================================= */
  let DEV = false;
  let PUBLISHED = []; // roster as served from data/players.json
  let POOL = []; // roster in use
  let saveTimer = null;

  const signature = (players) => JSON.stringify(players);
  async function loadPool() {
    try {
      DEV = (await fetch("__dev", { cache: "no-store" })).ok;
    } catch (_) {
      DEV = false;
    }
    try {
      const r = await fetch("data/players.json", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      PUBLISHED = (await r.json()).map(E.normalizePlayer);
    } catch (e) {
      PUBLISHED = [];
      toast("Could not load data/players.json (" + e.message + ")", "err");
    }
    const ov = LS.get("pool.override", null);
    if (!DEV && ov && ov.base === signature(PUBLISHED)) POOL = ov.players;
    else {
      if (ov && !DEV)
        toast(
          "The published roster was updated, so your local rating edits were replaced",
          "ok",
        );
      LS.set("pool.override", null);
      POOL = PUBLISHED.slice();
    }
    const el = document.getElementById("server-status");
    el.className = "server-status " + (DEV ? "on" : "off");
    el.textContent = DEV ? "Dev: edits save to repo" : "Static";
    el.title = DEV
      ? "Rating edits are written to public/data/players.json"
      : "Rating edits are kept in this browser only";
  }
  const getPool = () => JSON.parse(JSON.stringify(POOL));
  function setPool(p) {
    POOL = p;
    if (!DEV)
      return LS.set("pool.override", {
        base: signature(PUBLISHED),
        players: p,
      });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const r = await fetch("__dev/players", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(POOL),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
        PUBLISHED = POOL.map(E.normalizePlayer);
      } catch (e) {
        toast("Could not save players.json: " + e.message, "err");
      }
    }, 300);
  }
  const hasLocalEdits = () => !DEV && signature(POOL) !== signature(PUBLISHED);
  const rosterJson = (players) =>
    "[\n" +
    players
      .map((p) => "  " + JSON.stringify(E.normalizePlayer(p)))
      .join(",\n") +
    "\n]\n";

  function defaultSetup() {
    return {
      teamNames: { A: "", B: "" },
      captains: {
        A: { playerId: "", name: "" },
        B: { playerId: "", name: "" },
      },
      selected: [], // ids of the players in this draft (captains included), saved with the setup
      settings: Object.assign({}, E.DEFAULT_SETTINGS),
      auction: Object.assign({}, AU.DEFAULT_SETTINGS), // auction drafter: tokens per captain, bid timer
    };
  }
  function getSetup() {
    const s = Object.assign(defaultSetup(), LS.get("setup", {}));
    s.settings = Object.assign({}, E.DEFAULT_SETTINGS, s.settings);
    s.auction = Object.assign({}, AU.DEFAULT_SETTINGS, s.auction);
    return s;
  }
  const setSetup = (s) => LS.set("setup", s);

  const getLocals = () => LS.get("local", {});
  const setLocals = (l) => LS.set("local", l);
  const getHistory = () => LS.get("history", []);
  function saveToHistory(state, mode) {
    const h = getHistory();
    if (h.some((x) => x.id === state.id && x.finishedAt === state.finishedAt))
      return;
    h.unshift({ id: state.id, finishedAt: state.finishedAt, mode, state });
    LS.set("history", h.slice(0, 200));
    toast("Draft saved to history", "ok");
  }

  /* =========================================================
   * Router
   * ======================================================= */
  let cleanup = null;
  function route() {
    if (cleanup) {
      try {
        cleanup();
      } catch (_) {}
      cleanup = null;
    }
    $app.onclick = $app.oninput = $app.onchange = null;
    document.onkeydown = null;
    document.title = "Doza Drafter";
    const h = location.hash.slice(1) || "/";
    const path = h.split("?")[0];
    const parts = path.split("/").filter(Boolean);
    document
      .querySelectorAll("[data-nav]")
      .forEach((a) =>
        a.classList.toggle("active", a.dataset.nav === (parts[0] || "home")),
      );
    window.scrollTo(0, 0);
    switch (parts[0]) {
      case undefined:
        return viewHome();
      case "players":
        return viewPlayers();
      case "setup":
        return viewSetup(parts[1] === "auction" ? "auction" : "star");
      case "history":
        return parts[1] != null ? viewHistoryItem(+parts[1]) : viewHistory();
      case "rules":
        return viewRules();
      case "local":
        return viewLocal(parts[1]);
      default:
        location.hash = "#/";
    }
  }

  /* =========================================================
   * Home
   * ======================================================= */
  function viewHome() {
    const locals = Object.entries(getLocals()).sort(
      (a, b) => b[1].state.createdAt - a[1].state.createdAt,
    );
    $app.innerHTML = `
      <section class="hero">
        <h1>Captain Draft</h1>
        <p>Pick how the two captains build their teams from the 10 players in today's game.</p>
        <div class="mode-cards">
          <a class="mode-card" href="#/setup">
            <div class="mi">★</div>
            <h3>Star drafter</h3>
            <p>Captains take turns picking a player <b>and</b> a role, worth that player's star rating on it. A max star limit per team keeps it balanced.</p>
            <span class="btn gold">New star draft</span>
          </a>
          <a class="mode-card" href="#/setup/auction">
            <div class="mi"><i class="coin"></i></div>
            <h3>Auction drafter</h3>
            <p>Each captain gets the same number of tokens. A wheel picks a random player, captains bid on them one at a time, and the highest bid wins. Roles don't matter.</p>
            <span class="btn gold">New auction</span>
          </a>
        </div>
        <div class="row" style="justify-content:center;margin-top:14px"><a class="btn" href="#/players">Manage players</a></div>
      </section>
      <div class="panel">
        <h2>Your drafts</h2>
        <div class="list">
          ${
            locals
              .map(
                ([id, l]) => `
            <div class="list-item">
              <span class="badge gold">${l.state.phase === "done" ? "Done" : "In progress"}</span>
              <span class="badge">${l.state.kind === "auction" ? '<i class="coin"></i> Auction' : "★ Star"}</span>
              <div class="grow"><b>${esc(l.state.teamNames.A)}</b> vs <b>${esc(l.state.teamNames.B)}</b>
                <div class="small muted">${fmtDate(l.state.createdAt)} · ${l.state.phase}</div></div>
              <a class="btn small" href="#/local/${id}">Open</a>
              <button class="btn small danger" data-act="del-local" data-id="${id}">✕</button>
            </div>`,
              )
              .join("") ||
            '<p class="muted">No drafts yet. Start one from <a href="#/setup">New draft</a>.</p>'
          }
        </div>
      </div>
      <div class="panel">
        <h2>How it works</h2>
        <div class="grid3">
          <div><h3>1 · Rate players</h3><p class="muted">On <a href="#/players">Players</a>, rate everyone 1–5 stars on each role. Run it locally with <span class="kbd">npm run dev</span> and your ratings are saved into the repo, so the next commit publishes them.</p></div>
          <div><h3>2 · Captains</h3><p class="muted">On New draft, choose the two captains and the rules. Everyone on the roster can be drafted.</p></div>
          <div><h3>3 · Draft</h3><p class="muted">Captains take turns on one screen (share it on stream or Discord). They pick one at a time, alternating (A B A B…), by dragging players from the roster straight onto a role slot of their team. Team totals update live, and picked players can be moved between roles at any time.</p></div>
        </div>
      </div>`;

    $app.onclick = (e) => {
      const b = e.target.closest("[data-act]");
      if (b && b.dataset.act === "del-local" && confirm("Delete this draft?")) {
        const l = getLocals();
        delete l[b.dataset.id];
        setLocals(l);
        viewHome();
      }
    };
  }

  /* =========================================================
   * Players (pool editor)
   * ======================================================= */
  function viewPlayers() {
    let sort = { key: "name", dir: 1 };
    let search = "";
    $app.innerHTML = `
      <div class="panel">
        <div class="row" style="margin-bottom:12px">
          <h2 style="margin:0">Player pool</h2>
          <span class="badge" id="pcount"></span>
          <input id="search" placeholder="Search…" class="right" style="width:200px">
        </div>
        <p class="muted small">Click the stars to rate each role from 1 (can't play it) to 5 (main or very strong). Changes save automatically.</p>
        <div id="savenote"></div>
        <div class="table-wrap">
          <table class="tbl" id="ptable">
            <thead><tr>
              <th class="sortable" data-sort="name">Name</th>
              ${ROLES.map((r) => `<th class="sortable" data-sort="${r}">${roleTag(r)}</th>`).join("")}
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
          <button class="btn" data-act="export">Download players.json</button>
          <button class="btn" data-act="export-csv">Copy as CSV</button>
          <span class="grow"></span>
          ${LS.get("pool", null) ? '<button class="btn" data-act="legacy" title="Ratings saved by an older version of the app in this browser">Import old browser ratings</button>' : ""}
          <button class="btn danger" data-act="clear">Delete all</button>
        </div>
      </div>`;

    function drawNote() {
      qs("#savenote").innerHTML = DEV
        ? '<div class="alert ok small">Dev mode: edits are written to <span class="kbd">public/data/players.json</span>. Commit and push that file to publish the new ratings.</div>'
        : hasLocalEdits()
          ? `<div class="alert warn small row">
              <span class="grow">These edits are saved in this browser only. To publish them, run <span class="kbd">npm run dev</span> locally, or download players.json and replace <span class="kbd">public/data/players.json</span> in the repo.</span>
              <button class="btn small" data-act="revert">Discard my edits</button></div>`
          : '<div class="alert small">Showing the published roster from <span class="kbd">data/players.json</span>. Run <span class="kbd">npm run dev</span> locally to edit it in the repo.</div>';
    }

    function drawTable() {
      // drawNote();
      const pool = getPool();
      qs("#pcount").textContent = pool.length + " players";
      let rows = pool.filter((p) =>
        p.name.toLowerCase().includes(search.toLowerCase()),
      );
      const val = (p) =>
        sort.key === "name"
          ? p.name.toLowerCase()
          : sort.key === "best"
            ? bestRating(p)
            : sort.key === "sum"
              ? sumRating(p)
              : p.ratings[sort.key];
      rows.sort(
        (a, b) =>
          (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) *
          (sort.key === "name" ? sort.dir : -sort.dir),
      );
      qs("#ptable tbody").innerHTML =
        rows
          .map(
            (p) => `
        <tr data-pid="${p.id}">
          <td><input class="name" value="${esc(p.name)}" maxlength="32" data-act="rename"></td>
          ${ROLES.map((r) => `<td>${stars(p.ratings[r], { edit: true, attrs: ` data-role="${r}"` })}</td>`).join("")}
          <td>${roleTag(bestRole(p))}</td>
          <td class="muted">${sumRating(p)}</td>
          <td><button class="btn small danger" data-act="del" title="Delete">✕</button></td>
        </tr>`,
          )
          .join("") ||
        '<tr><td colspan="9" class="muted">No players.</td></tr>';
    }
    drawTable();

    function importText(text) {
      text = text.trim();
      if (!text) return toast("Nothing to import", "err");
      let incoming = [];
      try {
        if (text[0] === "[" || text[0] === "{") {
          const data = JSON.parse(text);
          incoming = (Array.isArray(data) ? data : data.players || []).map(
            (p) => E.normalizePlayer(Object.assign({ id: uid() }, p)),
          );
        } else {
          for (const line of text.split(/\r?\n/)) {
            const c = line.split(/[,;\t]/).map((x) => x.trim());
            if (c.length < 6 || !c[0] || isNaN(+c[1])) continue; // skips header lines
            incoming.push(
              E.normalizePlayer({
                id: uid(),
                name: c[0],
                ratings: Object.fromEntries(
                  ROLES.map((r, i) => [r, +c[i + 1]]),
                ),
              }),
            );
          }
        }
      } catch (e) {
        return toast("Could not parse: " + e.message, "err");
      }
      if (!incoming.length) return toast("No players found in input", "err");
      const pool = getPool();
      let added = 0,
        updated = 0;
      for (const p of incoming) {
        const ex = pool.find(
          (x) => x.name.toLowerCase() === p.name.toLowerCase(),
        );
        if (ex) {
          ex.ratings = p.ratings;
          updated++;
        } else {
          pool.push(p);
          added++;
        }
      }
      setPool(pool);
      drawTable();
      toast(`Imported: ${added} added, ${updated} updated`, "ok");
    }

    qs("#search").oninput = (e) => {
      search = e.target.value;
      drawTable();
    };
    qs("#add").onsubmit = (e) => {
      e.preventDefault();
      const name = e.target.name.value.trim();
      const pool = getPool();
      if (pool.some((p) => p.name.toLowerCase() === name.toLowerCase()))
        return toast("Name already exists", "err");
      pool.push({
        id: uid(),
        name,
        ratings: { TOP: 3, JNG: 3, MID: 3, ADC: 3, SUP: 3 },
      });
      setPool(pool);
      e.target.reset();
      drawTable();
    };
    qs("#file").onchange = (e) => {
      const f = e.target.files[0];
      if (!f) return;
      f.text().then(importText);
      e.target.value = "";
    };
    $app.onchange = (e) => {
      if (e.target.dataset.act !== "rename") return;
      const pid = e.target.closest("tr").dataset.pid;
      const name = e.target.value.trim();
      const pool = getPool();
      if (
        !name ||
        pool.some(
          (p) => p.id !== pid && p.name.toLowerCase() === name.toLowerCase(),
        )
      ) {
        toast("Name must be unique and not empty", "err");
        return drawTable();
      }
      pool.find((p) => p.id === pid).name = name;
      setPool(pool);
      // drawNote();
    };
    $app.onclick = (e) => {
      const th = e.target.closest("th[data-sort]");
      if (th) {
        sort = {
          key: th.dataset.sort,
          dir: sort.key === th.dataset.sort ? -sort.dir : 1,
        };
        return drawTable();
      }
      const star = e.target.closest(".stars.edit i");
      if (star) {
        const pid = star.closest("tr").dataset.pid,
          role = star.parentElement.dataset.role;
        // clicking the star that is already the top full star takes off half a star (5 -> 4.5)
        const pool = getPool(),
          pl = pool.find((p) => p.id === pid),
          v = +star.dataset.v;
        pl.ratings[role] = pl.ratings[role] === v && v > 1 ? v - 0.5 : v;
        setPool(pool);
        return drawTable();
      }
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      if (act === "del") {
        const pid = b.closest("tr").dataset.pid;
        const pool = getPool();
        const p = pool.find((x) => x.id === pid);
        if (confirm("Delete " + p.name + "?")) {
          setPool(pool.filter((x) => x.id !== pid));
          drawTable();
        }
      } else if (act === "import") importText(qs("#io").value);
      else if (act === "export") {
        const json = rosterJson(getPool());
        qs("#io").value = json;
        download("players.json", json);
      } else if (act === "export-csv") {
        const csv =
          "name,top,jng,mid,adc,sup\n" +
          getPool()
            .map((p) => [p.name, ...ROLES.map((r) => p.ratings[r])].join(","))
            .join("\n");
        qs("#io").value = csv;
        copy(csv);
      } else if (act === "legacy") {
        importText(JSON.stringify(LS.get("pool", [])));
      } else if (
        act === "revert" &&
        confirm("Discard your edits and go back to the published roster?")
      ) {
        POOL = PUBLISHED.slice();
        LS.set("pool.override", null);
        drawTable();
      } else if (act === "clear" && confirm("Delete ALL players?")) {
        setPool([]);
        drawTable();
      }
    };
  }

  /* =========================================================
   * Setup (choose 10 + captains + rules)
   * ======================================================= */
  const DRAFT_SIZE = 10;
  function viewSetup(mode) {
    const isAuc = mode === "auction";
    const setup = getSetup();
    const pool = getPool();
    let search = "";
    const st = setup.settings;
    const auc = setup.auction;

    const starRules = `
            <h2>Rules</h2>
            <div class="fields">
              <label class="field">Min role rating
                <select data-set="minRoleRating">${[1, 2, 3].map((v) => `<option value="${v}" ${st.minRoleRating == v ? "selected" : ""}>${v}★${v === 1 ? " (any role)" : ""}</option>`).join("")}</select>
                <span class="hint">Can't place a player on a role rated lower</span></label>
              <label class="field">Max stars per team
                <input type="number" min="0" max="25" step="0.5" data-set="starLimit" value="${st.starLimit || 0}">
                <span class="hint" id="limhint">0 = automatic. Totals turn yellow when up to 3★ over, red when more</span></label>
              <label class="field">Pick timer (s)
                <input type="number" min="0" max="600" data-set="pickTimer" value="${st.pickTimer}">
                <span class="hint">0 = no timer. When time runs out, the best legal pick is made</span></label>
            </div>
            <p class="small muted" style="margin:12px 0 0">After the last pick, the draft only counts once both captains lock in. Until then either can cancel and keep changing their team.</p>`;
    const auctionRules = `
            <h2>Auction rules</h2>
            <div class="fields">
              <label class="field">Tokens per captain
                <input type="number" min="${AU.TEAM_SIZE}" max="1000" data-auc="tokens" value="${auc.tokens}">
                <span class="hint">Both captains start with the same amount</span></label>
              <label class="field">Bid timer (s)
                <input type="number" min="0" max="300" data-auc="bidTimer" value="${auc.bidTimer}">
                <span class="hint">0 = no timer. When time runs out, the team that has to answer passes</span></label>
            </div>
            <ul class="small muted" style="margin:12px 0 0;padding-left:18px">
              <li>A wheel picks a random unsold player. Teams take turns nominating, and the nominating team opens at <b>1 token</b>.</li>
              <li>The other team raises or passes, back and forth, until someone passes. The highest bid wins the player.</li>
              <li>A team keeps 1 token for each other open slot, so it can always finish its team. A full team stops bidding and the other team gets the rest for 1 token each.</li>
            </ul>`;

    $app.innerHTML = `
      <div class="mode-tabs">
        <a href="#/setup" class="${isAuc ? "" : "on"}">★ Star drafter</a>
        <a href="#/setup/auction" class="${isAuc ? "on" : ""}"><i class="coin"></i> Auction drafter</a>
      </div>
      <div class="grid2" style="align-items:start">
        <div class="panel">
          <div class="row" style="margin-bottom:10px">
            <h2 style="margin:0">Roster</h2>
            <span class="badge" id="rcount"></span>
            <span class="grow"></span>
            <input id="search" placeholder="Search…" style="width:160px">
          </div>
          <p class="small muted">Click players to pick the ${DRAFT_SIZE} who play (captains count and are always in). ${isAuc ? "After you start, everyone except the captains goes on the auction wheel." : "After you start, captains take turns dragging them into their team."}</p>
          <div class="row" style="margin-bottom:8px"><button class="btn small" data-act="clear">Clear selection</button></div>
          <div class="pick-pool" id="roster"></div>
          <p class="small muted" style="margin-top:10px">Missing someone? Add them on <a href="#/players">Players</a>.</p>
        </div>
        <div>
          <div class="panel">
            <h2>Teams &amp; captains</h2>
            <label class="check" style="margin-bottom:12px"><input type="checkbox" data-set="captainsArePlayers" ${st.captainsArePlayers ? "checked" : ""}> Captains play too (${isAuc ? "they join their own team for free" : "they start on their main role"})</label>
            <div class="grid2" id="caps"></div>
          </div>
          <div class="panel">${isAuc ? auctionRules : starRules}</div>
          <div class="panel" id="preview"></div>
        </div>
      </div>`;

    const save = () => setSetup(setup);
    const capOf = (pid) =>
      E.TEAMS.find(
        (t) => st.captainsArePlayers && setup.captains[t].playerId === pid,
      );
    const capIds = () =>
      st.captainsArePlayers
        ? E.TEAMS.map((t) => setup.captains[t].playerId).filter(Boolean)
        : [];
    // the draft roster: captains first, then the picked players, dropping ids no longer in the pool
    function chosenIds() {
      const ids = new Set(capIds().concat(setup.selected || []));
      return pool.filter((p) => ids.has(p.id)).map((p) => p.id);
    }
    function syncSelected() {
      setup.selected = chosenIds();
      save();
    }

    function drawRoster() {
      const chosen = new Set(chosenIds());
      qs("#rcount").textContent =
        chosen.size + " / " + DRAFT_SIZE + " selected";
      const list = pool
        .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name));
      qs("#roster").innerHTML =
        list
          .map((p) => {
            const t = capOf(p.id);
            return `<div class="pp ${chosen.has(p.id) ? "sel" : ""}" data-pick="${p.id}" style="${chosen.has(p.id) || chosen.size < DRAFT_SIZE ? "" : "opacity:.45"}">
          <div class="grow">
            <div class="nm">${esc(p.name)}${t ? '<span class="cap">♛</span>' : ""}</div>
            <div class="mini">${ROLES.map((r) => `<span>${r} <b>${p.ratings[r]}</b></span>`).join("")}</div>
          </div>
          ${t ? `<span class="badge gold">Captain ${t}</span>` : (chosen.has(p.id) ? '<span class="badge gold">In</span> ' : "") + roleTag(bestRole(p))}
        </div>`;
          })
          .join("") ||
        '<p class="muted">Your roster is empty. <a href="#/players">Add players</a>.</p>';
    }

    function drawCaps() {
      for (const t of E.TEAMS)
        if (
          setup.captains[t].playerId &&
          !pool.some((p) => p.id === setup.captains[t].playerId)
        )
          setup.captains[t].playerId = "";
      const sorted = pool.slice().sort((a, b) => a.name.localeCompare(b.name));
      qs("#caps").innerHTML = E.TEAMS.map(
        (t) => `
        <div>
          <label class="field">Team ${t} name
            <input data-team="${t}" value="${esc(setup.teamNames[t])}" placeholder="Team ${t}" maxlength="32"></label>
          ${
            st.captainsArePlayers
              ? `
          <label class="field" style="margin-top:8px">Captain ${t}
            <select data-cap="${t}">
              <option value="">— choose a player —</option>
              ${sorted.map((p) => `<option value="${p.id}" ${setup.captains[t].playerId === p.id ? "selected" : ""} ${setup.captains[E.other(t)].playerId === p.id ? "disabled" : ""}>${esc(p.name)}</option>`).join("")}
            </select></label>`
              : `
          <label class="field" style="margin-top:8px">Captain ${t} name
            <input data-capname="${t}" value="${esc(setup.captains[t].name)}" placeholder="Captain ${t}" maxlength="32"></label>`
          }
        </div>`,
      ).join("");
    }

    function buildOpts() {
      return {
        players: pool.filter((p) => chosenIds().includes(p.id)),
        captains: {
          A: {
            playerId: st.captainsArePlayers ? setup.captains.A.playerId : null,
            name: st.captainsArePlayers ? "" : setup.captains.A.name,
          },
          B: {
            playerId: st.captainsArePlayers ? setup.captains.B.playerId : null,
            name: st.captainsArePlayers ? "" : setup.captains.B.name,
          },
        },
        teamNames: { A: setup.teamNames.A, B: setup.teamNames.B },
        settings: isAuc
          ? Object.assign({}, auc)
          : Object.assign({}, st, {
              noCap: true,
              pickOrder: "alternate",
            }), // one pick each, A B A B…
      };
    }
    const create = (opts) =>
      isAuc ? AU.createAuction(opts) : E.createDraft(opts);

    function drawPreview() {
      const el = qs("#preview");
      let err = null,
        s = null;
      const n = chosenIds().length;
      if (pool.length < DRAFT_SIZE)
        err =
          "The roster needs at least " +
          DRAFT_SIZE +
          " players (" +
          pool.length +
          " now).";
      else if (n !== DRAFT_SIZE)
        err = "Select exactly " + DRAFT_SIZE + " players (" + n + " selected).";
      else if (
        st.captainsArePlayers &&
        (!setup.captains.A.playerId || !setup.captains.B.playerId)
      )
        err = 'Choose both captains (or untick "Captains play too").';
      else {
        try {
          s = create(Object.assign(buildOpts(), { firstPick: "A" }));
        } catch (e) {
          err = e.message;
        }
      }
      el.innerHTML = `
        <h2>Ready?</h2>
        ${
          err
            ? `<div class="alert err">${esc(err)}</div>`
            : isAuc
              ? `
        <div class="stat-grid">
          <div class="stat"><div class="v">${n}</div><div class="k">Playing</div></div>
          <div class="stat"><div class="v">${s.queue.length}</div><div class="k">On the wheel</div></div>
          <div class="stat"><div class="v">${s.settings.tokens}</div><div class="k">Tokens each</div></div>
          <div class="stat"><div class="v">${pool.length - n}</div><div class="k">Sit out</div></div>
        </div>
        <div class="alert ok small" style="margin-top:12px">Each team buys ${AU.slotsLeft(s, "A")} players. The first nominator is a coin flip.</div>`
              : `
        <div class="stat-grid">
          <div class="stat"><div class="v">${n}</div><div class="k">Playing</div></div>
          <div class="stat"><div class="v">${s.order.length}</div><div class="k">Picks</div></div>
          <div class="stat"><div class="v">${pool.length - n}</div><div class="k">Sit out</div></div>
          <div class="stat"><div class="v">${s.starLimit != null ? s.starLimit + "★" : "—"}</div><div class="k">Max per team${st.starLimit ? "" : " (auto)"}</div></div>
        </div>
        <p class="small muted" style="margin-top:12px">Pick order (the first pick is a coin flip, and the team that picks second gets blue side):</p>
        <div class="order-strip">${s.order.map((t) => `<span class="${t}">${t}</span>`).join("")}</div>
        <div class="alert ok small" style="margin-top:12px">No star cap: team totals and the win estimate update live as players are placed.</div>`
        }
        <div class="row" style="margin-top:14px">
          <button class="btn gold" data-act="local" ${err ? "disabled" : ""}>${isAuc ? "Start auction" : "Start draft"}</button>
        </div>`;
    }

    drawCaps();
    syncSelected();
    drawRoster();
    drawPreview();

    qs("#search").oninput = (e) => {
      search = e.target.value;
      drawRoster();
    };
    $app.oninput = (e) => {
      const t = e.target;
      if (t.dataset.team) {
        setup.teamNames[t.dataset.team] = t.value;
        save();
      } else if (t.dataset.capname) {
        setup.captains[t.dataset.capname].name = t.value;
        save();
      } else if (t.dataset.set && t.type === "number") {
        st[t.dataset.set] = +t.value;
        save();
        drawPreview();
      } else if (t.dataset.auc) {
        auc[t.dataset.auc] = +t.value;
        save();
        drawPreview();
      }
    };
    $app.onchange = (e) => {
      const t = e.target;
      if (t.dataset.cap) {
        setup.captains[t.dataset.cap].playerId = t.value;
        syncSelected();
        drawCaps();
        drawRoster();
        drawPreview();
      } else if (t.dataset.set) {
        st[t.dataset.set] =
          t.type === "checkbox"
            ? t.checked
            : t.tagName === "SELECT"
              ? +t.value
              : t.type === "number"
                ? +t.value
                : t.value;
        save();
        if (t.dataset.set === "captainsArePlayers") {
          drawCaps();
          syncSelected();
          drawRoster();
        }
        drawPreview();
      }
    };
    $app.onclick = (e) => {
      const card = e.target.closest("[data-pick]");
      if (card) {
        const pid = card.dataset.pick,
          ids = chosenIds();
        if (capOf(pid)) return toast("Captains are always in the draft", "err");
        if (ids.includes(pid)) setup.selected = ids.filter((id) => id !== pid);
        else if (ids.length >= DRAFT_SIZE)
          return toast(
            "Already " + DRAFT_SIZE + " players selected. Remove someone first",
            "err",
          );
        else setup.selected = ids.concat(pid);
        save();
        drawRoster();
        drawPreview();
        return;
      }
      const b = e.target.closest("[data-act]");
      if (b && b.dataset.act === "clear") {
        setup.selected = [];
        syncSelected();
        drawRoster();
        drawPreview();
        return;
      }
      if (!b || b.dataset.act !== "local") return;
      let s;
      try {
        s = create(buildOpts());
      } catch (err) {
        return toast(err.message, "err");
      }
      const id = "L" + uid();
      s.id = id;
      const l = getLocals();
      l[id] = { state: s, history: [] };
      setLocals(l);
      location.hash = "#/local/" + id;
    };
  }

  /* =========================================================
   * Draft HUD (shared by live drafts and the history viewer)
   * ======================================================= */
  function createDraftView(ctx) {
    // ctx: { mode: 'local'|'view', act(action, team), undo(), now(), onTick(), onDone(state) }
    // ui.sel / ui.swapSel: chosen by tapping (tap a slot next to place it); ui.drag: what is being dragged right now
    const ui = {
      sel: null,
      swapSel: null,
      drag: null,
      lastSeq: null,
      canUndo: false,
    };
    let state = null;
    let ticker = null;

    const myTeams = () => (ctx.mode === "local" ? ["A", "B"] : []);
    const isAdmin = () => ctx.mode === "local";
    const act = (action, team) => ctx.act(action, team);

    function update(newState, extra) {
      const prevSeq = state ? state.seq : null;
      state = newState;
      if (extra) Object.assign(ui, extra);
      ui.lastSeq = prevSeq;
      draw();
      ui.lastSeq = state.seq; // only animate a fresh pick once
      if (state.phase === "done" && ctx.onDone) ctx.onDone(state);
    }

    function isTurn(t) {
      if (state.phase === "draft") return E.currentTeam(state) === t;
      if (state.phase === "captains") return !state.locked[t];
      if (state.phase === "swap" || state.phase === "lobby")
        return !state.ready[t];
      return false;
    }

    function phaseInfo() {
      const s = state;
      const N = s.order.length;
      switch (s.phase) {
        case "lobby":
          return { label: "Lobby", who: "Waiting for both captains" };
        case "captains":
          return {
            label: "Captain roles",
            who: "Captains pick their own roles",
          };
        case "draft": {
          const t = E.currentTeam(s);
          return {
            label: `Pick ${s.pickIndex + 1} of ${N}`,
            who: esc(s.teamNames[t]) + " is picking",
            team: t,
          };
        }
        case "swap":
          return {
            label: "Lock in",
            who:
              s.ready.A || s.ready.B
                ? "Waiting for the other captain to lock in"
                : "Both captains lock in to finish",
          };
        case "done":
          return { label: "Draft complete", who: "GLHF" };
      }
      return { label: s.phase, who: "" };
    }

    function banner(t) {
      const s = state,
        side = s.sides[t];
      const used = E.teamStars(s, t),
        pct = s.cap ? Math.min(100, (used / s.cap) * 100) : 0;
      const capName = s.captains[t].name;
      const status =
        s.phase === "lobby"
          ? s.ready[t]
            ? ' · <b style="color:var(--ok)">READY</b>'
            : ""
          : s.phase === "swap"
            ? s.ready[t]
              ? ' · <b style="color:var(--ok)">LOCKED IN</b>'
              : " · not locked in"
            : "";
      return `
        <div class="team-banner ${side} ${isTurn(t) && s.phase !== "done" ? "turn" : ""}">
          <div class="tn">${esc(s.teamNames[t])}</div>
          <div class="sub">Captain ${esc(capName)} · <span class="badge ${side}">${side} side</span>${s.firstPick === t ? " · first pick" : ""}${status}</div>
          <div class="budget">
            ${
              s.cap != null
                ? `<div class="bar"><div class="fill ${used >= s.cap ? "full" : ""}" style="width:${pct}%"></div></div>
            <div class="lbl"><span><b>${used}</b> / ${s.cap}★ used</span><span>${s.cap - used}★ left · ${E.openRoles(s, t).length} open</span></div>`
                : `<div class="lbl"><span>${totalHtml(s, t)}★ total${s.starLimit != null ? " / max " + s.starLimit + "★" : ""}</span><span>${E.openRoles(s, t).length} open</span></div>`
            }
          </div>
        </div>`;
    }

    /* ---------- placing: a player onto an empty slot, or a slot onto another slot (swap) ---------- */

    // What is being placed right now: a dragged card, or the player / slot selected by tapping.
    function activeSource() {
      if (ui.drag) return ui.drag;
      if (ui.sel) return { kind: "player", pid: ui.sel };
      if (ui.swapSel)
        return { kind: "slot", team: ui.swapSel.team, role: ui.swapSel.role };
      return null;
    }

    // null = not a target for this source; otherwise { ok, reason?, delta } where delta is the team's star change.
    function dropCheck(src, t, r) {
      const s = state;
      if (!myTeams().includes(t)) return null;
      if (src.kind === "slot") {
        if (
          (s.phase !== "swap" && s.phase !== "draft") ||
          t !== src.team ||
          r === src.role
        )
          return null;
        return E.checkSwap(s, t, src.role, r);
      }
      // roster player onto a filled slot: bench swap (any time, no pick used)
      if (s.teams[t].slots[r]) return E.checkBench(s, t, src.pid, r);
      const p = E.playerById(s, src.pid);
      let c;
      if (s.phase === "captains") {
        if (E.captainTeamOf(s, src.pid) !== t) return null;
        c = E.checkCaptainLock(s, t, r);
      } else if (s.phase === "draft") {
        if (E.currentTeam(s) !== t) return null;
        c = E.checkPick(s, t, src.pid, r);
      } else return null;
      return Object.assign({ delta: p.ratings[r] }, c);
    }

    function place(src, t, r) {
      const c = dropCheck(src, t, r);
      if (!c) return draw();
      if (!c.ok) {
        toast(c.reason, "err");
        return draw();
      }
      ui.sel = null;
      ui.swapSel = null;
      ui.drag = null;
      if (src.kind === "slot")
        return act({ type: "swap", r1: src.role, r2: r }, t);
      if (state.teams[t].slots[r])
        return act({ type: "bench", playerId: src.pid, role: r }, t);
      if (state.phase === "captains")
        return act({ type: "lockCaptain", role: r }, t);
      act({ type: "pick", playerId: src.pid, role: r }, t);
    }

    // A placed player dropped back on the roster list: the slot opens and the team gets that pick back.
    function release(src) {
      ui.sel = null;
      ui.swapSel = null;
      ui.drag = null;
      const c = E.checkRelease(state, src.team, src.role);
      if (!c.ok) {
        toast(c.reason, "err");
        return draw();
      }
      act({ type: "release", role: src.role }, src.team);
    }

    /* ---------- the 5v5 board ---------- */

    function slotHtml(t, r, src) {
      const s = state;
      const pid = s.teams[t].slots[r];
      const p = pid && E.playerById(s, pid);
      const c = src ? dropCheck(src, t, r) : null;
      const last = s.log[s.log.length - 1];
      const fresh =
        ui.lastSeq != null &&
        s.seq !== ui.lastSeq &&
        last &&
        last.team === t &&
        last.role === r &&
        (last.kind === "pick" || last.kind === "captain");
      const canSwap = !!p && canMove(t);
      let cls = "slot " + s.sides[t] + (p ? " filled" : " empty");
      if (fresh) cls += " new";
      if (canSwap) cls += " swappable";
      if (src && src.kind === "slot" && src.team === t && src.role === r)
        cls += " swap-sel";
      if (c) cls += c.ok ? " drop-ok" : " drop-bad";
      else if (!p && s.phase === "draft" && E.currentTeam(s) === t)
        cls += " turn";
      const attrs = `data-team="${t}" data-role="${r}"${c && c.ok ? ` data-delta="${c.delta}"` : ""}${canSwap ? ' data-drag="slot"' : ""}`;
      const total = E.teamStars(s, t) + (c && c.ok ? c.delta : 0);
      const hint = !c
        ? ""
        : c.ok
          ? `<div class="hint ok">${src.kind === "slot" ? (p ? "swap · " : "move · ") : p ? "swap in · " : ""}${c.delta >= 0 ? "+" : ""}${c.delta}★ → ${total}${capTxt(s)}</div>`
          : `<div class="hint bad">${esc(c.reason)}</div>`;
      if (!p) {
        let txt = "Empty";
        if (c && c.ok) txt = "Drop here";
        else if (
          s.phase === "captains" &&
          s.captains[t].playerId &&
          !s.locked[t]
        )
          txt =
            "Captain " +
            E.playerById(s, s.captains[t].playerId).name +
            " picks first";
        else if (
          s.phase === "draft" &&
          E.currentTeam(s) === t &&
          myTeams().includes(t)
        )
          txt = "Drop a player here";
        return `<div class="${cls}" ${attrs}><div class="who"><span class="ph">${esc(txt)}</span>${hint}</div></div>`;
      }
      const isCap = s.captains[t].playerId === pid;
      return `<div class="${cls}" ${attrs}>
          <div class="who"><div class="pn">${esc(p.name)}${isCap ? '<span class="cap">♛</span>' : ""}</div>${stars(p.ratings[r])}${hint}</div>
          <div class="sv">${p.ratings[r]}</div>
        </div>`;
    }

    function boardHtml() {
      const s = state;
      const L = s.sides.A === "blue" ? "A" : "B",
        R = E.other(L);
      const src = activeSource();
      const head = (
        t,
      ) => `<div class="bh ${s.sides[t]} ${isTurn(t) && s.phase !== "done" ? "turn" : ""}">
          <div class="tn">${esc(s.teamNames[t])}</div>
          <div class="tot">${totalHtml(s, t)}${capTxt(s)}</div>
        </div>`;
      return `<div class="board${src ? " placing" : ""}">
          ${head(L)}<div class="bh mid">${s.starLimit != null ? `<div class="lim" title="Max stars per team">MAX <b>${s.starLimit}★</b></div>` : ""}VS</div>${head(R)}
          ${ROLES.map((r) => `${slotHtml(L, r, src)}<div class="brole">${roleTag(r)}</div>${slotHtml(R, r, src)}`).join("")}
        </div>`;
    }

    // Placed players can be dragged to another role of their own team during the draft and the swap phase.
    const canMove = (t) =>
      myTeams().includes(t) &&
      (state.phase === "draft" || (state.phase === "swap" && !state.ready[t]));

    // All 10 players in one list, same cards as the setup page. Unpicked players are dragged onto the board on their
    // team's turn; picked ones stay listed (with team + role) and can be dragged to another role of their team any time.
    function playerListHtml() {
      const s = state;
      const src = activeSource();
      const turn = E.currentTeam(s);
      const legalIds =
        turn && myTeams().includes(turn)
          ? new Set(E.legalPicks(s, turn).map((l) => l.playerId))
          : null;
      const placed = {};
      for (const t of E.TEAMS)
        for (const r of ROLES)
          if (s.teams[t].slots[r]) placed[s.teams[t].slots[r]] = { t, r };
      const list = s.players
        .slice()
        .sort(
          (a, b) =>
            !!placed[a.id] - !!placed[b.id] || a.name.localeCompare(b.name),
        );
      const rel =
        src && src.kind === "slot" && E.checkRelease(s, src.team, src.role);
      const zone =
        rel && rel.ok
          ? ` release-zone drop-ok" data-release="1" data-team="${src.team}" data-delta="${rel.delta}`
          : "";
      return `<div class="pick-pool draft-list${zone}">${list
        .map((p) => {
          const at = placed[p.id];
          const capT = E.captainTeamOf(s, p.id);
          let cls = "pp",
            drag = "";
          if (at) {
            cls += " placed " + s.sides[at.t];
            if (canMove(at.t))
              drag = ` data-drag="slot" data-team="${at.t}" data-role="${at.r}"`;
            if (
              src &&
              src.kind === "slot" &&
              src.team === at.t &&
              src.role === at.r
            )
              cls += " sel";
          } else {
            const can =
              s.phase === "captains"
                ? !!capT && myTeams().includes(capT)
                : (s.phase === "draft" || s.phase === "swap") &&
                  !capT &&
                  myTeams().length > 0;
            if (can) drag = ' data-drag="player"';
            if (s.phase === "draft" && legalIds && !legalIds.has(p.id))
              cls += " nolegal";
            if (src && src.kind === "player" && src.pid === p.id) cls += " sel";
          }
          if (!drag) cls += " idle";
          const tag = at
            ? `<span class="where"><span class="badge ${s.sides[at.t]}">${esc(s.teamNames[at.t])}</span>${roleTag(at.r)}</span>`
            : roleTag(bestRole(p));
          return `<div class="${cls}" data-pid="${p.id}"${drag}>
            <div class="grow">
              <div class="nm">${esc(p.name)}${capT ? '<span class="cap">♛</span>' : ""}</div>
              <div class="mini">${ROLES.map((r) => `<span>${r} <b>${p.ratings[r]}</b></span>`).join("")}</div>
            </div>
            ${tag}
          </div>`;
        })
        .join("")}</div>`;
    }

    function centerDraft() {
      const s = state;
      const turn = E.currentTeam(s);
      const mine = myTeams().includes(turn);
      const tip = mine
        ? `<b>${esc(s.teamNames[turn])}</b> is picking: drag a player onto an empty slot on their side (or tap the player, then the slot). Green slots are legal and show the new team total.
           Any time, either team can drag their players to another role, drop a roster player on one of their players to swap them in, or drag a player back here to the roster (that pick is given back). None of this uses a pick.`
        : `Waiting for <b>${esc(s.teamNames[turn])}</b> to pick…`;
      const relSel =
        ui.swapSel && E.checkRelease(s, ui.swapSel.team, ui.swapSel.role).ok;
      return `
        <div class="center-head">
          <h2 style="margin:0">Players</h2><span class="badge">${E.pool(s).length} left</span>
          ${relSel ? `<button class="btn small right" data-act="release">↩ Send ${esc(E.playerById(s, s.teams[ui.swapSel.team].slots[ui.swapSel.role]).name)} back to the roster</button>` : ""}
        </div>
        <p class="tip">${tip}</p>
        ${playerListHtml()}`;
    }

    function centerCaptains() {
      return `<div class="center-head"><h2 style="margin:0">Players</h2></div>
        <p class="tip">Captains go first: drag each captain (♛) onto a role on their own team (or tap the captain, then the slot). It counts toward the team's cap.</p>
        ${playerListHtml()}`;
    }

    function centerLobby() {
      const s = state;
      return `<h2>Lobby</h2>
        <p class="muted">The first pick was decided by coin flip: <b>${esc(s.teamNames[s.firstPick])}</b>. Start when both captains are at the screen.</p>
        <div class="grid2">${E.TEAMS.map(
          (t) => `
          <div class="lobby-cap ${s.ready[t] ? "ready" : ""}">
            <div class="tn">${esc(s.teamNames[t])}</div>
            <div class="small muted">Captain ${esc(s.captains[t].name)}</div>
          </div>`,
        ).join("")}</div>
        ${isAdmin() ? `<div class="row" style="margin-top:14px;justify-content:center"><button class="btn gold big" data-act="force">Start draft</button></div>` : ""}
        <h3 style="margin-top:20px">Roster</h3>
        ${playerListHtml()}`;
    }

    function centerSwap() {
      const s = state;
      const mine = myTeams();
      return `<h2>Lock in your team</h2>
        <p class="tip">All picks are made, but the draft isn't final yet. Until you lock in you can still move players between roles or drop a roster player on one of yours to swap them in.
          Locking in freezes your team; you can cancel it as long as the other captain hasn't locked in too. <b>Once both captains are locked in, the draft is final.</b></p>
        <div class="grid2">${[
          s.sides.A === "blue" ? "A" : "B",
          s.sides.A === "blue" ? "B" : "A",
        ]
          .map(
            (t) => `
          <div class="lobby-cap ${s.ready[t] ? "ready" : ""}">
            <div class="tn">${esc(s.teamNames[t])}</div>
            <div class="small muted">${totalHtml(s, t)}${capTxt(s)}${s.starLimit != null ? " · max " + s.starLimit + "★" : ""}</div>
            <div style="margin-top:12px">${
              mine.includes(t)
                ? s.ready[t]
                  ? `<span class="badge ok">Locked in ✓</span> <button class="btn small" data-act="ready" data-team="${t}" data-v="false">Cancel lock-in</button>`
                  : `<button class="btn gold" data-act="ready" data-team="${t}" data-v="true">Lock in</button>`
                : `<span class="badge ${s.ready[t] ? "ok" : ""}">${s.ready[t] ? "Locked in" : "Not locked in"}</span>`
            }</div>
          </div>`,
          )
          .join("")}</div>
        <div style="margin-top:14px">${playerListHtml()}</div>`;
    }

    function centerDone() {
      const s = state;
      const a = E.teamStars(s, "A"),
        b = E.teamStars(s, "B");
      return `<div style="text-align:center">
          <h1>Draft complete</h1>
          <div class="final">${E.TEAMS.map(
            (
              t,
            ) => `<div class="lobby-cap"><div class="tn">${esc(s.teamNames[t])}</div>
            <div class="vs">${totalHtml(s, t)}★</div><span class="badge ${s.sides[t]}">${s.sides[t]} side</span>
            <div class="small muted" style="margin-top:6px">Estimated win: ${Math.round(E.winChance(E.teamStars(s, t), E.teamStars(s, E.other(t))) * 100)}%</div></div>`,
          ).join("")}</div>
          <p class="muted" style="margin-top:14px">Difference: ${Math.abs(a - b)}★${s.cap != null ? " · cap was " + s.cap + "★" : s.starLimit != null ? " · max was " + s.starLimit + "★" : ""}</p>
          <div class="row" style="justify-content:center">
            <button class="btn gold" data-act="copy">Copy lineup for Discord</button>
            <button class="btn" data-act="export">Download JSON</button>
            <button class="btn primary" data-act="again">New draft</button>
          </div>
        </div>`;
    }

    function bottom() {
      const s = state;
      const L = s.sides.A === "blue" ? "A" : "B",
        R = E.other(L);
      const sl = E.teamStars(s, L),
        sr = E.teamStars(s, R);
      const p = E.winChance(sl, sr);
      const nm = (id) => esc((E.playerById(s, id) || {}).name || "?");
      const log =
        s.log
          .slice()
          .reverse()
          .map((e) => {
            if (e.kind === "swap")
              return `<div class="${e.team}">${esc(s.teamNames[e.team])} swapped ${roleTag(e.r1)} ↔ ${roleTag(e.r2)}</div>`;
            if (e.kind === "lock" || e.kind === "unlock")
              return `<div class="${e.team}">${esc(s.teamNames[e.team])} ${e.kind === "lock" ? "locked in ✓" : "cancelled their lock-in"}</div>`;
            if (e.kind === "bench")
              return `<div class="${e.team}">${esc(s.teamNames[e.team])} swapped in ${nm(e.playerId)} for ${nm(e.out)} ${roleTag(e.role)}</div>`;
            if (e.kind === "release")
              return `<div class="${e.team}">${esc(s.teamNames[e.team])} sent ${nm(e.playerId)} back to the roster ${roleTag(e.role)}</div>`;
            if (e.kind === "move")
              return `<div class="${e.team}">${esc(s.teamNames[e.team])} moved ${nm(e.playerId)} ${roleTag(e.r1)} → ${roleTag(e.r2)}</div>`;
            const p = E.playerById(s, e.playerId);
            return `<div class="${e.team}">${e.kind === "captain" ? "♛" : "#" + e.n} <b>${esc(s.teamNames[e.team])}</b> → ${nm(e.playerId)} ${roleTag(e.role)} ${stars(p.ratings[e.role])}${e.auto ? ' <span class="badge">auto</span>' : ""}</div>`;
          })
          .join("") || '<span class="muted small">No picks yet.</span>';

      const admin = isAdmin()
        ? `<div class="panel"><h2>Controls</h2>
          <div class="row">
            ${s.deadline || s.paused ? `<button class="btn" data-act="${s.paused ? "resume" : "pause"}">${s.paused ? "▶ Resume" : "⏸ Pause timer"}</button>` : ""}
            <button class="btn" data-act="undo" ${ui.canUndo ? "" : "disabled"}>↶ Undo</button>
          </div></div>`
        : "";

      return `<div class="grid3" style="margin-top:16px">
        <div class="panel">
          <h2>Balance</h2>
          <div class="meter"><div class="a" style="width:${(p * 100).toFixed(1)}%"></div><div class="b"></div></div>
          <div class="meter-lbl"><span><b>${esc(s.teamNames[L])}</b> ${sl}★ · ${Math.round(p * 100)}%</span><span>${Math.round((1 - p) * 100)}% · ${sr}★ <b>${esc(s.teamNames[R])}</b></span></div>
          <p class="small muted" style="margin-top:12px">Pick order</p>
          <div class="order-strip">${s.order.map((t, i) => `<span class="${t} ${i < s.pickIndex || s.phase === "swap" || s.phase === "done" ? "done" : ""} ${s.phase === "draft" && i === s.pickIndex ? "now" : ""}">${t}</span>`).join("")}</div>
          <p class="small muted" style="margin-top:12px">${s.cap != null ? "Cap " + s.cap + "★" : "No cap"} · min role ${s.settings.minRoleRating}★ · ${s.settings.pickTimer ? s.settings.pickTimer + "s per pick" : "no timer"}</p>
        </div>
        <div class="panel"><h2>Pick log</h2><div class="log">${log}</div></div>
        ${admin || "<div></div>"}
      </div>`;
    }

    function draw() {
      const s = state;
      if (ui.sel && !E.unplaced(s).some((p) => p.id === ui.sel)) ui.sel = null;
      if (
        ui.swapSel &&
        ((s.phase !== "swap" && s.phase !== "draft") ||
          !s.teams[ui.swapSel.team].slots[ui.swapSel.role])
      )
        ui.swapSel = null;
      const L = s.sides.A === "blue" ? "A" : "B",
        R = E.other(L);
      const pi = phaseInfo();
      let center = "";
      if (s.phase === "lobby") center = centerLobby();
      else if (s.phase === "captains") center = centerCaptains();
      else if (s.phase === "draft") center = centerDraft();
      else if (s.phase === "swap") center = centerSwap();
      else center = centerDone();

      $app.innerHTML = `
        <div class="hud">
          <div class="hud-top">
            ${banner(L)}
            <div class="clock">
              <div class="phase">${pi.label}</div>
              <div class="time" id="clock-time">${s.deadline || s.paused ? "" : "∞"}</div>
              <div class="who">${pi.who}</div>
              <div class="tbar"><div id="clock-bar" style="width:${s.deadline ? 100 : 0}%"></div></div>
            </div>
            ${banner(R)}
          </div>
          <div class="draft-grid">
            <section class="panel hud-center">${center}</section>
            <section class="panel board-panel">${boardHtml()}</section>
          </div>
        </div>
        ${bottom()}`;
      tick();
      document.title = s.teamNames.A + " vs " + s.teamNames.B;
    }

    function tick() {
      const el = document.getElementById("clock-time"),
        bar = document.getElementById("clock-bar");
      if (!el || !state) return;
      let rem;
      if (state.paused) rem = state.pausedRemaining;
      else if (state.deadline) rem = Math.max(0, state.deadline - ctx.now());
      else return;
      const secs = Math.ceil(rem / 1000);
      el.textContent = state.paused ? "⏸ " + secs : secs;
      el.classList.toggle("low", !state.paused && secs <= 10);
      const total = state.settings.pickTimer * 1000;
      if (bar && total)
        bar.style.width = Math.min(100, (rem / total) * 100) + "%";
      if (ctx.onTick && !state.paused && rem <= 0) ctx.onTick();
    }
    ticker = setInterval(tick, 200);

    /* ---------- drag & drop (pointer events, so it works with mouse and touch) ---------- */
    let dg = null; // the gesture in progress
    let suppressClick = false;
    const srcOf = (el) =>
      el.dataset.drag === "slot"
        ? { kind: "slot", team: el.dataset.team, role: el.dataset.role }
        : { kind: "player", pid: el.dataset.pid };
    const blockScroll = (e) => {
      if (dg && dg.active) e.preventDefault();
    };

    function onDown(e) {
      if (!state || e.button > 0 || dg) return;
      const el = e.target.closest("[data-drag]");
      if (!el || !$app.contains(el)) return;
      const box = el.getBoundingClientRect();
      dg = {
        src: srcOf(el),
        el,
        id: e.pointerId,
        touch: e.pointerType !== "mouse",
        active: false,
        over: null,
        sx: e.clientX,
        sy: e.clientY,
        x: e.clientX,
        y: e.clientY,
        dx: e.clientX - box.left,
        dy: e.clientY - box.top,
        w: box.width,
      };
      // touchmove still fires on the original element after a redraw detaches it, so block scrolling there too
      el.addEventListener("touchmove", blockScroll, { passive: false });
      if (dg.touch)
        dg.timer = setTimeout(startDrag, 200); // long-press on touch, so a swipe still scrolls the page
      else e.preventDefault(); // no text selection while dragging with a mouse
    }

    function startDrag() {
      if (!dg || dg.active) return;
      dg.active = true;
      dg.ghost = dg.el.cloneNode(true);
      dg.ghost.classList.add("drag-ghost");
      dg.ghost.style.width = dg.w + "px";
      document.body.appendChild(dg.ghost);
      document.body.classList.add("dragging");
      ui.drag = dg.src;
      ui.sel = null;
      ui.swapSel = null;
      draw();
      moveGhost();
      requestAnimationFrame(autoScroll);
    }

    function moveGhost() {
      dg.ghost.style.transform = `translate(${dg.x - dg.dx}px, ${dg.y - dg.dy}px) rotate(2deg)`;
      const hit = document.elementFromPoint(dg.x, dg.y);
      const slot =
        hit && hit.closest(".slot.drop-ok, .slot.drop-bad, .release-zone");
      if (slot !== dg.over) {
        hover(dg.over, false);
        dg.over = slot;
        hover(slot, true);
      }
    }

    // Preview the team total in the board header while hovering a legal slot.
    function hover(slot, on) {
      if (!slot) return;
      slot.classList.toggle("over", on);
      const tot = $app.querySelector(`[data-total="${slot.dataset.team}"]`);
      if (!tot || slot.dataset.delta == null) return;
      const used = E.teamStars(state, slot.dataset.team),
        v = on ? used + +slot.dataset.delta : used;
      tot.textContent = v;
      tot.className = "lim-" + E.limitLevel(state, v);
      tot.classList.toggle("preview", on);
    }

    // Scroll the page while the card is held near the top or bottom edge.
    function autoScroll() {
      if (!dg || !dg.active) return;
      const edge = 80,
        h = window.innerHeight;
      const v =
        dg.y < edge
          ? -(edge - dg.y) / 3
          : dg.y > h - edge
            ? (dg.y - (h - edge)) / 3
            : 0;
      if (v) {
        window.scrollBy(0, v);
        moveGhost();
      }
      requestAnimationFrame(autoScroll);
    }

    function onMove(e) {
      if (!dg || e.pointerId !== dg.id) return;
      dg.x = e.clientX;
      dg.y = e.clientY;
      if (dg.active) return moveGhost();
      if (Math.hypot(dg.x - dg.sx, dg.y - dg.sy) < 6) return;
      if (dg.touch)
        endDrag(); // finger moved before the long-press: it's a scroll
      else startDrag();
    }

    function endDrag() {
      const d = dg;
      if (!d) return null;
      dg = null;
      clearTimeout(d.timer);
      d.el.removeEventListener("touchmove", blockScroll);
      if (d.ghost) d.ghost.remove();
      document.body.classList.remove("dragging");
      ui.drag = null;
      return d;
    }

    function onUp(e) {
      if (!dg || e.pointerId !== dg.id) return;
      const d = endDrag();
      if (!d.active) return;
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      });
      if (d.over && d.over.dataset.release) release(d.src);
      else if (d.over) place(d.src, d.over.dataset.team, d.over.dataset.role);
      else draw();
    }

    function onCancel(e) {
      if (!dg || e.pointerId !== dg.id) return;
      if (endDrag().active) draw();
    }

    const onContext = (e) => {
      if (e.target.closest && e.target.closest("[data-drag]"))
        e.preventDefault();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("touchmove", blockScroll, { passive: false });
    document.addEventListener("contextmenu", onContext);

    /* ---------- clicks & taps ---------- */
    $app.onclick = (e) => {
      if (!state || suppressClick) return;
      const card = e.target.closest('[data-drag="player"]');
      if (card) {
        ui.sel = ui.sel === card.dataset.pid ? null : card.dataset.pid;
        ui.swapSel = null;
        return draw();
      }
      const slot = e.target.closest('.slot, .pp[data-drag="slot"]');
      if (slot) {
        const t = slot.dataset.team,
          r = slot.dataset.role;
        const src = activeSource();
        if (src && dropCheck(src, t, r)) return place(src, t, r);
        if (slot.dataset.drag === "slot") {
          ui.swapSel =
            ui.swapSel && ui.swapSel.team === t && ui.swapSel.role === r
              ? null
              : { team: t, role: r };
          return draw();
        }
        return;
      }
      const b = e.target.closest("[data-act]");
      if (!b) return;
      switch (b.dataset.act) {
        case "release":
          return (
            ui.swapSel &&
            release({
              kind: "slot",
              team: ui.swapSel.team,
              role: ui.swapSel.role,
            })
          );
        case "ready":
          return act(
            { type: "ready", value: b.dataset.v === "true" },
            b.dataset.team,
          );
        case "force":
          return act({ type: "forceStart" }, "admin");
        case "pause":
          return act({ type: "pause" }, "admin");
        case "resume":
          return act({ type: "resume" }, "admin");
        case "undo":
          return ctx.undo();
        case "copy":
          return copy(E.summary(state));
        case "export":
          return download(
            "draft-" + state.id + ".json",
            JSON.stringify(state, null, 2),
          );
        case "again":
          location.hash = "#/setup";
      }
    };
    document.onkeydown = (e) => {
      if (e.key !== "Escape" || !state) return;
      endDrag();
      ui.sel = null;
      ui.swapSel = null;
      draw();
    };

    return {
      update,
      setMeta(extra) {
        Object.assign(ui, extra);
        if (state) draw();
      },
      destroy() {
        clearInterval(ticker);
        endDrag();
        document.onkeydown = null;
        document.removeEventListener("pointerdown", onDown);
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        document.removeEventListener("touchmove", blockScroll);
        document.removeEventListener("contextmenu", onContext);
      },
      get state() {
        return state;
      },
    };
  }

  /* =========================================================
   * Auction drafter (hot-seat: both captains bid on one screen)
   * ======================================================= */
  const SPIN_MS = 4200;
  // [rim, hub] shade pairs; each slice is a radial gradient from the darker hub colour out to the rim colour
  const WHEEL_COLORS = [
    ["#2f7fc0", "#123553"],
    ["#b3364f", "#4a1422"],
    ["#2f9a6c", "#123d2c"],
    ["#c9952f", "#4d3510"],
    ["#7a52c9", "#2a1a4d"],
    ["#2c98a8", "#103a42"],
  ];
  const coin = (n) => `${n}<i class="coin"></i>`;

  // SVG wheel: one slice per name, slice `i` centred on angle (i + .5) * 360 / n, clockwise from the top.
  // `win` = index of the slice to highlight once the wheel has stopped (-1 for none).
  function wheelSvg(names, win) {
    const n = names.length,
      C = 150,
      R = 138,
      seg = 360 / n;
    const pt = (deg, r) => {
      const a = ((deg - 90) * Math.PI) / 180;
      return [C + r * Math.cos(a), C + r * Math.sin(a)];
    };
    // when the last slice would get the same colour as the first one next to it, use another
    const colorIdx = (i) =>
      n > 1 && i === n - 1 && i % WHEEL_COLORS.length === 0 ? 2 : i % WHEEL_COLORS.length;
    const defs = WHEEL_COLORS.map(
      ([rim, hub], k) =>
        `<radialGradient id="wg${k}" gradientUnits="userSpaceOnUse" cx="${C}" cy="${C}" r="${R}"><stop offset="0.15" stop-color="${hub}"/><stop offset="1" stop-color="${rim}"/></radialGradient>`,
    ).join("");
    const slices = names
      .map((name, i) => {
        const a0 = i * seg,
          a1 = (i + 1) * seg,
          mid = a0 + seg / 2;
        const [x0, y0] = pt(a0, R),
          [x1, y1] = pt(a1, R),
          [tx, ty] = pt(mid, R - 14);
        const fill = `url(#wg${colorIdx(i)})`;
        const shape =
          n === 1
            ? `<circle cx="${C}" cy="${C}" r="${R}" fill="${fill}"/>`
            : `<path d="M${C},${C} L${x0},${y0} A${R},${R} 0 ${seg > 180 ? 1 : 0} 1 ${x1},${y1} Z" fill="${fill}"/>`;
        const label = esc(name.length > 10 ? name.slice(0, 9) + "…" : name);
        return `<g class="slice${i === win ? " win" : ""}">${shape}<text x="${tx}" y="${ty}" transform="rotate(${mid - 90} ${tx} ${ty})" text-anchor="end" dominant-baseline="middle">${label}</text></g>`;
      })
      .join("");
    const dividers =
      n > 1
        ? names
            .map((_, i) => {
              const [x, y] = pt(i * seg, R);
              return `<line x1="${C}" y1="${C}" x2="${x}" y2="${y}"/>`;
            })
            .join("")
        : "";
    return `<svg viewBox="0 0 300 300" class="wheel-svg"><defs>${defs}</defs>${slices}<g class="dividers">${dividers}</g></svg>`;
  }

  // The fixed parts around the turning wheel: gold rim with chasing lights, hub and pointer.
  function wheelFrameSvg() {
    const C = 150,
      bulbs = 24;
    const dots = Array.from({ length: bulbs }, (_, i) => {
      const a = (((i * 360) / bulbs - 90) * Math.PI) / 180;
      return `<circle class="bulb" cx="${C + 144 * Math.cos(a)}" cy="${C + 144 * Math.sin(a)}" r="3.4" style="animation-delay:${(i % 4) * -0.15}s"/>`;
    }).join("");
    return `<svg viewBox="0 0 300 300" class="wheel-frame">
        <defs>
          <linearGradient id="wrim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6e2a8"/><stop offset=".5" stop-color="#a87b2c"/><stop offset="1" stop-color="#f0d27a"/></linearGradient>
          <radialGradient id="whub" cx=".38" cy=".32" r=".8"><stop offset="0" stop-color="#fff4c9"/><stop offset=".45" stop-color="#e2b24a"/><stop offset="1" stop-color="#7a5414"/></radialGradient>
        </defs>
        <circle cx="${C}" cy="${C}" r="144" fill="none" stroke="#0a1428" stroke-width="15"/>
        <circle cx="${C}" cy="${C}" r="144" fill="none" stroke="url(#wrim)" stroke-width="11"/>
        <circle cx="${C}" cy="${C}" r="138.5" fill="none" stroke="#00000088" stroke-width="1.5"/>
        ${dots}
        <circle cx="${C}" cy="${C}" r="24" fill="#0a1428"/>
        <circle cx="${C}" cy="${C}" r="21" fill="url(#whub)" stroke="#f6e2a8" stroke-width="1.5"/>
        <text x="${C}" y="${C + 1}" class="hub-star" text-anchor="middle" dominant-baseline="middle">★</text>
      </svg>
      <svg viewBox="0 0 40 52" class="wheel-pointer">
        <defs><linearGradient id="wptr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff4c9"/><stop offset=".55" stop-color="#e2b24a"/><stop offset="1" stop-color="#8a6418"/></linearGradient></defs>
        <path d="M20 50 L5 18 A16 16 0 1 1 35 18 Z" fill="url(#wptr)" stroke="#0a1428" stroke-width="2.5" stroke-linejoin="round"/>
        <circle cx="20" cy="16" r="5.5" fill="#0a1428"/>
      </svg>`;
  }

  function createAuctionView(ctx) {
    let state = null,
      extra = {};
    let spinning = false,
      spinTimer = null,
      rotation = 0;
    const timer = setInterval(tick, 250);
    const readOnly = ctx.mode === "view";

    const pname = (id) => esc((AU.playerById(state, id) || {}).name || "?");
    const tname = (t) => esc(state.teamNames[t]);
    const ratingsMini = (p) =>
      `<div class="mini">${ROLES.map((r) => `<span>${r} <b>${p.ratings[r]}</b></span>`).join("")}</div>`;

    function update(next, ex) {
      const prevSpin = state && state.lastSpin;
      state = next;
      extra = ex || {};
      const spun =
        extra.spun && state.lastSpin && (!prevSpin || prevSpin.n !== state.lastSpin.n);
      draw();
      if (spun) startSpin();
    }

    function startSpin() {
      const ls = state.lastSpin,
        n = ls.wheel.length,
        seg = 360 / n;
      // land the chosen slice under the pointer, with a few full turns and a random offset inside the slice
      const inSlice = (Math.random() - 0.5) * seg * 0.7;
      const target = 360 - ((ls.index + 0.5) * seg + inSlice);
      spinning = true;
      draw(); // wheel drawn at its old angle first, then turned so the transition runs
      rotation += 360 * 5 + ((target - (rotation % 360) + 360) % 360);
      const el = qs(".wheel-rot");
      if (el) {
        void el.getBoundingClientRect();
        el.style.transition = `transform ${SPIN_MS}ms cubic-bezier(.12,.7,.15,1)`;
        el.style.transform = `rotate(${rotation}deg)`;
      }
      clearTimeout(spinTimer);
      spinTimer = setTimeout(() => {
        spinning = false;
        draw();
      }, SPIN_MS + 150);
    }

    function wheelHtml() {
      const s = state;
      // While spinning or bidding show the wheel the lot was drawn from; otherwise the players still unsold.
      const showLast =
        s.lastSpin && (spinning || s.phase === "bidding" || s.phase === "done");
      const ids = showLast ? s.lastSpin.wheel : s.queue;
      if (!showLast) rotation = rotation - (rotation % 360);
      const names = ids.map((id) => (AU.playerById(s, id) || {}).name || "?");
      const landed = showLast && !spinning;
      return `<div class="wheel${spinning ? " spinning" : ""}${landed ? " landed" : ""}">
          <div class="wheel-rot" style="transform:rotate(${rotation}deg)">${names.length ? wheelSvg(names, landed ? s.lastSpin.index : -1) : ""}</div>
          ${wheelFrameSvg()}
        </div>`;
    }

    function teamPanel(t) {
      const s = state,
        team = s.teams[t];
      const lot = s.phase === "bidding" && !spinning ? s.lot : null;
      const myTurn = lot && lot.turn === t;
      const leading = lot && lot.high.team === t;
      const max = AU.maxBid(s, t);
      const rows = team.players
        .map((x) => {
          const p = AU.playerById(s, x.id);
          return `<div class="au-row">
            <div class="grow"><div class="nm">${esc(p.name)}${x.captain ? '<span class="cap">♛</span>' : ""}</div>${ratingsMini(p)}</div>
            ${roleTag(bestRole(p))}
            <div class="price">${x.captain ? '<span class="muted small">captain</span>' : coin(x.price)}</div>
          </div>`;
        })
        .join("");
      const empty = Array.from(
        { length: AU.slotsLeft(s, t) },
        () => '<div class="au-row empty">open slot</div>',
      ).join("");
      let controls = "";
      if (lot && !readOnly) {
        if (myTurn) {
          const steps = [1, 2, 5].filter((d) => lot.high.amount + d <= max);
          controls = `<div class="bid-box">
            <div class="small">Your turn. Raise or pass (max bid ${coin(max)})</div>
            <div class="row" style="margin-top:8px">
              ${steps.map((d) => `<button class="btn primary" data-act="bid" data-team="${t}" data-amount="${lot.high.amount + d}">+${d} → ${lot.high.amount + d}</button>`).join("")}
            </div>
            <div class="row" style="margin-top:8px">
              <input type="number" min="${lot.high.amount + 1}" max="${max}" value="${Math.min(max, lot.high.amount + 1)}" data-custom="${t}" style="width:80px">
              <button class="btn" data-act="bid-custom" data-team="${t}">Bid</button>
              <span class="grow"></span>
              <button class="btn danger" data-act="pass" data-team="${t}">Pass</button>
            </div>
            <div class="small muted" style="margin-top:6px">Pass and ${tname(lot.high.team)} gets ${pname(lot.playerId)} for ${coin(lot.high.amount)}</div>
          </div>`;
        } else if (leading)
          controls = `<div class="bid-box lead">Winning at ${coin(lot.high.amount)}. Waiting for ${tname(E.other(t))}…</div>`;
      }
      return `<div class="panel au-team ${t === "A" ? "blue" : "red"} ${myTurn ? "turn" : ""}">
          <div class="au-head">
            <div class="tn">${tname(t)}</div>
            <div class="tokens">${coin(team.tokens)}<span class="small muted"> left</span></div>
          </div>
          <div class="small muted">Spent ${AU.spent(s, t)} · ${AU.slotsLeft(s, t)} slot${AU.slotsLeft(s, t) === 1 ? "" : "s"} open · max bid ${max}</div>
          <div class="au-list">${rows}${empty}</div>
          ${controls}
        </div>`;
    }

    function centerHtml() {
      const s = state;
      if (s.phase === "done" && !spinning) {
        return `<h2 style="text-align:center">Auction complete</h2>
          <div class="final">${AU.TEAMS.map((t) => `<div class="lobby-cap"><div class="tn">${tname(t)}</div>
            <div class="vs">${coin(AU.spent(s, t))}</div><div class="small muted">spent · ${s.teams[t].tokens} left</div>
            <div class="small muted" style="margin-top:6px">Best-role stars: ${AU.teamPower(s, t)}★</div></div>`).join("")}</div>
          <div class="row" style="justify-content:center;margin-top:14px">
            <button class="btn gold" data-act="copy">Copy teams for Discord</button>
            ${readOnly ? "" : '<a class="btn primary" href="#/setup/auction">New auction</a>'}
          </div>`;
      }
      const ls = s.lastSpin;
      if (spinning)
        return `${wheelHtml()}<div class="au-status">Spinning…</div>`;
      if (s.phase === "bidding") {
        const lot = s.lot,
          p = AU.playerById(s, lot.playerId);
        const left = s.deadline ? Math.max(0, Math.ceil((s.deadline - ctx.now()) / 1000)) : null;
        return `${wheelHtml()}
          <div class="au-lot">
            <div class="small muted">Lot ${lot.n} · nominated by ${tname(lot.nominator)}</div>
            <div class="au-player">${esc(p.name)}</div>
            ${ratingsMini(p)}
            <div class="au-bid ${lot.high.team === "A" ? "blue" : "red"}">${coin(lot.high.amount)} <span class="small">${tname(lot.high.team)}</span></div>
            <div class="small">${tname(lot.turn)} to answer${left != null ? ` · <b id="au-timer">${left}s</b>` : ""}</div>
            <div class="au-bids">${lot.bids.map((b) => `<span class="${b.team === "A" ? "blue" : "red"}">${b.amount}</span>`).join("")}</div>
          </div>`;
      }
      // spin phase
      const last = s.log[s.log.length - 1];
      const nom = s.teams[s.nominator].players.length < AU.TEAM_SIZE ? s.nominator : E.other(s.nominator);
      return `${wheelHtml()}
        ${last ? `<div class="au-status">${pname(last.playerId)} → <b>${tname(last.team)}</b> for ${coin(last.price)}${last.auto && last.bids === 1 ? ' <span class="badge">auto</span>' : ""}</div>` : ""}
        <div style="text-align:center;margin-top:10px">
          ${readOnly ? "" : `<button class="btn gold big" data-act="spin">Spin the wheel</button>`}
          <div class="small muted" style="margin-top:6px">${tname(nom)} nominates and opens at ${coin(1)} · ${s.queue.length} player${s.queue.length === 1 ? "" : "s"} left</div>
        </div>`;
    }

    function logHtml() {
      const s = state;
      return (
        s.log
          .slice()
          .reverse()
          .map(
            (e) =>
              `<div class="${e.team}">#${e.n} ${pname(e.playerId)} → <b>${tname(e.team)}</b> for ${coin(e.price)}${e.bids > 1 ? ` <span class="muted small">(${e.bids} bids)</span>` : ""}${e.auto ? ' <span class="badge">auto</span>' : ""}</div>`,
          )
          .join("") || '<span class="muted small">Nothing sold yet.</span>'
      );
    }

    function draw() {
      const s = state;
      document.title = s.teamNames.A + " vs " + s.teamNames.B + " · Auction";
      $app.innerHTML = `<div class="au-page">
        <div class="row" style="margin-bottom:12px">
          <h2 style="margin:0"><i class="coin"></i> Auction draft</h2>
          <span class="badge">${s.settings.tokens} tokens each</span>
          <span class="grow"></span>
          ${readOnly ? "" : `<button class="btn small" data-act="undo" ${extra.canUndo && !spinning ? "" : "disabled"}>Undo</button>`}
        </div>
        <div class="au-grid">
          ${teamPanel("A")}
          <div class="panel au-center">${centerHtml()}</div>
          ${teamPanel("B")}
        </div>
        <div class="panel"><h3>Sold</h3><div class="log">${logHtml()}</div></div>
      </div>`;
    }

    function tick() {
      if (!state || state.phase !== "bidding" || !state.deadline || spinning) return;
      const el = qs("#au-timer");
      const left = Math.max(0, Math.ceil((state.deadline - ctx.now()) / 1000));
      if (el) el.textContent = left + "s";
      if (ctx.now() >= state.deadline && ctx.onTick) ctx.onTick();
    }

    $app.onclick = (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || spinning) return;
      const act = b.dataset.act,
        t = b.dataset.team;
      if (act === "copy") return copy(AU.summary(state));
      if (readOnly) return;
      if (act === "undo") return ctx.undo();
      if (act === "spin") return ctx.act({ type: "spin", r: Math.random() });
      if (act === "pass") return ctx.act({ type: "pass", team: t });
      if (act === "bid") return ctx.act({ type: "bid", team: t, amount: +b.dataset.amount });
      if (act === "bid-custom") {
        const inp = qs(`[data-custom="${t}"]`);
        return ctx.act({ type: "bid", team: t, amount: +inp.value });
      }
    };

    return {
      update,
      get state() {
        return state;
      },
      destroy() {
        clearInterval(timer);
        clearTimeout(spinTimer);
      },
    };
  }

  function viewAuction(id) {
    let history = getLocals()[id].history || [];
    function persist(state) {
      const l = getLocals();
      l[id] = { state, history: history.slice(-40) };
      setLocals(l);
    }
    function commit(next, ex) {
      history.push(view.state);
      persist(next);
      view.update(next, Object.assign({ canUndo: true }, ex));
      if (next.phase === "done") saveToHistory(next, "auction");
    }
    const ctx = {
      mode: "local",
      now: () => Date.now(),
      act(action) {
        const r = AU.apply(view.state, action, Date.now());
        if (!r.ok) return toast(r.error, "err");
        // the bid clock starts once the wheel has stopped
        if (action.type === "spin" && r.state.deadline) r.state.deadline += SPIN_MS;
        commit(r.state, { spun: action.type === "spin" });
      },
      undo() {
        const prev = history.pop();
        if (!prev) return;
        const s = JSON.parse(JSON.stringify(prev));
        if (s.deadline) s.deadline = Date.now() + s.settings.bidTimer * 1000;
        persist(s);
        view.update(s, { canUndo: history.length > 0 });
      },
      onTick() {
        const r = AU.apply(view.state, { type: "timeout" }, Date.now());
        if (r.ok) commit(r.state);
      },
    };
    const s0 = getLocals()[id].state;
    // Resuming an old auction: give the current bid a fresh clock instead of timing out straight away.
    if (s0.deadline && s0.deadline < Date.now())
      s0.deadline = Date.now() + s0.settings.bidTimer * 1000;
    const view = createAuctionView(ctx);
    view.update(s0, { canUndo: history.length > 0 });
    cleanup = () => view.destroy();
  }

  /* =========================================================
   * Local hot-seat draft
   * ======================================================= */
  function viewLocal(id) {
    const locals = getLocals();
    const rec = locals[id];
    if (!rec) {
      $app.innerHTML =
        '<div class="panel"><h2>Local draft not found</h2><a class="btn" href="#/">Back</a></div>';
      return;
    }
    if (rec.state.kind === "auction") return viewAuction(id);
    let history = rec.history || [];
    function persist(state) {
      const l = getLocals();
      l[id] = { state, history: history.slice(-40) };
      setLocals(l);
    }
    function commit(next) {
      history.push(view.state);
      persist(next);
      view.update(next, { canUndo: history.length > 0 });
    }
    const ctx = {
      mode: "local",
      now: () => Date.now(),
      act(action, team) {
        const r = E.apply(
          view.state,
          Object.assign({}, action, { team }),
          Date.now(),
        );
        if (!r.ok) return toast(r.error, "err");
        commit(r.state);
      },
      undo() {
        const prev = history.pop();
        if (!prev) return;
        const s = JSON.parse(JSON.stringify(prev));
        if (s.deadline) s.deadline = Date.now() + s.settings.pickTimer * 1000;
        s.seq = view.state.seq + 1;
        persist(s);
        view.update(s, { canUndo: history.length > 0 });
      },
      onTick() {
        const r = E.apply(view.state, { type: "timeout" }, Date.now());
        if (r.ok) commit(r.state);
      },
      onDone(s) {
        saveToHistory(s, "local");
      },
    };
    // Resuming an old local draft: give the current turn a fresh clock instead of insta-autopicking.
    const s0 = rec.state;
    if (s0.phase === "swap") s0.deadline = null; // lock-in has no timer (older drafts may still carry one)
    if (s0.deadline && !s0.paused && s0.deadline < Date.now())
      s0.deadline = Date.now() + s0.settings.pickTimer * 1000;
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
        <button class="btn small" data-act="export" ${h.length ? "" : "disabled"}>Export all</button>
        <label class="btn small">Import<input type="file" id="hfile" accept=".json" hidden></label>
        <button class="btn small danger" data-act="clear" ${h.length ? "" : "disabled"}>Clear</button></div>
      <div class="list">${
        h
          .map((x, i) => {
            const s = x.state;
            if (s.kind === "auction")
              return `<div class="list-item">
          <span class="badge gold"><i class="coin"></i> auction</span>
          <div class="grow"><b>${esc(s.teamNames.A)}</b> ${AU.spent(s, "A")}<i class="coin"></i> vs ${AU.spent(s, "B")}<i class="coin"></i> <b>${esc(s.teamNames.B)}</b>
            <div class="small muted">${fmtDate(s.finishedAt)} · ${s.settings.tokens} tokens each</div></div>
          <a class="btn small" href="#/history/${i}">View</a>
          <button class="btn small" data-act="copy" data-i="${i}">Copy</button>
          <button class="btn small danger" data-act="del" data-i="${i}">✕</button>
        </div>`;
            const a = E.teamStars(s, "A"),
              b = E.teamStars(s, "B");
            return `<div class="list-item">
          <span class="badge ${x.mode === "import" ? "blue" : "gold"}">${x.mode}</span>
          <div class="grow"><b>${esc(s.teamNames.A)}</b> ${a}★ vs ${b}★ <b>${esc(s.teamNames.B)}</b>
            <div class="small muted">${fmtDate(s.finishedAt)}${s.cap != null ? " · cap " + s.cap + "★" : ""} · Δ ${Math.abs(a - b)}★</div></div>
          <a class="btn small" href="#/history/${i}">View</a>
          <button class="btn small" data-act="copy" data-i="${i}">Copy</button>
          <button class="btn small danger" data-act="del" data-i="${i}">✕</button>
        </div>`;
          })
          .join("") ||
        '<p class="muted">No finished drafts yet. They are saved here automatically when a draft ends.</p>'
      }</div></div>`;
    qs("#hfile").onchange = (e) => {
      const f = e.target.files[0];
      if (!f) return;
      f.text().then((t) => {
        try {
          const arr = JSON.parse(t);
          const list = (Array.isArray(arr) ? arr : [arr])
            .map((x) =>
              x.state
                ? x
                : {
                    id: x.id,
                    finishedAt: x.finishedAt,
                    mode: "import",
                    state: x,
                  },
            )
            .filter((x) => x.state && x.state.teams && x.state.players);
          LS.set("history", list.concat(getHistory()).slice(0, 200));
          toast("Imported " + list.length + " draft(s)", "ok");
          viewHistory();
        } catch (err) {
          toast("Invalid file: " + err.message, "err");
        }
      });
    };
    $app.onclick = (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const hist = getHistory();
      if (b.dataset.act === "export")
        download("doza-history.json", JSON.stringify(hist, null, 2));
      if (b.dataset.act === "copy") {
        const st = hist[+b.dataset.i].state;
        copy(st.kind === "auction" ? AU.summary(st) : E.summary(st));
      }
      if (b.dataset.act === "del") {
        hist.splice(+b.dataset.i, 1);
        LS.set("history", hist);
        viewHistory();
      }
      if (b.dataset.act === "clear" && confirm("Clear all history?")) {
        LS.set("history", []);
        viewHistory();
      }
    };
  }

  function viewHistoryItem(i) {
    const x = getHistory()[i];
    if (!x) {
      location.hash = "#/history";
      return;
    }
    const view = (x.state.kind === "auction" ? createAuctionView : createDraftView)({
      mode: "view",
      now: () => Date.now(),
      act() {},
      undo() {},
    });
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
      <h2>Team totals</h2>
      <ul>
        <li>A team's total is the sum of each player's rating <b>on the role they are placed on</b>. Totals and the win estimate update live on the board.</li>
        <li>There is <b>no star cap</b>: captains draft straight from the whole roster, and anyone not picked sits out.</li>
        <li>A pick is blocked only if the role is taken, the player is rated below the minimum role rating there, or it would leave a role on either team that nobody left can fill.</li>
      </ul>
      <h2>Draft flow</h2>
      <ol>
        <li><b>Lobby</b>: both captains sit at the same screen (or one shares it on Discord). Click Start draft when everyone is ready.</li>
        <li><b>Captains</b> (when they play) start on their main role, the one they're rated highest on. They can be moved to another role later, but not benched.</li>
        <li><b>Picks</b>: one player at a time, <b>alternating</b> (A B A B…). The first pick is a coin flip, and the other team gets <b>blue side</b>.</li>
        <li>Every pick is a <b>player + role</b>: drag the player onto an empty role slot on your side of the board (or tap the player, then the slot). The slot shows what the pick is worth and the new team total before you drop. At any time, without using a pick, a team can drag its players to another role, drop a roster player on one of its players to swap them in (the other one goes back to the roster), or drag a player back to the roster (that pick is given back at the end of the order). When the timer runs out, the highest-rated legal pick is made automatically.</li>
        <li><b>Lock in</b>: after the last pick the draft isn't final yet. Each captain can still change their team, then locks in. A lock-in can be cancelled until the other captain also locks in; once both are locked in, the draft is final.</li>
      </ol>
      <h2>Auction drafter</h2>
      <ol>
        <li>Choose the 10 players and both captains, and how many <b>tokens</b> each captain gets (20 by default). Captains join their own team for free; the other players are auctioned, so each team buys until it has 5. Roles don't matter.</li>
        <li>A <b>wheel</b> picks a random unsold player. Teams take turns nominating (the first nominator is a coin flip), and the nominating team <b>opens at 1 token</b>.</li>
        <li>The other team <b>raises or passes</b>, back and forth, until one of them passes. The highest bid buys the player and its tokens are spent.</li>
        <li>A team must keep <b>1 token for each other open slot</b>, so it can always complete its team. When a team is full it stops bidding, and the other team gets the remaining players for 1 token each. A bid is also final straight away when the other team can't afford to raise.</li>
        <li>With a bid timer, the team that has to answer passes when the time runs out. Undo takes back the last spin or bid.</li>
      </ol>
      <h2>Win estimate</h2>
      <p>The balance bar uses an Elo-style curve where each star of difference is worth about 7 percentage points near an even matchup. It's only a rough guide.</p>
      <h2>Saving</h2>
      <p>The player roster is the file <span class="kbd">data/players.json</span> that ships with the site. Run the app locally with <span class="kbd">npm run dev</span> and every rating edit is written into that file; commit and push it and everyone sees the new ratings. On the published site, edits stay in your browser only.</p>
      <p>Setup, drafts in progress and finished drafts are stored in this browser's <span class="kbd">localStorage</span>. Use export and import on History to move them.</p>
      <h2>Tips for fair ratings</h2>
      <ul>
        <li>5★ = among the best in your group on that role. 3★ = solid. 1★ = can't or won't play it.</li>
        <li>Rate relative to your own group, not to the whole ladder.</li>
        <li>After a few games, re-check the ratings of players who keep winning or losing lopsided games.</li>
      </ul>
    </div>`;
  }

  /* ========================================================= */
  window.addEventListener("hashchange", route);

  loadPool().then(() => {
    route();
    if (DEV)
      new EventSource("__dev/reload").onmessage = () => location.reload();
  });
})();
