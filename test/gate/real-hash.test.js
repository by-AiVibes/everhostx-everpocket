'use strict';
// Ledger hashes are hashes of the signed blob (real-format 64-hex), never a canonical-JSON hash.
// Every op must still complete exactly once.
const test = require('node:test');
const { scen, EXT, NODES } = require('./lib/sim/run');
const S = require('./lib/assert-sim');
test('real-format signed hashes: every op completes, landed == 1', { timeout: 600000 }, async () => {
    const out = await scen('REALHASH', { nodes: NODES, rounds: 40, ops: [EXT('C'), EXT('D')] });
    S.noDivergence(out); S.allCompleteLandedOnce(out);
});
