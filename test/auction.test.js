// Fuzz test: random auctions must always end with two full teams and no team overspending.
const assert = require('assert');
const A = require('../public/auction.js');
const E = require('../public/engine.js');

const rnd = () => 1 + Math.floor(Math.random() * 9) / 2;
let done = 0;
for (let trial = 0; trial < 500; trial++) {
  const players = Array.from({ length: 10 }, (_, i) => ({
    id: 'p' + i, name: 'P' + i, ratings: Object.fromEntries(E.ROLES.map((r) => [r, rnd()])),
  }));
  const capP = trial % 3 !== 0;
  const tokens = [5, 10, 20, 37][trial % 4];
  let s = A.createAuction({
    players,
    captains: { A: { playerId: capP ? 'p0' : null }, B: { playerId: capP ? 'p1' : null } },
    settings: { tokens, bidTimer: trial % 5 === 0 ? 10 : 0 },
  });
  assert.strictEqual(s.queue.length, capP ? 8 : 10);
  let steps = 0;
  while (s.phase !== 'done') {
    assert(++steps < 500, 'auction did not finish');
    let r;
    if (s.phase === 'spin') {
      r = A.apply(s, { type: 'spin', r: Math.random() });
      assert(r.ok, r.error);
      if (r.state.phase === 'bidding') {
        assert.strictEqual(r.state.lot.high.amount, 1, 'nominator opens at 1');
        assert.notStrictEqual(r.state.lot.turn, r.state.lot.nominator, 'other team answers the opening bid');
      }
    } else {
      const t = s.lot.turn, max = A.maxBid(s, t);
      assert(!A.apply(s, { type: 'bid', team: A.TEAMS.find((x) => x !== t), amount: max }).ok, 'out of turn bid');
      assert(!A.apply(s, { type: 'bid', team: t, amount: max + 1 }).ok, 'over max bid');
      assert(!A.apply(s, { type: 'bid', team: t, amount: s.lot.high.amount }).ok, 'bid must raise');
      const roll = Math.random();
      if (s.deadline && roll < 0.1) r = A.apply(s, { type: 'timeout' }, s.deadline + 1);
      else if (roll < 0.4) r = A.apply(s, { type: 'pass', team: t });
      else r = A.apply(s, { type: 'bid', team: t, amount: s.lot.high.amount + 1 + Math.floor(Math.random() * (max - s.lot.high.amount)) });
      assert(r.ok, r.error);
    }
    s = r.state;
    for (const t of A.TEAMS) {
      assert(s.teams[t].tokens >= A.slotsLeft(s, t), 'team must keep 1 token per open slot');
      assert(A.slotsLeft(s, t) >= 0, 'team overfilled');
    }
  }
  for (const t of A.TEAMS) {
    assert.strictEqual(s.teams[t].players.length, 5, 'team not full');
    assert(s.teams[t].tokens >= 0, 'overspent');
  }
  const ids = A.TEAMS.flatMap((t) => s.teams[t].players.map((x) => x.id));
  assert.strictEqual(new Set(ids).size, 10, 'every player sold exactly once');
  done++;
}
console.log('OK - ' + done + ' random auctions finished with two full teams');
