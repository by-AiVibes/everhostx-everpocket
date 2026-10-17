'use strict';
// Deterministic born-expired pin: the anchor is already more than the
// 30-ledger LastLedgerSequence window behind validated when the op is pinned.
// The op must still finish inside the 100-round budget.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXT, NODES, landedPerOp } = require('./lib/sim/run');
const { scenExt, ANCHOR_LEDGER } = require('./lib/sim-ext');
const { assertNoAborts } = require('./lib/assert-round');
const { extendSubmitSite } = require('./lib/sites');

const LLS_WINDOW = 30;
const GAP_BEHIND_VALIDATED = LLS_WINDOW + 1;
const ROUNDS = 100;
const pending = scenExt('BORN-EXPIRED', {
    nodes: NODES,
    rounds: ROUNDS,
    ops: [EXT('C')],
    validatedStart: ANCHOR_LEDGER + GAP_BEHIND_VALIDATED,
});

test('pin born expired still lands once and completes within 100 rounds', { timeout: 900000 }, async () => {
    const out = await pending;
    const site = extendSubmitSite();
    const landed = landedPerOp(out).C;
    assert.equal(
        landed,
        1,
        `${site}: anchor ${ANCHOR_LEDGER} is ${GAP_BEHIND_VALIDATED} ledgers behind validated; landed[C] == 1, got ${landed}`
    );
    assert.deepEqual(out.opsLeft, [], `${site}: born-expired op never completed: ${JSON.stringify(out.opsLeft)}`);
});

test('pin born expired: aborts == 0', { timeout: 900000 }, async () => {
    assertNoAborts(await pending);
});
