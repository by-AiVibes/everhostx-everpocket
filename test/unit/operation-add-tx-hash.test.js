const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { OperationType } = require('../../dist/models/cluster');
const { createWorkDir } = require('./test-workdir');
const {
    writeAcquiresFile,
    writeClusterFiles,
    buildClusterContext,
    createAcquireTxHarness,
} = require('./cluster-test-helpers');

const ADD_REF = 'add_op_queue_ref_hosthash';

describe('ADD acquire refId (tx hash) vs opRef', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-add-tx-hash');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('performs exactly one acquire across many LCL rounds until pending opRef is agreed', async () => {
        const harness = createAcquireTxHarness();
        const { deriveMessagePublicKey } = require('../../dist/cluster/DeterministicTx');
        const messagePublicKey = deriveMessagePublicKey({
            anchorLedger: 1_000_000,
            tenantSequence: 1,
            lclSeqNo: 500,
        }, ADD_REF);
        writeClusterFiles({
            nodes: [],
            pendingNodes: [],
            operations: [{
                type: OperationType.ADD_NODE,
                ref: ADD_REF,
                data: { acquireOptions: {}, lifeMoments: 1, messagePublicKey },
            }],
        });

        let acquireCalls = 0;
        const ctxFactory = (lcl) => buildClusterContext({
            ...harness.evernodeOverrides,
            acquireNodeFromSnapshot: async (snap, opRef) => {
                acquireCalls++;
                return harness.evernodeOverrides.acquireNodeFromSnapshot(snap, opRef);
            },
        }, { lclSeqNo: lcl, lclHash: 'hash' });

        let lcl = 500;
        const ctx = ctxFactory(lcl);
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(acquireCalls, 1);

        lcl += 4;
        ctx.hpContext.lclSeqNo = lcl;
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(acquireCalls, 1);

        const clusterAfter = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
        assert.strictEqual(clusterAfter.pendingNodes.length, 1);
        assert.strictEqual(clusterAfter.pendingNodes[0].opRef, ADD_REF);
        const txRef = clusterAfter.pendingNodes[0].refId;
        assert.ok(txRef.startsWith('0xacquire_tx_'));

        let ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);

        const acquires = JSON.parse(fs.readFileSync('acquires.json', 'utf8'));
        assert.ok(acquires.pendingAcquires.some((p) => p.opRef === ADD_REF));
    });
});
