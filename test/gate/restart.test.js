'use strict';
// Every round is a fresh process (restart). A submitter that dies after submitting must not cause a resubmit that lands twice.
const test = require('node:test');
const { scen, EXT, NODES } = require('./lib/sim/run');
const S = require('./lib/assert-sim');
test('restart after submit (throwafter + crash, no observation): landed == 1', { timeout: 600000 }, async () => {
    const out = await scen('RESTART', { nodes: NODES, rounds: 40, ops: [EXT('C')], modes: (i, r) => r === 1 ? 'throwafter+crash' : 'ok' });
    S.noDivergence(out); S.allCompleteLandedOnce(out);
});
