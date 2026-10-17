'use strict';
// The seeded pin's LastLedgerSequence is already behind the anchor, while the
// pin's own anchor is still ahead of the round anchor. Only the
// lastLedgerSequence clause of shouldRepinPinnedExtend can refresh it.
// The op must still finish inside the 100-round budget.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EXT, NODES, landedPerOp } = require('./lib/sim/run');
const { scenExt, ANCHOR_LEDGER } = require('./lib/sim-ext');
const { assertNoAborts } = require('./lib/assert-round');
const { SRC } = require('./lib/env');

const ROUNDS = 100;
const STUCK_LLS = 9000;
const PIN_ANCHOR = 1000000;

function repinSite() {
    const rel = 'cluster/ExtendPinning.ts';
    const file = path.join(SRC, rel);
    if (!fs.existsSync(file))
        return 'cluster/ExtendPinning.ts:1';
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const index = lines.findIndex((line) => line.includes('function shouldRepinPinnedExtend') || line.includes('pin.lastLedgerSequence'));
    return `${rel}:${index >= 0 ? index + 1 : 1}`;
}

const pending = scenExt('BORN-EXPIRED', {
    nodes: NODES,
    rounds: ROUNDS,
    ops: [EXT('C')],
    validatedStart: ANCHOR_LEDGER,
    operationState: {
        agreedTenantSequence: 5,
        pinnedExtendTxs: {
            C: {
                tenantAddress: 'rTenantSim',
                sequence: 5,
                lastLedgerSequence: STUCK_LLS,
                fee: '5000',
                host: 'rH1',
                anchorLedger: PIN_ANCHOR,
                nodePubkey: 'C',
                moments: 2,
                tokenId: 'tokC',
            },
        },
    },
});

test('pin stuck behind its LastLedgerSequence still lands once within 100 rounds', async () => {
    const out = await pending;
    const site = repinSite();
    const landed = landedPerOp(out).C;
    assert.equal(
        landed,
        1,
        `${site}: anchor ${ANCHOR_LEDGER} is ahead of pinned LLS ${STUCK_LLS}; re-pin required; landed[C] == 1, got ${landed}`
    );
});

test('pin stuck behind its LastLedgerSequence is dequeued within 100 rounds', async () => {
    const out = await pending;
    const site = repinSite();
    assert.deepEqual(out.opsLeft, [], `${site}: born-expired op never completed: ${JSON.stringify(out.opsLeft)}`);
});

test('pin stuck behind its LastLedgerSequence: aborts == 0', async () => {
    assertNoAborts(await pending);
});
