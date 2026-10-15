const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClusterContext } = require('../../dist');

const DEAD_PUBKEY = 'dead_node_pubkey_for_remove_test';
const PENDING_REF = 'pending_acquire_ref_1';

function writeClusterFiles({ pendingNodes, operations, includeDeadNode = true }) {
    const nodes = includeDeadNode
        ? [{
            pubkey: DEAD_PUBKEY,
            contractId: 'cid',
            isUnl: false,
            lifeMoments: 1,
            targetLifeMoments: 1,
            owner: 1,
            status: { status: 1, onLcl: 1 },
        }]
        : [];

    fs.writeFileSync('cluster.json', JSON.stringify({
        initialized: true,
        nodes,
        pendingNodes,
    }, null, 4));

    fs.writeFileSync('operations.json', JSON.stringify({ operations }, null, 4));
}

function buildClusterContext() {
    const hpContext = {
        publicKey: 'self_pubkey',
        contractId: 'contract_id',
        lclSeqNo: 100,
        lclHash: 'hash',
        timestamp: Date.now(),
        getContractConfig: async () => ({
            unl: [],
            consensus: { roundtime: 1000, stage_slice: 100 },
        }),
        getContractUnl: () => [],
        updateContractConfig: async () => {},
        updatePeers: async () => {},
        checkLiveness: async () => false,
    };

    const voteContext = {
        getUniqueNumber: () => 1,
        vote: async () => [],
    };

    const evernodeContext = {
        hpContext,
        voteContext,
        init: async () => {},
        deinit: async () => {},
        getIfAcquired: (refId) => (refId === PENDING_REF ? null : null),
        getIfPending: () => true,
        acquireNode: async () => { throw new Error('acquire should not run'); },
        extendSubmit: async () => false,
        xrplContext: { multiSigner: { isSignerNode: () => false, getSigner: () => null } },
    };

    evernodeContext.hpContext = hpContext;
    return new ClusterContext(evernodeContext);
}

describe('Fix 1: re-queue failed operations with retry metadata', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evp-requeue-'));
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        fs.writeFileSync('acquires.json', JSON.stringify({ acquiredNodes: [], pendingAcquires: [] }));
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
        });

        const ctx = buildClusterContext();
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
        });

        const ctx = buildClusterContext();
        await ctx.init();
        await ctx.deinit();

        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 0);

        const cluster = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
        assert.ok(!cluster.nodes.some((n) => n.pubkey === DEAD_PUBKEY));
    });
});
