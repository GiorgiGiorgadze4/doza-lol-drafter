// Fuzz test: random pools must always draft to completion without breaking the cap.
const assert = require('assert');
const E = require('../public/engine.js');

const rnd = () => 1 + Math.floor(Math.random() * 5);
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
      // random legal pick (more adversarial than auto-pick)
      const legal = E.legalPicks(s, E.currentTeam(s));
      assert(legal.length > 0, 'dead end: no legal pick');
      const m = legal[Math.floor(Math.random() * legal.length)];
      const r = E.apply(s, { type: 'pick', team: E.currentTeam(s), playerId: m.playerId, role: m.role });
      assert(r.ok, r.error); s = r.state;
    } else {
      s.deadline = 1;
      const r = E.apply(s, { type: 'timeout' }, 5);
      assert(r.ok, s.phase + ': ' + r.error); s = r.state;
    }
  }
  for (const t of E.TEAMS) {
    assert(E.teamStars(s, t) <= s.cap, 'cap violated');
    assert.strictEqual(E.openRoles(s, t).length, 0, 'team not full');
  }
  drafts++;
}
console.log('OK - ' + drafts + ' random drafts completed without dead ends or cap violations');
