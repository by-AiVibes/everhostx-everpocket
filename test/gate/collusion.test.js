'use strict';
// 2 of 5 colluding (same fake hash/sequence/extend result) must not move agreed state.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scen, EXT, NODES } = require('./lib/sim/run');
const S = require('./lib/assert-sim');
test('2/5 colluding liars: safety holds', { timeout: 600000 }, async () => {
    const out = await scen('COLLUDE2', { nodes: NODES, rounds: 30, ops: [EXT('C')], modes: i => i === 'A' || i === 'B' ? 'collude' : 'ok' });
    S.noDivergence(out); S.atMostOnce(out);
    assert.notEqual(out.agreedSeq, 99, 'colluders set tenant sequence');
});
