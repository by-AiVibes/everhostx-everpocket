const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { createWorkDir } = require('./test-workdir');
const {
    writeAcquiresFile,
    writeClusterFiles,
    defaultClusterNode,
    buildClusterContext,
    consensusContract,
} = require('./cluster-test-helpers');

const DEAD_PUBKEY = 'dead_node_pubkey_for_remove_test';
const PENDING_REF = 'pending_acquire_ref_1';

describe('Fix 1: re-queue failed operations with retry metadata', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-requeue');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('keeps soft REMOVE on the queue when pending acquires block removal', async () => {
        writeClusterFiles({
            pendingNodes: [{
                refId: PENDING_REF,
                host: 'host',
                targetLifeMoments: 1,
                aliveCheckCount: 0,
            }],
            operations: [{
                type: 'remove_node',
                ref: DEAD_PUBKEY,
                data: { nodePubkey: DEAD_PUBKEY, force: false },
            }],
            nodes: [defaultClusterNode(DEAD_PUBKEY)],
        });

        const ctx = buildClusterContext({
            getIfAcquired: () => null,
            getIfPending: () => true,
        }, consensusContract([DEAD_PUBKEY]).hpOverrides);
        await ctx.init();
        await ctx.deinit();

        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        assert.strictEqual(ops.operations[0].ref, DEAD_PUBKEY);
        assert.ok((ops.operations[0].retryCount || 0) >= 1);
        assert.ok(ops.operations[0].nextRetryLcl !== undefined);

        const cluster = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
        assert.ok(cluster.nodes.some((n) => n.pubkey === DEAD_PUBKEY));
    });

    it('completes REMOVE after pending acquires clear', async () => {
        writeClusterFiles({
            pendingNodes: [],
            operations: [{
                type: 'remove_node',
                ref: DEAD_PUBKEY,
                data: { nodePubkey: DEAD_PUBKEY, force: false },
            }],
            nodes: [defaultClusterNode(DEAD_PUBKEY)],
        });

        const ctx = buildClusterContext({}, consensusContract([DEAD_PUBKEY]).hpOverrides);
        await ctx.init();
        await ctx.deinit();

        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 0);

        const cluster = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
        assert.ok(!cluster.nodes.some((n) => n.pubkey === DEAD_PUBKEY));
    });
});
