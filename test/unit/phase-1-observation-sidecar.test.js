const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, buildClusterContext, defaultClusterNode, DEFAULT_ANCHOR, DEFAULT_TENANT_SEQUENCE, TENANT_ADDRESS } = require('./cluster-test-helpers');
const { buildAnchorObservationFromReader } = require('../../dist/observation/ObservationPayloadBuilder');
const { hashSignerList } = require('../../dist/observation/ObservationLedgerReads');
const { ledgerHashAt } = require('./shared-ledger-store');

describe('observation sidecar', () => {
    it('buildAnchorObservationFromReader uses real ledger and signer hashes (no placeholders)', async () => {
        const idx = 1_000_030;
        const signer = { signerQuorum: 1, signerList: [{ account: 'rA', weight: 1 }] };
        const reader = {
            getValidatedLedgerIndex: () => idx,
            getLedgerHashAt: async (i) => (i === idx ? ledgerHashAt(i) : null),
            getSignerListAt: async (i) => (i === idx ? signer : null),
            getAccountSequenceAt: async () => 42,
        };
        const payload = await buildAnchorObservationFromReader(reader, {
            observedLcl: 1,
            observedLclHash: 'h',
            nonce: 1,
            tenantAddress: TENANT_ADDRESS,
            submittedTx: [],
            checkpointInterval: 10,
            checkpointWindow: 1,
        });
        assert.ok(payload);
        assert.ok(!payload.ledgerHash.startsWith('local_'));
        assert.notStrictEqual(payload.signerListHash, 'local_signer_hash');
        assert.strictEqual(payload.signerListHash, hashSignerList(signer));
        assert.strictEqual(payload.ledgerHash, ledgerHashAt(idx));
    });

    it('throws when checkpoint interval or window missing in builder', async () => {
        const reader = {
            getValidatedLedgerIndex: () => 100,
            getLedgerHashAt: async () => 'h',
            getSignerListAt: async () => ({ signerQuorum: 1, signerList: [] }),
            getAccountSequenceAt: async () => 1,
        };
        await assert.rejects(
            () => buildAnchorObservationFromReader(reader, {
                observedLcl: 1,
                observedLclHash: 'h',
                nonce: 1,
                tenantAddress: TENANT_ADDRESS,
                submittedTx: [],
            }),
            /Missing checkpointInterval or checkpointWindow/,
        );
    });

    it('skips observation when ledger hash read fails', async () => {
        const reader = {
            getValidatedLedgerIndex: () => 100,
            getLedgerHashAt: async () => null,
            getSignerListAt: async () => ({ signerQuorum: 1, signerList: [] }),
            getAccountSequenceAt: async () => 1,
        };
        const payload = await buildAnchorObservationFromReader(reader, {
            observedLcl: 1,
            observedLclHash: 'h',
            nonce: 1,
            tenantAddress: TENANT_ADDRESS,
            submittedTx: [],
            checkpointInterval: 10,
            checkpointWindow: 1,
        });
        assert.strictEqual(payload, null);
    });

    it('hanging submitter does not block init', async () => {
        const tmp = createWorkDir('sidecar-hang');
        const cwd = process.cwd();
        process.chdir(tmp);
        writeAcquiresFile();
        writeClusterFiles({ nodes: [defaultClusterNode('pk')], operations: [] });
        const ctx = buildClusterContext({}, {
            getContractConfig: async () => ({
                unl: [],
                evernode: {
                    hosts: ['host.alpha'],
                    feeCeiling: '1',
                    anchorLedger: DEFAULT_ANCHOR,
                    tenantSequence: DEFAULT_TENANT_SEQUENCE,
                    checkpointInterval: 10,
                    checkpointWindow: 1,
                },
                consensus: { roundtime: 1000, stage_slice: 100 },
                max_input_ledger_offset: 32,
            }),
        });
        const evernode = ctx.evernodeContext;
        evernode.xrplContext.getLedgerHashAt = async () => ledgerHashAt(DEFAULT_ANCHOR);
        evernode.xrplContext.getSignerListAtForObservation = async () => ({ signerQuorum: 1, signerList: [{ account: 'rS', weight: 1 }] });
        evernode.xrplContext.getAccountSequenceAtForObservation = async () => DEFAULT_TENANT_SEQUENCE;
        evernode.xrplContext.getValidatedLedgerIndex = () => DEFAULT_ANCHOR;
        const start = Date.now();
        evernode.scheduleObservationSubmitOutOfBand([], {
            submitPayload: () => new Promise(() => {}),
        });
        await ctx.init();
        await ctx.deinit();
        assert.ok(Date.now() - start < 5000);
        process.chdir(cwd);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('pending submits in memory do not change state-dir hash across nodes', async () => {
        const tmpA = createWorkDir('node-a');
        const tmpB = createWorkDir('node-b');
        const cwd = process.cwd();
        const hashDir = (dir) => {
            process.chdir(dir);
            writeAcquiresFile();
            writeClusterFiles({ nodes: [defaultClusterNode('pk')], operations: [] });
            return crypto.createHash('sha256')
                .update(fs.readFileSync('operations.json'))
                .update(fs.readFileSync('cluster.json'))
                .update(fs.readFileSync('acquires.json'))
                .digest('hex');
        };
        process.chdir(tmpA);
        writeAcquiresFile();
        writeClusterFiles({ nodes: [defaultClusterNode('pk')], operations: [] });
        const ctxA = buildClusterContext();
        ctxA.evernodeContext.observationPendingSubmits?.push({
            ref: 'r1',
            hash: 'only_on_node_a',
            lastLedgerSequence: 1,
            resultCode: 'tesSUCCESS',
        });
        await ctxA.init();
        await ctxA.deinit();
        const hashA = hashDir(tmpA);

        process.chdir(tmpB);
        writeAcquiresFile();
        writeClusterFiles({ nodes: [defaultClusterNode('pk')], operations: [] });
        const ctxB = buildClusterContext();
        await ctxB.init();
        await ctxB.deinit();
        const hashB = hashDir(tmpB);

        assert.strictEqual(hashA, hashB);
        assert.ok(!fs.existsSync(path.join(tmpA, 'observation_pending_submits.json')));
        process.chdir(cwd);
        fs.rmSync(tmpA, { recursive: true, force: true });
        fs.rmSync(tmpB, { recursive: true, force: true });
    });
});
