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
} = require('./cluster-test-helpers');

const EXTEND_A = 'extend_a_pubkey';
const EXTEND_B = 'extend_b_pubkey';

describe('extend pinning and single in-flight', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-pin');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('does not start second extend while first is in flight', async () => {
        writeClusterFiles({
            nodes: [defaultClusterNode(EXTEND_A), defaultClusterNode(EXTEND_B)],
            operations: [
                { type: OperationType.EXTEND_NODE, ref: EXTEND_A, data: { nodePubkey: EXTEND_A, moments: 1 } },
                { type: OperationType.EXTEND_NODE, ref: EXTEND_B, data: { nodePubkey: EXTEND_B, moments: 1 } },
            ],
            anchorLedger: DEFAULT_ANCHOR,
        });
        const refs = [];
        const ctx = buildClusterContext({
            extendSubmit: async (_h, _m, _n, options) => {
                refs.push(options.extendOpRef);
                throw new Error('fail');
            },
            xrplContext: { getValidatedLedgerIndex: () => DEFAULT_ANCHOR + 30 },
        });
        await ctx.init();
        await ctx.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.ok(ops.pinnedExtendTxs[EXTEND_A]);
        assert.strictEqual(ops.pinnedExtendTxs[EXTEND_B], undefined);
        assert.deepStrictEqual(refs, [EXTEND_A]);
    });
});
