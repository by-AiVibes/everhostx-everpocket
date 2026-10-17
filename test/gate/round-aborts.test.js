'use strict';
// An all-abort run must fail on aborts == 0. noDivergence ignores aborted nodes,
// so a round-start throw would otherwise look like a clean sim.
const test = require('node:test');
const { scen, EXT, NODES } = require('./lib/sim/run');
const { assertNoAborts } = require('./lib/assert-round');

test('healthy round start: aborts == 0', { timeout: 180000 }, async () => {
    const out = await scen('HEALTHY', { nodes: NODES, rounds: 4, ops: [EXT('C')] });
    assertNoAborts(out);
});
