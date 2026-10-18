// Fuzz test: random pools must always draft to completion without breaking the cap.
const assert = require('assert');
const E = require('../public/engine.js');

const rnd = () => 1 + Math.floor(Math.random() * 9) / 2; // 1..5 in half-star steps

// After the last pick: not final until both lock in; a lock-in can be cancelled until the other team locks too.
function lockIn(s) {
  assert.strictEqual(s.phase, 'swap');
  const step = (st, team, value) => { const r = E.apply(st, { type: 'ready', team, value }); assert(r.ok, r.error); return r.state; };
  s = step(s, 'A', true);
  assert(!E.checkSwap(s, 'A', 'TOP', 'MID').ok, 'locked team must not change');
  s = step(s, 'A', false);
  assert.strictEqual(s.phase, 'swap', 'cancelled lock-in must not finish');
  s = step(s, 'B', true);
  assert.strictEqual(s.phase, 'swap', 'one lock-in must not finish');
  s = step(s, 'A', true);
  assert.strictEqual(s.phase, 'done', 'both locked in = final');
  assert(!E.apply(s, { type: 'ready', team: 'A', value: false }).ok, 'final draft cannot be unlocked');
  return s;
}
let drafts = 0;
for (let trial = 0; trial < 500; trial++) {
  const players = Array.from({ length: 10 }, (_, i) => ({
    id: 'p' + i, name: 'P' + i, ratings: Object.fromEntries(E.ROLES.map((r) => [r, rnd()])),
  }));
  const capP = trial % 2 === 0;
  let s;
  try {
    s = E.createDraft({
      players,
      captains: { A: { playerId: capP ? 'p0' : null }, B: { playerId: capP ? 'p1' : null } },
      settings: { minRoleRating: trial % 3 === 0 ? 2 : 1, pickOrder: trial % 4 === 0 ? 'alternate' : 'snake' },
    });
  } catch (e) { continue; } // impossible pools are rejected up-front, that's fine
  s = E.apply(s, { type: 'forceStart', team: 'admin' }).state;
  let guard = 0;
  while (s.phase !== 'done') {
    assert(guard++ < 50, 'draft did not finish');
    if (s.phase === 'draft') {
      // random legal rearranging of placed players mid-draft (moves into empty roles or swaps)
      for (const t of E.TEAMS) {
        const r1 = E.ROLES.filter((r) => s.teams[t].slots[r])[Math.floor(Math.random() * 5)];
        const r2 = E.ROLES[Math.floor(Math.random() * 5)];
        if (r1 && E.checkSwap(s, t, r1, r2).ok) {
          const r = E.apply(s, { type: 'swap', team: t, r1, r2 });
          assert(r.ok, r.error); s = r.state;
          assert(E.teamStars(s, t) <= s.cap, 'cap violated by move');
        }
      }
      // random legal pick (more adversarial than auto-pick)
      const legal = E.legalPicks(s, E.currentTeam(s));
      assert(legal.length > 0, 'dead end: no legal pick');
      const m = legal[Math.floor(Math.random() * legal.length)];
      const r = E.apply(s, { type: 'pick', team: E.currentTeam(s), playerId: m.playerId, role: m.role });
      assert(r.ok, r.error); s = r.state;
    } else {
      s = lockIn(s);
    }
  }
  for (const t of E.TEAMS) {
    assert(E.teamStars(s, t) <= s.cap, 'cap violated');
    assert.strictEqual(E.openRoles(s, t).length, 0, 'team not full');
  }
  drafts++;
}
console.log('OK - ' + drafts + ' random drafts completed without dead ends or cap violations');

// No-cap mode: captains draft straight from a full roster (10-16 players); it must always finish with full teams.
let rosterDrafts = 0;
for (let trial = 0; trial < 300; trial++) {
  const n = 10 + Math.floor(Math.random() * 7);
  const players = Array.from({ length: n }, (_, i) => ({
    id: 'p' + i, name: 'P' + i, ratings: Object.fromEntries(E.ROLES.map((r) => [r, rnd()])),
  }));
  let s;
  try {
    s = E.createDraft({
      players,
      captains: { A: { playerId: trial % 2 ? 'p0' : null }, B: { playerId: trial % 2 ? 'p1' : null } },
      settings: { noCap: true, minRoleRating: trial % 3 === 0 ? 2 : 1 },
    });
  } catch (e) { continue; }
  assert.strictEqual(s.cap, null);
  s = E.apply(s, { type: 'forceStart', team: 'admin' }).state;
  let guard = 0, releases = 0;
  while (s.phase !== 'done') {
    assert(guard++ < 50, 'roster draft did not finish');
    if (s.phase === 'draft') {
      // random bench swaps (either team, any turn) and a few releases back to the roster
      for (const t of E.TEAMS) {
        const role = E.ROLES[Math.floor(Math.random() * 5)];
        const bench = E.pool(s)[0];
        if (bench && E.checkBench(s, t, bench.id, role).ok) {
          const r = E.apply(s, { type: 'bench', team: t, playerId: bench.id, role });
          assert(r.ok, r.error); s = r.state;
        }
        if (releases < 3 && Math.random() < 0.15 && E.checkRelease(s, t, role).ok) {
          const r = E.apply(s, { type: 'release', team: t, role });
          assert(r.ok, r.error); s = r.state; releases++;
        }
      }
      const legal = E.legalPicks(s, E.currentTeam(s));
      assert(legal.length > 0, 'roster dead end: no legal pick');
      const m = legal[Math.floor(Math.random() * legal.length)];
      const r = E.apply(s, { type: 'pick', team: E.currentTeam(s), playerId: m.playerId, role: m.role });
      assert(r.ok, r.error); s = r.state;
    } else {
      s = lockIn(s);
    }
  }
  for (const t of E.TEAMS) assert.strictEqual(E.openRoles(s, t).length, 0, 'roster team not full');
  assert.strictEqual(E.unplaced(s).length, n - 10);
  rosterDrafts++;
}
console.log('OK - ' + rosterDrafts + ' no-cap roster drafts completed');
