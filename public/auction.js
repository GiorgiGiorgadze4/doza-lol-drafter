/*
 * Doza LoL Drafter - auction rules engine.
 * Pure functions, shared by the browser and the Node tests (same style as engine.js).
 *
 * Rules
 *  - 10 players. Captains (when they play) are on their team for free; everyone else is auctioned,
 *    so each team buys until it has 5 players. Roles don't matter here.
 *  - Each captain starts with the same number of tokens.
 *  - A wheel picks the next player at random from the unsold ones. Teams take turns nominating, blue (A) first:
 *    the nominating team automatically opens at 1 token, then the other team may raise or pass,
 *    back and forth, until someone passes. The highest bid buys the player.
 *  - A team must keep 1 token for every other slot it still has to fill, so it can never be left
 *    unable to complete its team (max bid = tokens - (open slots - 1)).
 *  - A full team can't bid: the other team gets the remaining players at the opening price.
 *    A lot also closes straight away when the other team can't afford to raise.
 *  - Optional bid timer: when it runs out, the team that has to answer passes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.AuctionEngine = factory(root.DraftEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const TEAMS = ['A', 'B'];
  const TEAM_SIZE = 5;
  const DEFAULT_SETTINGS = {
    tokens: 20,   // tokens per captain
    bidTimer: 0,  // seconds to answer a bid, 0 = no timer
  };

  const other = (t) => (t === 'A' ? 'B' : 'A');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function normalizeSettings(s) {
    const o = Object.assign({}, DEFAULT_SETTINGS, s || {});
    o.tokens = clamp(Math.round(+o.tokens || 0), TEAM_SIZE, 1000);
    o.bidTimer = clamp(Math.round(+o.bidTimer || 0), 0, 300);
    return o;
  }

  function playerById(state, id) {
    return state.players.find((p) => p.id === id) || null;
  }

  const slotsLeft = (state, t) => TEAM_SIZE - state.teams[t].players.length;

  // Most a team may bid right now: everything except 1 token for each other slot it still needs.
  function maxBid(state, t) {
    const open = slotsLeft(state, t);
    return open > 0 ? state.teams[t].tokens - (open - 1) : 0;
  }

  /*
   * opts: { players[10], captains: {A:{playerId|null, name}, B:{...}}, teamNames: {A,B}, settings, now }
   * Returns a fresh auction state (phase 'spin'). Throws Error with a readable message when invalid.
   */
  function createAuction(opts) {
    const settings = normalizeSettings(opts.settings);
    const players = (opts.players || []).map(E.normalizePlayer);
    if (players.length !== 10) throw new Error('Exactly 10 players are required (got ' + players.length + ').');
    if (new Set(players.map((p) => p.id)).size !== players.length) throw new Error('Duplicate players.');

    const captains = {};
    for (const t of TEAMS) {
      const c = (opts.captains && opts.captains[t]) || {};
      const p = c.playerId ? players.find((x) => x.id === c.playerId) : null;
      if (c.playerId && !p) throw new Error('Captain ' + t + ' is not one of the 10 players.');
      captains[t] = { playerId: p ? p.id : null, name: String((p && p.name) || c.name || 'Captain ' + t).slice(0, 32) };
    }
    if (captains.A.playerId && captains.A.playerId === captains.B.playerId) throw new Error('The captains must be two different players.');

    const teams = {};
    for (const t of TEAMS) {
      teams[t] = { tokens: settings.tokens, players: captains[t].playerId ? [{ id: captains[t].playerId, price: 0, captain: true }] : [] };
    }
    const capIds = new Set(TEAMS.map((t) => captains[t].playerId).filter(Boolean));
    const queue = players.filter((p) => !capIds.has(p.id)).map((p) => p.id);

    const firstPick = 'A'; // team A is the blue (left) side and always opens the first lot
    return {
      kind: 'auction',
      v: 1,
      id: opts.id || null,
      createdAt: opts.now || Date.now(),
      settings, players, captains,
      teamNames: {
        A: String((opts.teamNames && opts.teamNames.A) || 'Team ' + captains.A.name).slice(0, 32),
        B: String((opts.teamNames && opts.teamNames.B) || 'Team ' + captains.B.name).slice(0, 32),
      },
      teams, queue,
      phase: 'spin',
      firstPick,
      nominator: firstPick,
      lot: null,
      lotCount: 0,
      lastSpin: null, // { n, wheel: ids on the wheel, index, playerId } for the wheel animation
      deadline: null,
      log: [],
      finishedAt: null,
      seq: 0,
    };
  }

  // Who opens the next lot: the team whose turn it is, unless that team is already full.
  function nextNominator(state) {
    const t = state.nominator;
    return slotsLeft(state, t) > 0 ? t : other(t);
  }

  function setDeadline(state, now) {
    state.deadline = state.settings.bidTimer && state.phase === 'bidding' ? now + state.settings.bidTimer * 1000 : null;
  }

  function sell(state, now, auto) {
    const lot = state.lot, t = lot.high.team;
    state.teams[t].tokens -= lot.high.amount;
    state.teams[t].players.push({ id: lot.playerId, price: lot.high.amount });
    state.queue = state.queue.filter((id) => id !== lot.playerId);
    state.log.push({ n: state.lotCount, playerId: lot.playerId, team: t, price: lot.high.amount, bids: lot.bids.length, auto: !!auto });
    state.nominator = other(lot.nominator);
    state.lot = null;
    if (state.queue.length === 0) {
      state.phase = 'done';
      state.finishedAt = now;
    } else state.phase = 'spin';
    setDeadline(state, now);
  }

  // After a bid: hand the turn to the other team, or close the lot if it can't raise.
  function afterBid(state, now) {
    const lot = state.lot, answer = other(lot.high.team);
    if (maxBid(state, answer) <= lot.high.amount) return sell(state, now, true);
    lot.turn = answer;
    setDeadline(state, now);
  }

  function apply(prev, action, now) {
    now = now || Date.now();
    const fail = (error) => ({ ok: false, error });
    const state = clone(prev);
    const t = action.team;
    switch (action.type) {
      case 'spin': {
        if (state.phase !== 'spin') return fail('Not time to spin');
        const r = Number.isFinite(action.r) ? clamp(action.r, 0, 0.999999) : Math.random();
        const wheel = state.queue.slice();
        const idx = Math.floor(r * wheel.length);
        const nominator = nextNominator(state);
        state.lotCount++;
        state.lot = {
          n: state.lotCount, playerId: wheel[idx], wheel, index: idx, nominator,
          high: { team: nominator, amount: 1 }, bids: [{ team: nominator, amount: 1 }], turn: other(nominator),
        };
        state.lastSpin = { n: state.lotCount, wheel, index: idx, playerId: wheel[idx] };
        state.phase = 'bidding';
        afterBid(state, now);
        break;
      }
      case 'bid': {
        if (state.phase !== 'bidding') return fail('No player is up for auction');
        const lot = state.lot;
        if (t !== lot.turn) return fail('Not your turn to bid');
        const amount = Math.round(+action.amount);
        if (!(amount > lot.high.amount)) return fail('Bid must be more than ' + lot.high.amount);
        if (amount > maxBid(state, t)) return fail('You can bid at most ' + maxBid(state, t) + ' (1 token is kept for each other open slot)');
        lot.high = { team: t, amount };
        lot.bids.push({ team: t, amount });
        afterBid(state, now);
        break;
      }
      case 'pass': {
        if (state.phase !== 'bidding') return fail('No player is up for auction');
        if (t !== state.lot.turn) return fail('Not your turn');
        sell(state, now, false);
        break;
      }
      case 'timeout': {
        if (state.phase !== 'bidding' || !state.deadline || now < state.deadline) return fail('Not timed out');
        sell(state, now, true);
        break;
      }
      default:
        return fail('Unknown action');
    }
    state.seq = (prev.seq || 0) + 1;
    return { ok: true, state };
  }

  const spent = (state, t) => state.settings.tokens - state.teams[t].tokens;
  // Rough strength for comparing teams: each player's best rating on any role.
  const bestRating = (p) => Math.max(...E.ROLES.map((r) => p.ratings[r]));
  const teamPower = (state, t) => state.teams[t].players.reduce((s, x) => s + bestRating(playerById(state, x.id)), 0);

  function summary(state) {
    const lines = [];
    for (const t of TEAMS) {
      lines.push('**' + state.teamNames[t] + '** - spent ' + spent(state, t) + '/' + state.settings.tokens + ' tokens');
      for (const x of state.teams[t].players) {
        lines.push('  ' + playerById(state, x.id).name + (x.captain ? ' (captain)' : '  ' + x.price + ' tokens'));
      }
    }
    return lines.join('\n');
  }

  return {
    TEAMS, TEAM_SIZE, DEFAULT_SETTINGS,
    normalizeSettings, createAuction, apply,
    playerById, slotsLeft, maxBid, spent, teamPower, summary,
  };
});
