const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const {
    aggregateAnchorFromObservations,
    applyObservationInputs,
    acceptObservationDedup,
    isObservationStale,
    verifyNodeUserRegistration,
    quorumThreshold,
} = require('../../dist/cluster/AnchorObservation');
const { requireMaxInputLedgerOffset } = require('../../dist/cluster/QueueConfig');
const { pickHostForOpRef } = require('../../dist/cluster/DeterministicTx');
const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, buildClusterContext, defaultClusterNode } = require('./cluster-test-helpers');
const { unlPubkey } = require('./consensus-input-helpers');

function obs(pk, idx, hash, nonce = 1) {
    return {
        unlPubkey: pk,
        userPubkey: pk,
        observedLcl: 100,
        nonce,
        validatedIndex: idx,
        ledgerHash: hash,
        tenantSequence: 42,
        signerListHash: 's',
        submittedTx: [],
    };
}

describe('consensus mutation guards', () => {
    it('requireMaxInputLedgerOffset throws when missing', () => {
        assert.throws(() => requireMaxInputLedgerOffset({}), /Missing max_input_ledger_offset/);
    });

    it('non-UNL inputs are ignored without affecting quorum', () => {
        const unl = [0, 1, 2, 3, 4].map(unlPubkey);
        const operationData = { operations: [], anchorLedger: 1_000_000, agreedTenantSequence: 42 };
        const outsider = unlPubkey(99);
        applyObservationInputs({
            operationData,
            contractUnl: unl,
            currentLcl: 200,
            maxInputLedgerOffset: 32,
            messages: [{
                userPublicKey: outsider,
                payload: Buffer.from(JSON.stringify({
                    type: 'anchor_observation',
                    observedLcl: 200,
                    observedLclHash: 'h',
                    nonce: 1,
                    validatedIndex: 9_999_999,
                    ledgerHash: 'evil',
                    tenantSequence: 1,
                    signerListHash: 's',
                    submittedTx: [],
                })),
            }],
        });
        assert.strictEqual(operationData.anchorLedger, 1_000_000);
    });

    it('dedupe rejects replayed nonce', () => {
        const operationData = { operations: [], observationDedup: { a: { nonce: 5, observedLcl: 100 } } };
        assert.strictEqual(acceptObservationDedup(operationData, 'a', 100, 4), false);
    });

    it('staleness rejects old observedLcl', () => {
        assert.strictEqual(isObservationStale(80, 100, 10), true);
        assert.strictEqual(isObservationStale(95, 100, 10), false);
    });

    it('unsigned registration is rejected', () => {
        assert.strictEqual(verifyNodeUserRegistration({
            type: 'node_user_register',
            unlPubkey: unlPubkey(0),
            userPubkey: unlPubkey(1),
            signature: '00',
        }), false);
    });

    it('quorum threshold uses ceil(2/3 * n) with >=', () => {
        assert.strictEqual(quorumThreshold(5), 4);
        const unl = [0, 1, 2, 3, 4].map(unlPubkey);
        const hash = 'good';
        const three = unl.slice(0, 3).map((pk) => obs(pk, 1_000_050, hash));
        assert.strictEqual(aggregateAnchorFromObservations(three, unl), null);
        const four = unl.slice(0, 4).map((pk) => obs(pk, 1_000_050, hash));
        assert.ok(aggregateAnchorFromObservations(four, unl));
    });

    it('host pick uses agreed host list and opRef (not cluster node host field)', () => {
        const snap = {
            lclHash: 'deadbeef',
            hostList: ['host.alpha', 'host.beta'],
            cluster: { nodes: [{ host: 'wrong.host', pubkey: 'p' }], pendingNodes: [], initialized: true },
        };
        const h1 = pickHostForOpRef(snap, 'ref_a');
        const h2 = pickHostForOpRef({ ...snap, cluster: { nodes: [{ host: 'other', pubkey: 'p' }], pendingNodes: [], initialized: true } }, 'ref_a');
        assert.strictEqual(h1, h2);
        assert.ok(['host.alpha', 'host.beta'].includes(h1));
    });

    it('ingest buffers until flushConsensusInputsForRound (single message cannot advance anchor)', async () => {
        const tmp = createWorkDir('buf');
        const cwd = process.cwd();
        process.chdir(tmp);
        writeAcquiresFile();
        writeClusterFiles({
            nodes: [defaultClusterNode('pk')],
            operations: [],
        });
        const unl = [0, 1, 2, 3, 4].map(unlPubkey);
        const ctx = buildClusterContext({}, {
            getContractConfig: async () => ({
                unl,
                evernode: { hosts: ['host.alpha'], feeCeiling: '1', anchorLedger: 1_000_000, tenantSequence: 42 },
                consensus: { roundtime: 1000, stage_slice: 100 },
                max_input_ledger_offset: 32,
            }),
        });
        const { buildAnchorObservationPayload } = require('../../dist/observation/ObservationSubmitter');
        const payload = Buffer.from(JSON.stringify(buildAnchorObservationPayload({
            observedLcl: 100,
            observedLclHash: 'h',
            nonce: 1,
            validatedIndex: 1_000_100,
            ledgerHash: 'ledger-1000100',
            tenantSequence: 42,
            signerListHash: 's',
            submittedTx: [],
        })));
        await ctx.ingestUserInput({ publicKey: unl[0], send: async () => {} }, payload);
        let ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.anchorLedger, 1_000_000);
        await ctx.flushConsensusInputsForRound();
        ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.anchorLedger, 1_000_000);
        process.chdir(cwd);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('abort round does not persist observation buffer mutations', async () => {
        const tmp = createWorkDir('abort');
        const cwd = process.cwd();
        process.chdir(tmp);
        writeAcquiresFile();
        writeClusterFiles({ nodes: [], operations: [], anchorLedger: 0 });
        const ctx = buildClusterContext({}, {
            getContractConfig: async () => ({
                unl: [],
                evernode: { hosts: ['host.alpha'], feeCeiling: '1' },
                consensus: { roundtime: 1000, stage_slice: 100 },
                max_input_ledger_offset: 32,
            }),
        });
        await ctx.ingestUserInput({ publicKey: unlPubkey(0), send: async () => {} }, Buffer.from('{"type":"anchor_observation"}'));
        await ctx.init();
        assert.strictEqual(ctx.isRoundAborted(), true);
        await ctx.deinit();
        const raw = fs.readFileSync('operations.json', 'utf8');
        assert.ok(!raw.includes('agreedLedgerHash'));
        process.chdir(cwd);
        fs.rmSync(tmp, { recursive: true, force: true });
    });
});
