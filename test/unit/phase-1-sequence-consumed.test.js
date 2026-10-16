const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { OperationType } = require('../../dist/models/cluster');
const { createWorkDir } = require('./test-workdir');
const {
    writeAcquiresFile,
    writeClusterFiles,
    buildClusterContext,
    defaultClusterNode,
    DEFAULT_ANCHOR,
    DEFAULT_TENANT_SEQUENCE,
} = require('./cluster-test-helpers');

const EXTEND_PUBKEY = 'restart_extend_pubkey';

describe('extend pin and local read gates', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-restart');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('pins extend tx on first attempt and reuses on retry', async () => {
        writeClusterFiles({
            nodes: [defaultClusterNode(EXTEND_PUBKEY)],
            operations: [{
                type: OperationType.EXTEND_NODE,
                ref: EXTEND_PUBKEY,
                data: { nodePubkey: EXTEND_PUBKEY, moments: 1 },
            }],
            anchorLedger: DEFAULT_ANCHOR,
            agreedTenantSequence: DEFAULT_TENANT_SEQUENCE,
        });
        const sequences = [];
        const ctx = buildClusterContext({
            extendSubmit: async (_h, _m, _n, options) => {
                sequences.push(options.txSubmitInfo.sequence);
                throw new Error('fail');
            },
            xrplContext: { getValidatedLedgerIndex: () => DEFAULT_ANCHOR + 30 },
        });
        await ctx.init();
        await ctx.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        const pin = ops.pinnedExtendTxs[EXTEND_PUBKEY];
        assert.ok(pin);
        assert.strictEqual(pin.sequence, DEFAULT_TENANT_SEQUENCE);
        assert.strictEqual(sequences.length, 1);
        assert.strictEqual(sequences[0], pin.sequence);

        const opAfter = JSON.parse(fs.readFileSync('operations.json', 'utf8')).operations[0];
        const retryLcl = opAfter.nextAttemptLcl;
        const ctx2 = buildClusterContext({
            extendSubmit: async (_h, _m, _n, options) => {
                sequences.push(options.txSubmitInfo.sequence);
                throw new Error('fail');
            },
            xrplContext: { getValidatedLedgerIndex: () => DEFAULT_ANCHOR + 30 },
        }, { lclSeqNo: retryLcl });
        await ctx2.init();
        await ctx2.deinit();
        const pin2 = JSON.parse(fs.readFileSync('operations.json', 'utf8')).pinnedExtendTxs[EXTEND_PUBKEY];
        assert.strictEqual(pin2.txHash, pin.txHash);
        assert.strictEqual(sequences[1], pin.sequence);
    });

    it('failed local sequence read skips submit without writing consumed state', async () => {
        writeClusterFiles({
            nodes: [defaultClusterNode(EXTEND_PUBKEY)],
            operations: [{
                type: OperationType.EXTEND_NODE,
                ref: EXTEND_PUBKEY,
                data: { nodePubkey: EXTEND_PUBKEY, moments: 1 },
            }],
            anchorLedger: DEFAULT_ANCHOR,
            agreedTenantSequence: DEFAULT_TENANT_SEQUENCE,
        });

        let extendCalls = 0;
        const ctx = buildClusterContext({
            extendSubmit: async () => {
                extendCalls++;
                return { hash: 'h', code: 'tesSUCCESS' };
            },
            xrplContext: {
                getAccountSequenceAtForObservation: async () => null,
                getValidatedLedgerIndex: () => DEFAULT_ANCHOR + 30,
            },
        });

        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(extendCalls, 0);
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.consumedTenantSequences, undefined);
        assert.ok(ops.pinnedExtendTxs[EXTEND_PUBKEY]);
    });
});
