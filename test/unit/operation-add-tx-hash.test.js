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
        writeClusterFiles({
            nodes: [],
            pendingNodes: [],
            operations: [{
                type: OperationType.ADD_NODE,
                ref: ADD_REF,
                data: { acquireOptions: {}, lifeMoments: 1 },
            }],
        });

        let acquireCalls = 0;
        const ctxFactory = (lcl) => buildClusterContext({
            ...harness.evernodeOverrides,
            acquireNode: async (opts) => {
                acquireCalls++;
                return harness.evernodeOverrides.acquireNode(opts);
            },
        }, { lclSeqNo: lcl, checkLiveness: async () => true });

        let lcl = 500;
        let ctx = ctxFactory(lcl);
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(acquireCalls, 1);

        const clusterAfter = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
        assert.strictEqual(clusterAfter.pendingNodes.length, 1);
        assert.strictEqual(clusterAfter.pendingNodes[0].opRef, ADD_REF);
        const txRef = clusterAfter.pendingNodes[0].refId;
        assert.ok(txRef.startsWith('0xacquire_tx_'));

        lcl += 4;
        ctx = ctxFactory(lcl);
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(acquireCalls, 1);
        let ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 0);

        for (let round = 0; round < 6; round++) {
            lcl += 4;
            harness.markAcquired(txRef, {
                domain: 'node.example',
                userPort: 1,
                peerPort: 2,
                contractId: 'cid',
                pubkey: 'pending_pubkey_stable',
                name: 'n',
                outboundIp: '1.2.3.4',
            });
            ctx = ctxFactory(lcl);
            await ctx.init();
            await ctx.deinit();
            assert.strictEqual(acquireCalls, 1);
        }

        ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 0);
    });
});
