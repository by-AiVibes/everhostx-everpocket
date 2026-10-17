'use strict';
// A null / failed node-local reader must never split agreed state.
const test = require('node:test');
const { scen, EXT, NODES } = require('./lib/sim/run');
const A = require('./lib/assert-sim');
const T = { timeout: 600000 };
test('getTxAt returns null on one node: no divergence, op completes once', T, async () => {
    const out = await scen('TXNULL', { nodes: NODES, rounds: 40, ops: [EXT('C')], modes: i => i === 'B' ? 'txnull' : 'ok' });
    A.noDivergence(out); A.allCompleteLandedOnce(out);
});
test('sequence reader fails on one node: no divergence, ops complete once', T, async () => {
    const out = await scen('SEQFAIL', { nodes: NODES, rounds: 40, ops: [EXT('C'), EXT('D')], modes: i => i === 'B' ? 'seqfail' : 'ok' });
    A.noDivergence(out); A.allCompleteLandedOnce(out);
});
