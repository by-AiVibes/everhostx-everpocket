'use strict';
// Below-quorum, stale, non-UNL or empty observation sets must be exact no-ops on agreed state.
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('./lib/env');
const unl = ['edA', 'edB', 'edC', 'edD', 'edE'];
const cp = { validatedIndex: 1010, ledgerHash: 'LH1010', tenantSequence: 6, signerListHash: 'S' };
const ob = (u, lcl = 100) => ({ userPublicKey: u, payload: Buffer.from(JSON.stringify({ type: 'anchor_observation', observedLcl: lcl, observedLclHash: 'h', nonce: lcl, ...cp, submittedTx: [{ ref: 'C', hash: 'T', lastLedgerSequence: 1030, resultCode: 'tesSUCCESS' }], checkpoints: [cp] })) });
function same(messages, currentLcl = 100) {
    const Obs = requireDist('cluster/AnchorObservation');
    const od = { operations: [{ type: 'extend_node', ref: 'C', data: { nodePubkey: 'C', moments: 2 }, attempt: 0, nextAttemptLcl: 0 }], anchorLedger: 1000, agreedTenantSequence: 5 };
    const agreed = o => JSON.stringify({ ...o, observationDedup: undefined }); // dedup bookkeeping is input-derived, identical on all nodes
    const before = agreed(od);
    Obs.applyObservationInputs({ operationData: od, contractUnl: unl, currentLcl, maxInputLedgerOffset: 10, messages });
    assert.equal(agreed(od), before);
}
test('quorumThreshold is ceil(2n/3)', () => { const Obs = requireDist('cluster/AnchorObservation'); for (const n of [1, 3, 4, 5, 7, 10]) assert.equal(Obs.quorumThreshold(n), Math.ceil(2 * n / 3)); });
test('empty input set is a no-op', () => same([]));
test('3 of 5 honest (below quorum 4) is a no-op', () => same(['edA', 'edB', 'edC'].map(u => ob(u))));
test('stale observations (beyond max_input_ledger_offset) are a no-op', () => same(unl.map(u => ob(u, 50)), 100));
test('non-UNL submitters are a no-op', () => same(['x1', 'x2', 'x3', 'x4', 'x5'].map(u => ob(u))));
test('quorum (4 of 5) does move state', () => {
    const Obs = requireDist('cluster/AnchorObservation');
    const od = { operations: [], anchorLedger: 1000, agreedTenantSequence: 5 };
    Obs.applyObservationInputs({ operationData: od, contractUnl: unl, currentLcl: 100, maxInputLedgerOffset: 10, messages: ['edA', 'edB', 'edC', 'edD'].map(u => ob(u)) });
    assert.equal(od.anchorLedger, 1010); assert.equal(od.agreedTenantSequence, 6);
});
