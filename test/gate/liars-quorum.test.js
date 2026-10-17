'use strict';
// A liar paired with 4 honest observers must lose. applyObservationInputs as a
// no-op leaves the anchor where it started. Three honest observations plus a
// duplicate of one of them stay below quorum.
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireDist } = require('./lib/env');
const { applyObservationSite } = require('./lib/sites');

const UNL = ['edA', 'edB', 'edC', 'edD', 'edE'];
const HONEST = { validatedIndex: 1010, ledgerHash: 'LH1010', tenantSequence: 6, signerListHash: 'S' };
const HONEST_TX = [{ ref: 'C', hash: 'REAL', lastLedgerSequence: 1030, resultCode: 'tesSUCCESS' }];
const START_ANCHOR = 1000;
const START_SEQUENCE = 5;

function checkpoint(index, hash = `FAKE${index}`, sequence = 99) {
    return { validatedIndex: index, ledgerHash: hash, tenantSequence: sequence, signerListHash: 'S' };
}

function observation(user, checkpoints, txs = [], nonce) {
    return {
        userPublicKey: user,
        payload: Buffer.from(JSON.stringify({
            type: 'anchor_observation',
            observedLcl: 100,
            observedLclHash: 'h',
            nonce: nonce ?? 100 + checkpoints.length,
            ...checkpoints[0],
            submittedTx: txs,
            checkpoints,
        })),
    };
}

function honest(user, nonce) {
    return observation(user, [HONEST], HONEST_TX, nonce);
}

function loadObservation() {
    const site = applyObservationSite();
    try {
        return requireDist('cluster/AnchorObservation');
    }
    catch (error) {
        assert.fail(`${site}: applyObservationInputs missing (${error.code || error.message})`);
    }
}

function apply(messages, extra = {}) {
    const Obs = loadObservation();
    const site = applyObservationSite();
    assert.equal(typeof Obs.applyObservationInputs, 'function', `${site}: applyObservationInputs missing`);
    const operationData = {
        operations: [],
        anchorLedger: START_ANCHOR,
        agreedTenantSequence: START_SEQUENCE,
        ...extra,
    };
    Obs.applyObservationInputs({
        operationData,
        contractUnl: UNL,
        currentLcl: 100,
        maxInputLedgerOffset: 10,
        messages,
    });
    return { operationData, site };
}

function movedToHonest(operationData, site, label) {
    assert.equal(operationData.anchorLedger, HONEST.validatedIndex, `${site}: ${label}: anchor did not move to the honest checkpoint (got ${operationData.anchorLedger})`);
    assert.equal(operationData.agreedTenantSequence, HONEST.tenantSequence, `${site}: ${label}: tenant sequence did not move to the honest value (got ${operationData.agreedTenantSequence})`);
    assert.equal(operationData.agreedExtendResults && operationData.agreedExtendResults.C && operationData.agreedExtendResults.C.hash, 'REAL', `${site}: ${label}: extend result did not move to the honest hash`);
}

test('liar duplicate checkpoints lose to 4 honest observers', () => {
    const liar = observation('edA', [checkpoint(2000), checkpoint(2000), checkpoint(2000), checkpoint(2000)], [{ ref: 'C', hash: 'FAKETX', lastLedgerSequence: 2030, resultCode: 'tesSUCCESS' }]);
    const { operationData, site } = apply([liar, ...['edB', 'edC', 'edD', 'edE'].map((user, index) => honest(user, 20 + index))]);
    movedToHonest(operationData, site, 'duplicate checkpoints');
});

test('liar distinct fake indexes lose to 4 honest observers', () => {
    const liar = observation('edA', [checkpoint(2000), checkpoint(2010), checkpoint(2020), checkpoint(2030)]);
    const { operationData, site } = apply([liar, ...['edB', 'edC', 'edD', 'edE'].map((user, index) => honest(user, 30 + index))]);
    movedToHonest(operationData, site, 'distinct fake indexes');
});

test('liar double observation loses to 4 honest observers', () => {
    const liarA = observation('edA', [checkpoint(2000)], [], 1);
    const liarB = observation('edA', [checkpoint(2000)], [], 2);
    const { operationData, site } = apply([liarA, liarB, ...['edB', 'edC', 'edD', 'edE'].map((user, index) => honest(user, 40 + index))]);
    movedToHonest(operationData, site, 'double observation');
});

test('liar with multiple registered user keys loses to 4 honest observers', () => {
    const liars = ['edA', 'edA2', 'edA3', 'edA4'].map((user, index) => observation(user, [checkpoint(2000)], [], 10 + index));
    const { operationData, site } = apply(
        [...liars, ...['edB', 'edC', 'edD', 'edE'].map((user, index) => honest(user, 50 + index))],
        { nodeUserRegistrations: { edA2: 'edA', edA3: 'edA', edA4: 'edA' } }
    );
    movedToHonest(operationData, site, 'registered user keys');
});

test('3 honest plus one duplicated honest node is a no-op', () => {
    const { operationData, site } = apply([
        honest('edA', 1),
        honest('edB', 2),
        honest('edC', 3),
        honest('edA', 4),
    ]);
    assert.equal(operationData.anchorLedger, START_ANCHOR, `${site}: 3 honest + 1 duplicated honest must stay a no-op, anchor moved to ${operationData.anchorLedger}`);
    assert.equal(operationData.agreedTenantSequence, START_SEQUENCE, `${site}: 3 honest + 1 duplicated honest must stay a no-op, sequence moved to ${operationData.agreedTenantSequence}`);
    assert.deepEqual(operationData.agreedExtendResults || {}, {}, `${site}: 3 honest + 1 duplicated honest must stay a no-op`);
});
