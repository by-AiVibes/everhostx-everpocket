const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { OperationType } = require('../../dist/models/cluster');
const { syncConsumedTenantSequenceFromQuorum } = require('../../dist/cluster/DeterministicTx');
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

describe('sequence consumed (quorum vs local read)', () => {
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

    it('marks snapshot sequence consumed when agreedTenantSequence advanced past snapshot', () => {
        const operationData = { agreedTenantSequence: DEFAULT_TENANT_SEQUENCE + 1 };
        const snapshot = { tenantSequence: DEFAULT_TENANT_SEQUENCE };
        assert.strictEqual(syncConsumedTenantSequenceFromQuorum(operationData, snapshot), true);
        assert.ok(operationData.consumedTenantSequences.includes(DEFAULT_TENANT_SEQUENCE));
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
    });
});
