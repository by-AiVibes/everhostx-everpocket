const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { OperationType } = require('../../dist/models/cluster');
const { createWorkDir } = require('./test-workdir');
const {
    writeAcquiresFile,
    writeClusterFiles,
    defaultClusterNode,
    buildClusterContext,
} = require('./cluster-test-helpers');

const FIRST_REMOVE_PUBKEY = 'first_remove_in_queue_pubkey';
const SECOND_REMOVE_PUBKEY = 'second_remove_in_queue_pubkey';

describe('Operation queue order (FIFO among ready ops)', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-queue-order');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('runs ADD before a later ready REMOVE (no aliveness deferral)', async () => {
        let acquireCalls = 0;
        writeClusterFiles({
            nodes: [defaultClusterNode(SECOND_REMOVE_PUBKEY)],
            pendingNodes: [],
            operations: [
                {
                    type: OperationType.ADD_NODE,
                    ref: 'add_first_in_queue',
                    data: { acquireOptions: {}, lifeMoments: 1, maxLifeMoments: 0 },
                },
                {
                    type: OperationType.REMOVE_NODE,
                    ref: SECOND_REMOVE_PUBKEY,
                    data: { nodePubkey: SECOND_REMOVE_PUBKEY, force: true },
                },
            ],
        });

        const ctx = buildClusterContext({
            acquireNode: async () => {
                acquireCalls++;
                return {
                    refId: 'new_acquire_ref',
                    host: 'host.example',
                };
            },
        });

        await ctx.init();
        await ctx.deinit();

        assert.strictEqual(acquireCalls, 1);

        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 2);
        assert.strictEqual(ops.operations[0].type, OperationType.ADD_NODE);
        assert.ok((ops.operations[0].retryCount || 0) >= 1);
        assert.strictEqual(ops.operations[1].type, OperationType.REMOVE_NODE);
        assert.strictEqual(ops.operations[1].ref, SECOND_REMOVE_PUBKEY);

        const cluster = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
        assert.ok(cluster.nodes.some((n) => n.pubkey === SECOND_REMOVE_PUBKEY));
        assert.ok(cluster.pendingNodes.length >= 1);
    });

    it('runs the first queued REMOVE before a later ready REMOVE', async () => {
        writeClusterFiles({
            nodes: [
                defaultClusterNode(FIRST_REMOVE_PUBKEY),
                defaultClusterNode(SECOND_REMOVE_PUBKEY),
            ],
            pendingNodes: [],
            operations: [
                {
                    type: OperationType.REMOVE_NODE,
                    ref: FIRST_REMOVE_PUBKEY,
                    data: { nodePubkey: FIRST_REMOVE_PUBKEY, force: true },
                },
                {
                    type: OperationType.REMOVE_NODE,
                    ref: SECOND_REMOVE_PUBKEY,
                    data: { nodePubkey: SECOND_REMOVE_PUBKEY, force: true },
                },
            ],
        });

        const ctx = buildClusterContext();
        await ctx.init();
        await ctx.deinit();

        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 2);
        assert.strictEqual(ops.operations[0].ref, FIRST_REMOVE_PUBKEY);
        assert.ok((ops.operations[0].retryCount || 0) >= 1);
        assert.strictEqual(ops.operations[1].ref, SECOND_REMOVE_PUBKEY);

        const cluster = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
        assert.ok(!cluster.nodes.some((n) => n.pubkey === FIRST_REMOVE_PUBKEY));
        assert.ok(cluster.nodes.some((n) => n.pubkey === SECOND_REMOVE_PUBKEY));
    });
});
