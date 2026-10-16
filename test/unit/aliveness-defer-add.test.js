const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { OperationType } = require('../../dist/models/cluster');
const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, defaultClusterNode, buildClusterContext } = require('./cluster-test-helpers');

const DEAD_PUBKEY = 'dead_node_pubkey_aliveness_test';
const PENDING_REF = 'pending_acquire_aliveness_ref';

describe('Fix 5: pending aliveness defers ADD only', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-alive');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
        writeClusterFiles({
            nodes: [defaultClusterNode(DEAD_PUBKEY)],
            pendingNodes: [{
                refId: PENDING_REF,
                host: 'host.example',
                targetLifeMoments: 1,
                aliveCheckCount: 0,
            }],
            operations: [
                {
                    type: OperationType.ADD_NODE,
                    ref: 'add_op_ref',
                    data: { acquireOptions: {}, lifeMoments: 1, maxLifeMoments: 0 },
                },
                {
                    type: OperationType.REMOVE_NODE,
                    ref: DEAD_PUBKEY,
                    data: { nodePubkey: DEAD_PUBKEY, force: true },
                },
            ],
        });
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('processes REMOVE while a pending-node aliveness check runs (ADD stays queued)', async () => {
        const ctx = buildClusterContext({
            getIfAcquired: (refId) => {
                if (refId !== PENDING_REF) return null;
                return {
                    domain: 'pending.example',
                    userPort: 1,
                    peerPort: 2,
                    contractId: 'cid2',
                    pubkey: 'pending_pubkey',
                    name: 'pending',
                    outboundIp: '1.2.3.4',
                };
            },
            getIfPending: (refId) => refId === PENDING_REF,
            acquireNode: async () => {
                throw new Error('ADD must be deferred during aliveness check');
            },
        }, { lclSeqNo: 200 });

        await ctx.init();
        await ctx.deinit();

        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 2);
        assert.strictEqual(ops.operations[0].type, OperationType.ADD_NODE);
        assert.strictEqual(ops.operations[1].type, OperationType.REMOVE_NODE);
        assert.ok((ops.operations[1].attempt ?? ops.operations[1].retryCount ?? 0) >= 1);

        const cluster = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
        assert.ok(!cluster.nodes.some((n) => n.pubkey === DEAD_PUBKEY));
    });
});
