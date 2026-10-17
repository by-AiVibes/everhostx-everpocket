'use strict';
// Persistent partial submit: D and E always fail before submit. One extend
// must land once and leave the queue. An unbounded resubmit shows up as
// landed[C] > 1.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scen, EXT, NODES, landedPerOp } = require('./lib/sim/run');
const { assertNoAborts } = require('./lib/assert-round');
const { extendSubmitSite } = require('./lib/sites');

const ROUNDS = 30;
const pending = scen('twoExtfail', {
    nodes: NODES,
    rounds: ROUNDS,
    ops: [EXT('C')],
    modes: (id) => (id === 'D' || id === 'E' ? 'extfail' : 'ok'),
});

test('twoExtfail: D and E extfail, landed[C] == 1', async () => {
    const out = await pending;
    const site = extendSubmitSite();
    const landed = landedPerOp(out).C;
    assert.equal(landed, 1, `${site}: twoExtfail landed[C] == 1, got ${landed}; opsLeft=${JSON.stringify(out.opsLeft)}`);
});

test('twoExtfail: C is dequeued', async () => {
    const out = await pending;
    const site = extendSubmitSite();
    const queued = out.opsLeft.some((op) => op.includes(':C#'));
    assert.equal(queued, false, `${site}: twoExtfail expected C dequeued, opsLeft=${JSON.stringify(out.opsLeft)}`);
});

test('twoExtfail: aborts == 0', async () => {
    assertNoAborts(await pending);
});
