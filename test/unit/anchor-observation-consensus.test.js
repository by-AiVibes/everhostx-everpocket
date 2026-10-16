const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const kp = require('ripple-keypairs');

const {
    aggregateAnchorFromObservations,
    applyObservationInputs,
    quorumThreshold,
    NODE_USER_REGISTER_MESSAGE_TYPE,
} = require('../../dist/cluster/AnchorObservation');
const { buildAnchorObservationPayload: buildPayload } = require('../../dist/observation/ObservationSubmitter');

function unlKey(i) {
    return `ed${(BigInt(i + 1)).toString(16).padStart(64, '0')}`;
}

function obs(unlPubkey, idx, hash, seq = 42, signerHash = 'signer_hash_a', nonce = 1, lcl = 100) {
    return {
        unlPubkey,
        userPubkey: unlPubkey,
        observedLcl: lcl,
        nonce,
        validatedIndex: idx,
        ledgerHash: hash,
        tenantSequence: seq,
        signerListHash: signerHash,
        submittedTx: [],
    };
}

describe('anchor observation consensus', () => {
    it('quorumThreshold is ceil(2/3 * UNL)', () => {
        assert.strictEqual(quorumThreshold(5), 4);
        assert.strictEqual(quorumThreshold(3), 2);
    });

    it('lying minority (1 of 5) cannot move anchor', () => {
        const unl = [0, 1, 2, 3, 4].map(unlKey);
        const goodHash = 'good_ledger_hash';
        const observations = unl.map((pk, i) => obs(pk, 1_000_050, i === 0 ? 'fake_hash' : goodHash));
        const result = aggregateAnchorFromObservations(observations, unl);
        assert.ok(result);
        assert.strictEqual(result.anchorLedger, 1_000_050);
        assert.strictEqual(result.ledgerHash, goodHash);
    });

    it('quorum miss does not advance anchor in applyObservationInputs', () => {
        const unl = [0, 1, 2, 3, 4].map(unlKey);
        const operationData = { operations: [], anchorLedger: 1_000_000 };
        const hash = 'ledger_ok';
        const messages = unl.slice(0, 3).map((pk, i) => ({
            userPublicKey: pk,
            payload: Buffer.from(JSON.stringify(buildPayload({
                observedLcl: 200,
                observedLclHash: 'lclhash',
                nonce: 1,
                validatedIndex: 1_000_100,
                ledgerHash: hash,
                tenantSequence: 42,
                signerListHash: 'sighash',
                submittedTx: [],
            }))),
        }));
        applyObservationInputs({
            operationData,
            contractUnl: unl,
            currentLcl: 200,
            maxInputLedgerOffset: 10,
            messages,
        });
        assert.strictEqual(operationData.anchorLedger, 1_000_000);
    });

    it('replayed or stale observations are ignored', () => {
        const unl = [0, 1, 2, 3, 4].map(unlKey);
        const operationData = {
            operations: [],
            anchorLedger: 1_000_000,
            observationDedup: { [unl[0]]: { nonce: 5, observedLcl: 150 } },
        };
        const payload = buildPayload({
            observedLcl: 140,
            observedLclHash: 'h',
            nonce: 4,
            validatedIndex: 1_000_200,
            ledgerHash: 'h2',
            tenantSequence: 1,
            signerListHash: 's',
            submittedTx: [],
        });
        applyObservationInputs({
            operationData,
            contractUnl: unl,
            currentLcl: 200,
            maxInputLedgerOffset: 10,
            messages: [{ userPublicKey: unl[0], payload: Buffer.from(JSON.stringify(payload)) }],
        });
        assert.strictEqual(operationData.anchorLedger, 1_000_000);
    });

    it('non-UNL submitter is ignored', () => {
        const unl = [0, 1, 2, 3, 4].map(unlKey);
        const outsider = unlKey(99);
        const operationData = { operations: [], anchorLedger: 1_000_000 };
        const payload = buildPayload({
            observedLcl: 200,
            observedLclHash: 'h',
            nonce: 1,
            validatedIndex: 9_999_999,
            ledgerHash: 'evil',
            tenantSequence: 1,
            signerListHash: 's',
            submittedTx: [],
        });
        applyObservationInputs({
            operationData,
            contractUnl: unl,
            currentLcl: 200,
            maxInputLedgerOffset: 10,
            messages: [{ userPublicKey: outsider, payload: Buffer.from(JSON.stringify(payload)) }],
        });
        assert.strictEqual(operationData.anchorLedger, 1_000_000);
    });

    it('quorum advances anchor and merges agreed extend results', () => {
        const unl = [0, 1, 2, 3, 4].map(unlKey);
        const operationData = { operations: [], anchorLedger: 1_000_000 };
        const hash = 'ledger_ok';
        const txHash = crypto.createHash('sha256').update('extend').digest('hex');
        const messages = unl.map((pk, i) => ({
            userPublicKey: pk,
            payload: Buffer.from(JSON.stringify(buildPayload({
                observedLcl: 200 + i,
                observedLclHash: 'lclhash',
                nonce: 1,
                validatedIndex: 1_000_100,
                ledgerHash: hash,
                tenantSequence: 55,
                signerListHash: 'sighash',
                submittedTx: [{
                    ref: 'extend_ref',
                    hash: txHash,
                    lastLedgerSequence: 1_000_130,
                    resultCode: 'tesSUCCESS',
                }],
            }))),
        }));
        applyObservationInputs({
            operationData,
            contractUnl: unl,
            currentLcl: 210,
            maxInputLedgerOffset: 20,
            messages,
        });
        assert.strictEqual(operationData.anchorLedger, 1_000_100);
        assert.strictEqual(operationData.agreedTenantSequence, 55);
        assert.strictEqual(operationData.agreedExtendResults.extend_ref.hash, txHash);
    });

    it('node user registration maps CSPRNG user key to UNL', () => {
        const unlKeys = kp.deriveKeypair(kp.generateSeed({ algorithm: 'ed25519' }));
        const userKeys = kp.deriveKeypair(kp.generateSeed({ algorithm: 'ed25519' }));
        const canon = JSON.stringify({ unlPubkey: unlKeys.publicKey, userPubkey: userKeys.publicKey });
        const sig = kp.sign(Buffer.from(canon).toString('hex'), unlKeys.privateKey);
        const operationData = { operations: [], anchorLedger: 1_000_000 };
        applyObservationInputs({
            operationData,
            contractUnl: [unlKeys.publicKey],
            currentLcl: 50,
            maxInputLedgerOffset: 10,
            messages: [{
                userPublicKey: userKeys.publicKey,
                payload: Buffer.from(JSON.stringify({
                    type: NODE_USER_REGISTER_MESSAGE_TYPE,
                    unlPubkey: unlKeys.publicKey,
                    userPubkey: userKeys.publicKey,
                    signature: sig,
                })),
            }],
        });
        assert.strictEqual(operationData.nodeUserRegistrations[userKeys.publicKey], unlKeys.publicKey);
    });
});
