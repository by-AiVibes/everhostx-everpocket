const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    LLS_LEDGER_WINDOW,
    pickHostForOpRef,
    extendTxFields,
    buildLastLedgerSequence,
    computeExtendTxHash,
} = require('../../dist/cluster/DeterministicTx');
const { OperationType } = require('../../dist/models/cluster');

const ANCHOR = 1_000_000;
const FEE = '12000000';
const SEQUENCE = 42;

function frozen(overrides = {}) {
    return {
        lclSeqNo: 100,
        lclHash: 'abc',
        anchorLedger: ANCHOR,
        unl: [],
        cluster: {
            initialized: true,
            nodes: [{
                pubkey: 'pk1',
                name: 'lease-token-idx',
                lifeMoments: 1,
                targetLifeMoments: 2,
            }],
            pendingNodes: [],
        },
        operations: [],
        acquireData: { acquiredNodes: [], pendingAcquires: [] },
        signerList: null,
        tenantSequence: SEQUENCE,
        tenantAddress: 'rTenant',
        feeCeiling: FEE,
        hostList: ['host.z', 'host.a'],
        ...overrides,
    };
}

describe('Phase 1 deterministic tx derivation', () => {
    it('uses snapshot sequence and fee ceiling literals', () => {
        const snap = frozen();
        const fields = extendTxFields(snap);
        assert.strictEqual(fields.sequence, SEQUENCE);
        assert.strictEqual(fields.fee, FEE);
        assert.strictEqual(fields.lastLedgerSequence, ANCHOR + 30);
        assert.strictEqual(LLS_LEDGER_WINDOW, 30);
        assert.strictEqual(buildLastLedgerSequence(ANCHOR), 1_000_030);
    });

    it('picks host via hash(lclHash||opRef) with stable choice', () => {
        const snap = frozen({ lclHash: 'roundhash', hostList: ['host.z', 'host.a'] });
        const h1 = pickHostForOpRef(snap, 'op-ref-1');
        assert.ok(h1 === 'host.z' || h1 === 'host.a');
        assert.strictEqual(pickHostForOpRef(snap, 'op-ref-1'), h1);
    });

    it('computes stable extend tx hash from canonical fields', () => {
        const snap = frozen();
        const op = {
            type: OperationType.EXTEND_NODE,
            ref: 'pk1',
            data: { nodePubkey: 'pk1', moments: 3 },
        };
        const h1 = computeExtendTxHash(snap, op);
        const h2 = computeExtendTxHash(snap, op);
        assert.match(h1, /^0x[0-9a-f]{64}$/);
        assert.strictEqual(h1, h2);
    });
});
