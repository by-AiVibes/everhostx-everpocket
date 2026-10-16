'use strict';
// A single lying UNL node must not move agreed state.
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('./lib/env');
const { scen, EXT, NODES } = require('./lib/sim/run');
const S = require('./lib/assert-sim');
const unl = ['edA', 'edB', 'edC', 'edD', 'edE'];
const cp = (i, h = 'FAKE' + i, seq = 99) => ({ validatedIndex: i, ledgerHash: h, tenantSequence: seq, signerListHash: 'S' });
const ob = (u, cps, tx = [], nonce) => ({ userPublicKey: u, payload: Buffer.from(JSON.stringify({ type: 'anchor_observation', observedLcl: 100, observedLclHash: 'h', nonce: nonce ?? 100 + cps.length, ...cps[0], submittedTx: tx, checkpoints: cps })) });
function apply(messages, extra = {}) {
    const Obs = requireDist('cluster/AnchorObservation');
    const od = { operations: [], anchorLedger: 1000, agreedTenantSequence: 5, ...extra };
    Obs.applyObservationInputs({ operationData: od, contractUnl: unl, currentLcl: 100, maxInputLedgerOffset: 10, messages });
    return od;
}
const unmoved = od => { assert.equal(od.anchorLedger, 1000); assert.equal(od.agreedTenantSequence, 5); assert.deepEqual(od.agreedExtendResults || {}, {}); };
test('liar with 4 duplicate checkpoints', () => { const c = cp(2000); unmoved(apply([ob('edA', [c, c, c, c], [{ ref: 'C', hash: 'FAKETX', lastLedgerSequence: 2030, resultCode: 'tesSUCCESS' }])])); });
test('liar with distinct fake indexes', () => unmoved(apply([ob('edA', [cp(2000), cp(2010), cp(2020), cp(2030)])])));
test('liar double observation in one round', () => unmoved(apply([ob('edA', [cp(2000)], [], 1), ob('edA', [cp(2000)], [], 2)])));
test('liar with multiple registered user keys', () => unmoved(apply(['edA', 'edA2', 'edA3', 'edA4'].map(u => ob(u, [cp(2000)])), { nodeUserRegistrations: { edA2: 'edA', edA3: 'edA', edA4: 'edA' } })));
test('liar fake extend result loses to 4 honest', () => {
    const H = cp(1010, 'LH1010', 6);
    const od = apply([ob('edA', [H], [{ ref: 'C', hash: 'FAKETX', lastLedgerSequence: 1030, resultCode: 'tesSUCCESS' }]),
        ...['edB', 'edC', 'edD', 'edE'].map(u => ob(u, [H], [{ ref: 'C', hash: 'REAL', lastLedgerSequence: 1030, resultCode: 'tesSUCCESS' }]))]);
    assert.equal(od.agreedExtendResults?.C?.hash, 'REAL');
});
test('sim: 1/5 fake hash and 1/5 fake index keep liveness and agreement', { timeout: 600000 }, async () => {
    for (const m of ['liehash', 'lieidx']) {
        const out = await scen('LIAR-' + m, { nodes: NODES, rounds: 40, ops: [EXT('C')], modes: i => i === 'A' ? m : 'ok' });
        S.noDivergence(out); S.allCompleteLandedOnce(out);
    }
});
