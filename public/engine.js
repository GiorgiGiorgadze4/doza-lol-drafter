/*
 * Doza LoL Drafter - rules engine.
 * Pure functions shared by the browser (local mode / previews) and the Node server (online mode).
 *
 * Core rules
 *  - 10 players, each rated 1..5 stars on TOP / JNG / MID / ADC / SUP.
 *  - Two captains build 5-man teams; every pick = (player, role).
 *  - A player's stars on a team = his rating on the role he was assigned to.
 *  - Each team has a STAR CAP. By default cap = ceil(bestPossibleTotal / 2) + tolerance,
 *    where bestPossibleTotal is the best total all 10 players could reach if perfectly placed.
 *  - A pick is only legal if it keeps the team under cap AND the rest of the draft can still be
 *    completed with both teams under cap (no dead ends, ever).
 *  - No-cap mode (settings.noCap): any roster of 10+ players, captains draft straight from it, no star cap;
 *    the only legality rules are turn order, open role, min rating, and "both teams can still be filled".
 *  - Bench swaps: any time during the draft a team can swap a placed player for an unpicked roster player (no pick
 *    used), or send a player back to the roster, which gives the team that pick back at the end of the order.
 *  - Captains can be players: they start on their main (highest-rated) role, placed automatically.
 *  - Picks go one by one, alternating by default (A B A B ...; snake A B B A ... is optional); the team that picks second gets blue side.
 *  - Placed players can be moved / swapped between roles inside their own team at any time during
 *    the draft (no turn used, cap and feasibility still apply).
 *  - After the last pick both captains must lock in. Until both have, each can cancel their lock-in and keep
 *    rearranging; once both are locked in the draft is final.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DraftEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ROLES = ['TOP', 'JNG', 'MID', 'ADC', 'SUP'];
  const ROLE_NAMES = { TOP: 'Top', JNG: 'Jungle', MID: 'Mid', ADC: 'Bot / ADC', SUP: 'Support' };
  const TEAMS = ['A', 'B'];

  const DEFAULT_SETTINGS = {
    tolerance: 1,          // extra stars above an even split
    capOverride: 0,        // 0 = automatic cap
    minRoleRating: 1,      // players can't be placed on roles rated below this
    pickTimer: 45,         // seconds per pick, 0 = no timer
    captainsArePlayers: true,
    pickOrder: 'alternate', // 'alternate' | 'snake'
    noCap: false,          // true = no star cap; players come from a full roster (10 or more), teams just compare totals
  };

  const other = (t) => (t === 'A' ? 'B' : 'A');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function normalizePlayer(p) {
    const ratings = {};
    for (const r of ROLES) {
      const v = Math.round(Number(p.ratings && p.ratings[r]));
      ratings[r] = clamp(Number.isFinite(v) ? v : 1, 1, 5);
    }
    return { id: String(p.id), name: String(p.name || 'Player').slice(0, 32), ratings };
  }

  function normalizeSettings(s) {
    const o = Object.assign({}, DEFAULT_SETTINGS, s || {});
    o.tolerance = clamp(Math.round(+o.tolerance || 0), 0, 10);
    o.capOverride = clamp(Math.round(+o.capOverride || 0), 0, 25);
    o.minRoleRating = clamp(Math.round(+o.minRoleRating || 1), 1, 5);
    o.pickTimer = clamp(Math.round(+o.pickTimer || 0), 0, 600);
    o.captainsArePlayers = !!o.captainsArePlayers;
    o.noCap = !!o.noCap;
    o.pickOrder = o.pickOrder === 'snake' ? 'snake' : 'alternate';
    return o;
  }

  /* ---------- combinatorics ---------- */

  // Best total the given players can reach when placed into `slotsPerRole` slots per role.
  function bestAssignmentTotal(players, minR, slotsPerRole) {
    slotsPerRole = slotsPerRole || 2;
    const base = slotsPerRole + 1;
    let dp = new Map([[0, 0]]); // key: encoded counts per role -> best total
    for (const p of players) {
      const next = new Map();
      for (const [key, total] of dp) {
        let k = key;
        for (let ri = 0; ri < 5; ri++) {
          const used = Math.floor(key / Math.pow(base, ri)) % base;
          if (used >= slotsPerRole) continue;
          const r = p.ratings[ROLES[ri]];
          if (r < minR) continue;
          k = key + Math.pow(base, ri);
          const t = total + r;
          if (!next.has(k) || next.get(k) < t) next.set(k, t);
        }
      }
      dp = next;
    }
    let best = -1;
    for (const v of dp.values()) best = Math.max(best, v);
    return best; // -1 means impossible
  }

  /*
   * Can `players` (each with allowed teams) fill the open slots so that
   * stars(A) <= capA and stars(B) <= capB?  Slots are indexed 0..9 (A roles 0-4, B roles 5-9).
   * DP over (mask of filled slots) -> for each sumA the minimal sumB.
   */
  function canComplete(players, openMask, capA, capB, minR) {
    const need = players.length;
    let open = 0;
    for (let i = 0; i < 10; i++) if (openMask & (1 << i)) open++;
    if (open !== need) return false;
    if (capA < 0 || capB < 0) return false;
    let dp = new Map();
    const init = new Array(capA + 1).fill(Infinity);
    init[0] = 0;
    dp.set(0, init);
    for (const p of players) {
      const next = new Map();
      for (const [mask, arr] of dp) {
        for (let s = 0; s < 10; s++) {
          const bit = 1 << s;
          if (!(openMask & bit) || (mask & bit)) continue;
          const team = s < 5 ? 'A' : 'B';
          if (p.allowed && p.allowed !== team) continue;
          const r = p.ratings[ROLES[s % 5]];
          if (r < minR) continue;
          const nm = mask | bit;
          let target = next.get(nm);
          for (let sa = 0; sa <= capA; sa++) {
            const sb = arr[sa];
            if (sb === Infinity) continue;
            const na = team === 'A' ? sa + r : sa;
            const nb = team === 'B' ? sb + r : sb;
            if (na > capA || nb > capB) continue;
            if (!target) { target = new Array(capA + 1).fill(Infinity); next.set(nm, target); }
            if (nb < target[na]) target[na] = nb;
          }
        }
      }
      dp = next;
      if (dp.size === 0) return false;
    }
    return dp.size > 0;
  }

  /* ---------- state helpers ---------- */

  function playerById(state, id) {
    return state.players.find((p) => p.id === id) || null;
  }

  function teamStars(state, team) {
    let s = 0;
    for (const r of ROLES) {
      const pid = state.teams[team].slots[r];
      if (pid) s += playerById(state, pid).ratings[r];
    }
    return s;
  }

  function openRoles(state, team) {
    return ROLES.filter((r) => !state.teams[team].slots[r]);
  }

  function assignedIds(state) {
    const ids = new Set();
    for (const t of TEAMS) for (const r of ROLES) if (state.teams[t].slots[r]) ids.add(state.teams[t].slots[r]);
    return ids;
  }

  function captainTeamOf(state, pid) {
    for (const t of TEAMS) if (state.captains[t].playerId === pid) return t;
    return null;
  }

  // Players still waiting to be placed (includes captain-players who haven't locked a role).
  function unplaced(state) {
    const used = assignedIds(state);
    return state.players.filter((p) => !used.has(p.id));
  }

  // Draftable pool = unplaced minus reserved captains.
  function pool(state) {
    return unplaced(state).filter((p) => !captainTeamOf(state, p.id));
  }

  function openMaskOf(state) {
    let m = 0;
    TEAMS.forEach((t, ti) => ROLES.forEach((r, ri) => { if (!state.teams[t].slots[r]) m |= 1 << (ti * 5 + ri); }));
    return m;
  }

  // No-cap mode: can every open slot still get a distinct unplaced player rated >= min there,
  // with every unplaced captain landing on their own team? (bipartite matching, at most 10 slots)
  function canFillRoles(state) {
    const min = state.settings.minRoleRating;
    const open = [];
    for (const t of TEAMS) for (const r of ROLES) if (!state.teams[t].slots[r]) open.push({ t, r });
    const rest = unplaced(state);
    const caps = rest.filter((p) => captainTeamOf(state, p.id));
    const others = rest.filter((p) => !captainTeamOf(state, p.id));
    function matchOthers(free) {
      const owner = new Array(others.length).fill(-1);
      const tryAssign = (si, seen) => {
        for (let pi = 0; pi < others.length; pi++) {
          if (seen[pi] || others[pi].ratings[free[si].r] < min) continue;
          seen[pi] = true;
          if (owner[pi] < 0 || tryAssign(owner[pi], seen)) { owner[pi] = si; return true; }
        }
        return false;
      };
      return free.every((_, si) => tryAssign(si, []));
    }
    // at most 2 captains, so just try every placement for them
    function placeCaps(i, free) {
      if (i === caps.length) return matchOthers(free);
      const p = caps[i], t = captainTeamOf(state, p.id);
      return free.some((sl, k) => sl.t === t && p.ratings[sl.r] >= min && placeCaps(i + 1, free.filter((_, j) => j !== k)));
    }
    return placeCaps(0, open);
  }

  function stateFeasible(state) {
    if (state.settings.noCap) return canFillRoles(state);
    const rest = unplaced(state).map((p) => ({ ratings: p.ratings, allowed: captainTeamOf(state, p.id) }));
    return canComplete(
      rest, openMaskOf(state),
      state.cap - teamStars(state, 'A'), state.cap - teamStars(state, 'B'),
      state.settings.minRoleRating
    );
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- pick order ---------- */

  function buildOrder(first, needA, needB, mode) {
    const need = { A: needA, B: needB };
    const order = [];
    const total = needA + needB;
    for (let i = 0; i < total; i++) {
      let t;
      if (mode === 'alternate') t = i % 2 === 0 ? first : other(first);
      else t = ((i + 1) >> 1) % 2 === 0 ? first : other(first);
      if (need[t] === 0) t = other(t);
      need[t]--;
      order.push(t);
    }
    return order;
  }

  /* ---------- creation ---------- */

  function computeCap(players, settings) {
    const best = bestAssignmentTotal(players, settings.minRoleRating, 2);
    if (best < 0) return { best, cap: -1, feasible: false };
    let cap = settings.capOverride || Math.ceil(best / 2) + settings.tolerance;
    return { best, cap, feasible: true };
  }

  /*
   * opts: { players[10], captains: {A:{name, playerId}, B:{...}}, teamNames: {A,B}, settings, now, firstPick? }
   * Returns a fresh draft state (phase 'lobby'). Throws Error with a readable message when invalid.
   */
  function createDraft(opts) {
    const settings = normalizeSettings(opts.settings);
    const players = (opts.players || []).map(normalizePlayer);
    if (settings.noCap ? players.length < 10 : players.length !== 10) {
      throw new Error((settings.noCap ? 'At least' : 'Exactly') + ' 10 players are required (got ' + players.length + ').');
    }
    const ids = new Set(players.map((p) => p.id));
    if (ids.size !== players.length) throw new Error('Player ids must be unique.');
    const names = new Set(players.map((p) => p.name.toLowerCase()));
    if (names.size !== players.length) throw new Error('Player names must be unique.');

    const captains = { A: { name: 'Captain A', playerId: null }, B: { name: 'Captain B', playerId: null } };
    for (const t of TEAMS) {
      const c = (opts.captains && opts.captains[t]) || {};
      captains[t].name = String(c.name || captains[t].name).slice(0, 32);
      if (settings.captainsArePlayers && c.playerId) {
        if (!ids.has(String(c.playerId))) throw new Error('Captain ' + t + ' must be one of the players.');
        captains[t].playerId = String(c.playerId);
        captains[t].name = c.name || playerById({ players }, String(c.playerId)).name;
      }
    }
    if (captains.A.playerId && captains.A.playerId === captains.B.playerId) throw new Error('Captains must be different players.');

    const { best, cap: baseCap, feasible } = settings.noCap ? { best: null, cap: null, feasible: true } : computeCap(players, settings);
    if (!feasible) throw new Error('These 10 players cannot fill all 10 role slots with min rating ' + settings.minRoleRating + '.');

    const teamNames = {
      A: String((opts.teamNames && opts.teamNames.A) || 'Team ' + captains.A.name).slice(0, 32),
      B: String((opts.teamNames && opts.teamNames.B) || 'Team ' + captains.B.name).slice(0, 32),
    };

    const state = {
      v: 1,
      id: opts.id || null,
      createdAt: opts.now || Date.now(),
      settings, players, captains, teamNames,
      best, cap: baseCap, autoCapRaised: 0,
      teams: { A: { slots: {} }, B: { slots: {} } },
      phase: 'lobby',
      firstPick: opts.firstPick || (Math.random() < 0.5 ? 'A' : 'B'),
      sides: null,
      order: [], pickIndex: 0,
      locked: { A: !captains.A.playerId, B: !captains.B.playerId },
      ready: { A: false, B: false },
      deadline: null, paused: false, pausedRemaining: null,
      log: [],
      finishedAt: null,
      seq: 0,
    };
    for (const t of TEAMS) for (const r of ROLES) state.teams[t].slots[r] = null;
    state.sides = { [other(state.firstPick)]: 'blue', [state.firstPick]: 'red' };

    // Captain-players start on their main role (highest rating; ties go to the earlier role), so there's no
    // captain step. If that would make the draft unfinishable, the next best role is used.
    for (const t of TEAMS) {
      const pid = captains[t].playerId;
      if (!pid) continue;
      const p = playerById(state, pid);
      const roles = ROLES.filter((r) => p.ratings[r] >= settings.minRoleRating && !state.teams[t].slots[r])
        .sort((a, b) => p.ratings[b] - p.ratings[a] || ROLES.indexOf(a) - ROLES.indexOf(b));
      const role = roles.find((r) => {
        if (!settings.noCap) return true; // capped mode: the cap is raised below if needed
        const s = clone(state); s.teams[t].slots[r] = pid;
        return stateFeasible(s);
      });
      if (!role) throw new Error('Captain ' + p.name + ' has no role they can play.');
      state.teams[t].slots[role] = pid;
      state.locked[t] = true;
      state.log.push({ at: state.createdAt, kind: 'captain', team: t, playerId: pid, role, auto: true });
    }

    // If an automatic cap is too tight to finish (rare), raise it until the draft is completable.
    while (!stateFeasible(state)) {
      if (settings.noCap) throw new Error('Not enough players rated ' + settings.minRoleRating + '★ or more on each role to fill both teams.');
      if (settings.capOverride) throw new Error('No valid draft exists with a cap of ' + state.cap + ' stars. Raise the cap.');
      state.cap++; state.autoCapRaised++;
      if (state.cap > 25) throw new Error('No valid draft exists for these players.');
    }
    const needA = 5 - (captains.A.playerId ? 1 : 0);
    const needB = 5 - (captains.B.playerId ? 1 : 0);
    state.order = buildOrder(state.firstPick, needA, needB, settings.pickOrder);
    return state;
  }

  /* ---------- legality ---------- */

  function currentTeam(state) {
    if (state.phase !== 'draft') return null;
    return state.order[state.pickIndex] || null;
  }

  // Explain why (player, role) is or isn't legal for `team` right now.
  function checkPick(state, team, playerId, role) {
    if (state.phase !== 'draft') return { ok: false, reason: 'Not in draft phase' };
    if (currentTeam(state) !== team) return { ok: false, reason: 'Not your turn' };
    const p = playerById(state, playerId);
    if (!p) return { ok: false, reason: 'Unknown player' };
    if (!pool(state).some((x) => x.id === playerId)) return { ok: false, reason: 'Already taken' };
    if (!ROLES.includes(role)) return { ok: false, reason: 'Unknown role' };
    if (state.teams[team].slots[role]) return { ok: false, reason: 'Role filled' };
    const r = p.ratings[role];
    if (r < state.settings.minRoleRating) return { ok: false, reason: 'Rating below minimum (' + state.settings.minRoleRating + ')' };
    if (state.cap != null && teamStars(state, team) + r > state.cap) return { ok: false, reason: 'Over star cap' };
    const s = clone(state);
    s.teams[team].slots[role] = playerId;
    if (!stateFeasible(s)) return { ok: false, reason: 'Would make the draft impossible to finish' };
    return { ok: true };
  }

  function checkCaptainLock(state, team, role) {
    if (state.phase !== 'captains') return { ok: false, reason: 'Not in captain phase' };
    const pid = state.captains[team].playerId;
    if (!pid || state.locked[team]) return { ok: false, reason: 'Nothing to lock' };
    const p = playerById(state, pid);
    if (!ROLES.includes(role)) return { ok: false, reason: 'Unknown role' };
    const r = p.ratings[role];
    if (r < state.settings.minRoleRating) return { ok: false, reason: 'Rating below minimum' };
    if (state.cap != null && r > state.cap) return { ok: false, reason: 'Over star cap' };
    const s = clone(state);
    s.teams[team].slots[role] = pid;
    if (!stateFeasible(s)) return { ok: false, reason: 'Would make the draft impossible to finish' };
    return { ok: true };
  }

  // Move a placed player from r1 to r2 inside their own team: swaps with the teammate on r2, or moves into it if empty.
  // Allowed any time during the draft (doesn't use a turn) and in the swap phase.
  function checkSwap(state, team, r1, r2) {
    if (state.phase !== 'swap' && state.phase !== 'draft') return { ok: false, reason: 'Can\'t rearrange now' };
    if (!TEAMS.includes(team)) return { ok: false, reason: 'Unknown team' };
    if (state.phase === 'swap' && state.ready[team]) return { ok: false, reason: 'Locked in (cancel the lock-in to change)' };
    if (!ROLES.includes(r1) || !ROLES.includes(r2) || r1 === r2) return { ok: false, reason: 'Bad roles' };
    const slots = state.teams[team].slots;
    const a = playerById(state, slots[r1]), b = slots[r2] ? playerById(state, slots[r2]) : null;
    if (!a) return { ok: false, reason: 'Nobody to move' };
    const min = state.settings.minRoleRating;
    if (a.ratings[r2] < min || (b && b.ratings[r1] < min)) return { ok: false, reason: 'Rating below minimum' };
    const delta = a.ratings[r2] - a.ratings[r1] + (b ? b.ratings[r1] - b.ratings[r2] : 0);
    if (state.cap != null && teamStars(state, team) + delta > state.cap) return { ok: false, reason: 'Over star cap' };
    if (state.phase === 'draft') {
      const s = clone(state);
      s.teams[team].slots[r1] = slots[r2]; s.teams[team].slots[r2] = slots[r1];
      if (!stateFeasible(s)) return { ok: false, reason: 'Would make the draft impossible to finish' };
    }
    return { ok: true, delta };
  }

  // Swap a placed player for an unpicked roster player ("bench swap"). Any time during the draft or the final check,
  // either team, no pick used; the player who leaves goes back to the roster and can be picked by anyone.
  function checkBench(state, team, playerId, role) {
    if (state.phase !== 'draft' && state.phase !== 'swap') return { ok: false, reason: 'Can\'t change players now' };
    if (!TEAMS.includes(team) || !ROLES.includes(role)) return { ok: false, reason: 'Bad slot' };
    if (state.phase === 'swap' && state.ready[team]) return { ok: false, reason: 'Locked in (cancel the lock-in to change)' };
    const outId = state.teams[team].slots[role];
    if (!outId) return { ok: false, reason: 'Slot is empty' };
    if (captainTeamOf(state, outId)) return { ok: false, reason: 'Captains can\'t be benched' };
    const p = playerById(state, playerId);
    if (!p || !pool(state).some((x) => x.id === playerId)) return { ok: false, reason: 'Not on the roster' };
    const r = p.ratings[role];
    if (r < state.settings.minRoleRating) return { ok: false, reason: 'Rating below minimum (' + state.settings.minRoleRating + ')' };
    const delta = r - playerById(state, outId).ratings[role];
    if (state.cap != null && teamStars(state, team) + delta > state.cap) return { ok: false, reason: 'Over star cap' };
    if (state.phase === 'draft') {
      const s = clone(state);
      s.teams[team].slots[role] = playerId;
      if (!stateFeasible(s)) return { ok: false, reason: 'Would make the draft impossible to finish' };
    }
    return { ok: true, delta };
  }

  // Send a placed player back to the roster during the draft; the team gets that pick back at the end of the order.
  function checkRelease(state, team, role) {
    if (state.phase !== 'draft') return { ok: false, reason: 'Only during the draft' };
    if (!TEAMS.includes(team) || !ROLES.includes(role)) return { ok: false, reason: 'Bad slot' };
    const pid = state.teams[team].slots[role];
    if (!pid) return { ok: false, reason: 'Slot is empty' };
    if (captainTeamOf(state, pid)) return { ok: false, reason: 'Captains can\'t be benched' };
    return { ok: true, delta: -playerById(state, pid).ratings[role] };
  }

  function legalPicks(state, team) {
    const out = [];
    if (currentTeam(state) !== team) return out;
    for (const p of pool(state)) for (const r of openRoles(state, team)) {
      if (checkPick(state, team, p.id, r).ok) out.push({ playerId: p.id, role: r, stars: p.ratings[r] });
    }
    return out;
  }

  /* ---------- transitions ---------- */

  function setClock(state, now) {
    let secs = 0;
    if (state.phase === 'draft' || state.phase === 'captains') secs = state.settings.pickTimer;
    state.paused = false; state.pausedRemaining = null;
    state.deadline = secs ? now + secs * 1000 : null;
  }

  function enterDraftOrNext(state, now) {
    if (state.pickIndex >= state.order.length) return enterSwap(state, now);
    state.phase = 'draft';
    setClock(state, now);
  }

  // After the last pick the draft is not final until both captains lock in (no timer). Either can cancel their
  // lock-in while the other hasn't locked yet; a locked team can't be changed.
  function enterSwap(state, now) {
    state.phase = 'swap';
    state.ready = { A: false, B: false };
    setClock(state, now);
  }

  function finish(state, now) {
    state.phase = 'done';
    state.deadline = null;
    state.finishedAt = now;
  }

  function start(state, now) {
    if (state.locked.A && state.locked.B) enterDraftOrNext(state, now);
    else { state.phase = 'captains'; setClock(state, now); }
  }

  function bestAutoPick(state, team) {
    const legal = legalPicks(state, team);
    if (!legal.length) return null;
    legal.sort((x, y) => y.stars - x.stars ||
      Math.max(...Object.values(playerById(state, y.playerId).ratings)) - Math.max(...Object.values(playerById(state, x.playerId).ratings)));
    return legal[0];
  }

  /*
   * Apply an action. Returns { ok, error?, state } (state is a new object on success).
   * action.team is the acting seat ('A' | 'B' | 'admin'); online the server sets it from the seat key.
   */
  function apply(prev, action, now) {
    now = now || Date.now();
    const state = clone(prev);
    const t = action.team;
    const fail = (error) => ({ ok: false, error, state: prev });
    const logPush = (e) => state.log.push(Object.assign({ at: now }, e));

    switch (action.type) {
      case 'ready': {
        if (state.phase === 'lobby') {
          if (!TEAMS.includes(t)) return fail('Only captains can ready up');
          state.ready[t] = action.value !== false;
          if (state.ready.A && state.ready.B) { state.ready = { A: false, B: false }; start(state, now); }
          break;
        }
        if (state.phase === 'swap') {
          if (!TEAMS.includes(t)) return fail('Only captains can lock in');
          state.ready[t] = action.value !== false;
          logPush({ kind: state.ready[t] ? 'lock' : 'unlock', team: t });
          if (state.ready.A && state.ready.B) finish(state, now);
          break;
        }
        return fail('Nothing to ready for');
      }
      case 'forceStart': {
        if (t !== 'admin') return fail('Admin only');
        if (state.phase !== 'lobby') return fail('Already started');
        state.ready = { A: false, B: false };
        start(state, now);
        break;
      }
      case 'lockCaptain': {
        const c = checkCaptainLock(state, t, action.role);
        if (!c.ok) return fail(c.reason);
        state.teams[t].slots[action.role] = state.captains[t].playerId;
        state.locked[t] = true;
        logPush({ kind: 'captain', team: t, playerId: state.captains[t].playerId, role: action.role, auto: !!action.auto });
        if (state.locked.A && state.locked.B) enterDraftOrNext(state, now);
        break;
      }
      case 'pick': {
        const c = checkPick(state, t, action.playerId, action.role);
        if (!c.ok) return fail(c.reason);
        state.teams[t].slots[action.role] = action.playerId;
        logPush({ kind: 'pick', team: t, playerId: action.playerId, role: action.role, auto: !!action.auto, n: state.pickIndex + 1 });
        state.pickIndex++;
        enterDraftOrNext(state, now);
        break;
      }
      case 'swap': {
        const c = checkSwap(state, t, action.r1, action.r2);
        if (!c.ok) return fail(c.reason);
        const slots = state.teams[t].slots;
        const tmp = slots[action.r1]; slots[action.r1] = slots[action.r2]; slots[action.r2] = tmp;
        logPush({ kind: slots[action.r1] ? 'swap' : 'move', team: t, r1: action.r1, r2: action.r2, playerId: slots[action.r2] });
        break;
      }
      case 'bench': {
        const c = checkBench(state, t, action.playerId, action.role);
        if (!c.ok) return fail(c.reason);
        const out = state.teams[t].slots[action.role];
        state.teams[t].slots[action.role] = action.playerId;
        logPush({ kind: 'bench', team: t, playerId: action.playerId, out, role: action.role });
        break;
      }
      case 'release': {
        const c = checkRelease(state, t, action.role);
        if (!c.ok) return fail(c.reason);
        const out = state.teams[t].slots[action.role];
        state.teams[t].slots[action.role] = null;
        state.order.push(t); // the team gets that pick back
        logPush({ kind: 'release', team: t, playerId: out, role: action.role });
        break;
      }
      case 'timeout': {
        if (!state.deadline || state.paused || now < state.deadline) return fail('Clock not expired');
        if (state.phase === 'captains') {
          for (const team of TEAMS) {
            if (state.locked[team]) continue;
            const p = playerById(state, state.captains[team].playerId);
            const roles = ROLES.filter((r) => checkCaptainLock(state, team, r).ok).sort((a, b) => p.ratings[b] - p.ratings[a]);
            const res = apply(state, { type: 'lockCaptain', team, role: roles[0], auto: true }, now);
            if (!res.ok) return fail(res.error);
            Object.assign(state, res.state);
          }
          break;
        }
        if (state.phase === 'draft') {
          const team = currentTeam(state);
          const pick = bestAutoPick(state, team);
          if (!pick) return fail('No legal pick');
          return apply(state, { type: 'pick', team, playerId: pick.playerId, role: pick.role, auto: true }, now);
        }
        return fail('Nothing to time out');
      }
      case 'pause': {
        if (t !== 'admin') return fail('Admin only');
        if (!state.deadline || state.paused) return fail('Nothing to pause');
        state.paused = true; state.pausedRemaining = Math.max(0, state.deadline - now);
        break;
      }
      case 'resume': {
        if (t !== 'admin') return fail('Admin only');
        if (!state.paused) return fail('Not paused');
        state.paused = false; state.deadline = now + state.pausedRemaining; state.pausedRemaining = null;
        break;
      }
      default:
        return fail('Unknown action');
    }
    state.seq = (prev.seq || 0) + 1;
    return { ok: true, state };
  }

  /* ---------- stats ---------- */

  // Elo-like estimate: each star of difference ~ +7 percentage points near 50/50.
  function winChance(starsA, starsB) {
    return 1 / (1 + Math.pow(10, -(starsA - starsB) / 8));
  }

  function summary(state) {
    const lines = [];
    for (const t of TEAMS) {
      lines.push('**' + state.teamNames[t] + '** (' + state.sides[t] + ' side) - ' + teamStars(state, t) + (state.cap != null ? '/' + state.cap : '') + ' stars');
      for (const r of ROLES) {
        const p = playerById(state, state.teams[t].slots[r]);
        lines.push('  ' + r.padEnd(3) + '  ' + (p ? p.name + '  ' + '★'.repeat(p.ratings[r]) : '-'));
      }
    }
    const a = teamStars(state, 'A'), b = teamStars(state, 'B');
    lines.push('Estimated: ' + state.teamNames.A + ' ' + Math.round(winChance(a, b) * 100) + '% - ' + Math.round(winChance(b, a) * 100) + '% ' + state.teamNames.B);
    return lines.join('\n');
  }

  return {
    ROLES, ROLE_NAMES, TEAMS, DEFAULT_SETTINGS,
    other, normalizePlayer, normalizeSettings,
    bestAssignmentTotal, canComplete, computeCap,
    createDraft, apply, currentTeam,
    checkPick, checkCaptainLock, checkSwap, checkBench, checkRelease, legalPicks,
    playerById, teamStars, openRoles, pool, unplaced, captainTeamOf,
    winChance, summary,
  };
});
