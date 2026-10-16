const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    LLS_LEDGER_WINDOW,
    pickHostForOpRef,
    extendTxFields,
    buildLastLedgerSequence,
} = require('../../dist/cluster/DeterministicTx');

function frozen(overrides = {}) {
    return {
        lclSeqNo: 100,
        lclHash: 'abc',
        anchorLedger: 1_000_000,
        unl: [],
        cluster: { initialized: true, nodes: [], pendingNodes: [] },
        operations: [],
        acquireData: { acquiredNodes: [], pendingAcquires: [] },
        signerList: null,
        tenantSequence: 7,
        tenantAddress: 'rTenant',
        feeCeiling: '12000000',
        hostList: ['host.z', 'host.a'],
        ...overrides,
    };
}

describe('Phase 1 deterministic tx derivation', () => {
    it('uses snapshot sequence and fee ceiling', () => {
        const snap = frozen({ tenantSequence: 99, feeCeiling: '5000000' });
        const fields = extendTxFields(snap);
        assert.strictEqual(fields.sequence, 99);
        assert.strictEqual(fields.fee, '5000000');
    });

    it('sets LastLedgerSequence to anchor + constant window', () => {
        const anchor = 2_000_000;
        const snap = frozen({ anchorLedger: anchor });
        assert.strictEqual(buildLastLedgerSequence(anchor), anchor + LLS_LEDGER_WINDOW);
        assert.strictEqual(extendTxFields(snap).lastLedgerSequence, anchor + LLS_LEDGER_WINDOW);
    });

    it('picks host via hash(lclHash||opRef)', () => {
        const snap = frozen({ lclHash: 'roundhash', hostList: ['host.z', 'host.a'] });
        const h1 = pickHostForOpRef(snap, 'op-ref-1');
        const h2 = pickHostForOpRef(snap, 'op-ref-2');
        assert.ok(['host.z', 'host.a'].includes(h1));
        assert.ok(['host.z', 'host.a'].includes(h2));
        assert.strictEqual(pickHostForOpRef(snap, 'op-ref-1'), h1);
    });
});
