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
    TENANT_ADDRESS,
} = require('./cluster-test-helpers');

const EXTEND_PUBKEY = 'restart_extend_pubkey';

describe('sequence consumed on ledger (node restart)', () => {
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

    it('does not resubmit EXTEND when on-ledger sequence already advanced past snapshot', async () => {
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
                return { hash: 'should_not_run', code: 'tesSUCCESS' };
            },
            xrplContext: {
                getAccountSequenceAtForObservation: async (_acc, _idx) => DEFAULT_TENANT_SEQUENCE + 1,
                getValidatedLedgerIndex: () => DEFAULT_ANCHOR + 30,
            },
        });

        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(extendCalls, 0);
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.ok(ops.consumedTenantSequences?.includes(DEFAULT_TENANT_SEQUENCE));
    });
});
