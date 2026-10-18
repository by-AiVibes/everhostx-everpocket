'use strict';
// A lagging local reader must not abort rounds (and must not split state).
const test = require('node:test');
const assert = require('node:assert/strict');
const { scen, EXT, NODES } = require('./lib/sim/run');
const S = require('./lib/assert-sim');
test('one node 40 ledgers behind: no aborts, no divergence, op completes', { timeout: 600000 }, async () => {
    const out = await scen('LAG', { nodes: NODES, rounds: 40, ops: [EXT('C')], lag: (r, L) => ({ B: L.validated - 40 }) });
    assert.equal(out.aborts, 0, `rounds aborted ${out.aborts} times: ${out.errs.slice(0, 3)}`);
    S.noDivergence(out); S.allCompleteLandedOnce(out);
});
test('all nodes healthy: no aborts at all', { timeout: 600000 }, async () => {
    const out = await scen('NOLAG', { nodes: NODES, rounds: 20, ops: [EXT('C')] });
    assert.equal(out.aborts, 0, `rounds aborted ${out.aborts} times: ${out.errs.slice(0, 3)}`);
});
