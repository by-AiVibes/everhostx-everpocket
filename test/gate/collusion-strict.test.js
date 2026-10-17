'use strict';
// 2 of 5 colluders must not dequeue an op that never landed, and must not
// write COLLUDETX into agreed extend results. atMostOnce stays green when
// nothing lands; these asserts do not.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXT, NODES, landedPerOp } = require('./lib/sim/run');
const { scenExt } = require('./lib/sim-ext');
const { assertNoAborts } = require('./lib/assert-round');
const { requireDist } = require('./lib/env');
const { quorumExtendSite } = require('./lib/sites');

// 2 colluders report COLLUDETX at ledger 530. The pinned extend's
// LastLedgerSequence is the anchor window (10030). Completion must refuse
// that result: accepting it dequeues the op with nothing landed.
const COLLUDER_TX = {
    hash: 'COLLUDETX',
    lastLedgerSequence: 530,
    resultCode: 'tesSUCCESS',
};
const PINNED_EXTEND = {
    tenantAddress: 'rTenantSim',
    sequence: 5,
    lastLedgerSequence: 10030,
    fee: '5000',
    host: 'rH1',
    anchorLedger: 10000,
    nodePubkey: 'C',
    moments: 2,
    tokenId: 'tokC',
};

function colludeOperation() {
    return {
        type: 'extend_node',
        ref: 'C',
        data: { nodePubkey: 'C', moments: 2 },
        attempt: 0,
        nextAttemptLcl: 0,
    };
}

function assertColludeDoesNotComplete(site) {
    let quorumExtendCompletesOp;
    try {
        ({ quorumExtendCompletesOp } = requireDist('cluster/ExtendPinning'));
    }
    catch (error) {
        assert.fail(`${site}: quorumExtendCompletesOp missing (${error.code || error.message})`);
    }
    const operation = colludeOperation();
    const completed = quorumExtendCompletesOp({
        operations: [operation],
        anchorLedger: 10000,
        agreedTenantSequence: 5,
        agreedExtendResults: { C: COLLUDER_TX },
        pinnedExtendTxs: { C: PINNED_EXTEND },
    }, operation);
    assert.equal(
        completed,
        false,
        `op C dequeued without a landed tx at ${site}: quorumExtendCompletesOp accepted a 2-node COLLUDETX`
    );
}

const ROUNDS = 30;
const pending = scenExt('COLLUDE2-STRICT', {
    nodes: NODES,
    rounds: ROUNDS,
    ops: [EXT('C')],
    modes: (id) => (id === 'A' || id === 'B' ? 'collude' : 'ok'),
});

test('2/5 collude: op C stays queued unless a tx landed', async () => {
    const out = await pending;
    const site = quorumExtendSite();
    const landed = landedPerOp(out).C;
    const queued = out.opsLeft.some((op) => op.includes(':C#'));
    assert.ok(
        queued || landed === 1,
        `${out.name}: op C dequeued without a landed tx at ${site}: opsLeft=${JSON.stringify(out.opsLeft)} landed[C]=${landed}`
    );
});

test('quorumExtendCompletesOp refuses a 2-node COLLUDETX', () => {
    assertColludeDoesNotComplete(quorumExtendSite());
});

test('2/5 collude: agreed extend hash is not COLLUDETX', async () => {
    const out = await pending;
    const site = quorumExtendSite();
    const hash = out.agreedExtendResults && out.agreedExtendResults.C && out.agreedExtendResults.C.hash;
    assert.notEqual(hash, 'COLLUDETX', `${out.name}: ${site}: agreedExtendResults.C.hash !== 'COLLUDETX' (got ${hash})`);
});

test('2/5 collude: aborts == 0', async () => {
    assertNoAborts(await pending);
});
