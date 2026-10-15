const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClusterContext } = require('../../dist');
const { OperationType } = require('../../dist/models/cluster');

const DEAD_PUBKEY = 'dead_node_pubkey_aliveness_test';
const PENDING_REF = 'pending_acquire_aliveness_ref';

function writeFixture() {
    fs.writeFileSync('cluster.json', JSON.stringify({
        initialized: true,
        nodes: [{
            pubkey: DEAD_PUBKEY,
            contractId: 'cid',
            isUnl: false,
            lifeMoments: 1,
            targetLifeMoments: 1,
            owner: 1,
            status: { status: 1, onLcl: 1 },
        }],
        pendingNodes: [{
            refId: PENDING_REF,
            host: 'host.example',
            targetLifeMoments: 1,
            aliveCheckCount: 0,
        }],
    }, null, 4));

    fs.writeFileSync('operations.json', JSON.stringify({
        operations: [
            {
                type: OperationType.ADD_NODE,
                ref: 'add_op_ref',
                data: {
                    acquireOptions: {},
                    lifeMoments: 1,
                    maxLifeMoments: 0,
                },
            },
            {
                type: OperationType.REMOVE_NODE,
                ref: DEAD_PUBKEY,
                data: { nodePubkey: DEAD_PUBKEY, force: true },
            },
        ],
    }, null, 4));
}

describe('Fix 5: pending aliveness defers ADD only', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evp-alive-'));
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        fs.writeFileSync('acquires.json', JSON.stringify({ acquiredNodes: [], pendingAcquires: [] }));
        writeFixture();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('processes REMOVE while a pending-node aliveness check runs (ADD stays queued)', async () => {
        const hpContext = {
            publicKey: 'self_pubkey',
            contractId: 'contract_id',
            lclSeqNo: 200,
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
            getIfPending: () => true,
            acquireNode: async () => {
                throw new Error('ADD must be deferred during aliveness check');
            },
            extendSubmit: async () => false,
            xrplContext: { multiSigner: { isSignerNode: () => false, getSigner: () => null } },
        };

        const ctx = new ClusterContext(evernodeContext);
        await ctx.init();
        await ctx.deinit();

        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        assert.strictEqual(ops.operations[0].type, OperationType.ADD_NODE);

        const cluster = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
        assert.ok(!cluster.nodes.some((n) => n.pubkey === DEAD_PUBKEY));
    });
});
