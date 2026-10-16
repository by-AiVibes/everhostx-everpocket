const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { OperationType } = require('../../dist/models/cluster');
const { createWorkDir } = require('./test-workdir');
const {
    writeAcquiresFile,
    writeClusterFiles,
    defaultClusterNode,
    buildClusterContext,
    consensusContract,
} = require('./cluster-test-helpers');

const REMOVE_PUBKEY = 'agreed_guard_remove_pubkey';
const OTHER_PENDING_REF = 'older_pending_acquire_ref';
const ADD_REF = 'add_op_own_ref';
const EXTEND_PUBKEY = 'extend_agreed_guard_pubkey';

describe('Operation agreed-state guards (behavioral)', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-agreed-guards');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('does not dequeue REMOVE after local UNL update in the same round', async () => {
        const { hpOverrides } = consensusContract([REMOVE_PUBKEY]);
        writeClusterFiles({
            nodes: [{ ...defaultClusterNode(REMOVE_PUBKEY), isUnl: true, domain: 'd', peerPort: 1 }],
            pendingNodes: [],
            operations: [{
                type: OperationType.REMOVE_NODE,
                ref: REMOVE_PUBKEY,
                data: { nodePubkey: REMOVE_PUBKEY, force: true },
            }],
        });
        const ctx = buildClusterContext({
            getIfAcquired: () => null,
            getIfPending: () => false,
        }, hpOverrides);
        await ctx.init();
        await ctx.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        assert.ok((ops.operations[0].retryCount || 0) >= 1);
    });

    it('advances retry after perform even when local REMOVE steps succeed', async () => {
        writeClusterFiles({
            nodes: [{ ...defaultClusterNode(REMOVE_PUBKEY), isUnl: true, domain: 'd', peerPort: 1 }],
            pendingNodes: [],
            operations: [{
                type: OperationType.REMOVE_NODE,
                ref: REMOVE_PUBKEY,
                data: { nodePubkey: REMOVE_PUBKEY, force: true },
            }],
        });
        const ctx = buildClusterContext({
            getIfAcquired: () => null,
            getIfPending: () => false,
        }, {
            getContractConfig: async () => ({
                unl: [REMOVE_PUBKEY],
                consensus: { roundtime: 1000, stage_slice: 100 },
            }),
            updateContractConfig: async (cfg) => cfg,
            updatePeers: async () => {},
        });
        await ctx.init();
        await ctx.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        assert.ok(ops.operations[0].retryCount >= 1);
    });

    it('does not treat ADD as complete when only a different pending acquire exists', async () => {
        writeClusterFiles({
            nodes: [],
            pendingNodes: [{ refId: OTHER_PENDING_REF, host: 'h', targetLifeMoments: 1, aliveCheckCount: 0 }],
            operations: [{
                type: OperationType.ADD_NODE,
                ref: ADD_REF,
                data: { acquireOptions: {}, lifeMoments: 1 },
            }],
        });
        let acquired = false;
        const ctx = buildClusterContext({
            acquireNode: async () => {
                acquired = true;
                return { refId: 'ignored', host: 'h' };
            },
        });
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(acquired, true);
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        const pending = JSON.parse(fs.readFileSync('cluster.json', 'utf8')).pendingNodes;
        assert.ok(pending.some((p) => p.refId === ADD_REF));
        assert.ok(pending.some((p) => p.refId === OTHER_PENDING_REF));
    });

    it('dequeues ADD when this op pending acquire was already in agreed state at round start', async () => {
        writeClusterFiles({
            nodes: [],
            pendingNodes: [{ refId: ADD_REF, host: 'h', targetLifeMoments: 1, aliveCheckCount: 0 }],
            operations: [{
                type: OperationType.ADD_NODE,
                ref: ADD_REF,
                data: { acquireOptions: {}, lifeMoments: 1 },
            }],
        });
        let acquireCalls = 0;
        const ctx = buildClusterContext({
            acquireNode: async () => {
                acquireCalls++;
                throw new Error('must not acquire');
            },
        });
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(acquireCalls, 0);
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 0);
    });

    it('does not dequeue EXTEND after local lifeMoments increase in the same round', async () => {
        writeClusterFiles({
            nodes: [{
                ...defaultClusterNode(EXTEND_PUBKEY),
                lifeMoments: 1,
                targetLifeMoments: 5,
            }],
            pendingNodes: [],
            operations: [{
                type: OperationType.EXTEND_NODE,
                ref: EXTEND_PUBKEY,
                data: { nodePubkey: EXTEND_PUBKEY, moments: 10 },
            }],
        });
        const ctx = buildClusterContext({
            extendSubmit: async () => true,
        });
        await ctx.init();
        await ctx.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        const node = JSON.parse(fs.readFileSync('cluster.json', 'utf8')).nodes[0];
        assert.ok(node.lifeMoments > 1);
    });
});

describe('Multi-node agreed snapshots', () => {
    let workRoot;
    let originalCwd;

    beforeEach(() => {
        originalCwd = process.cwd();
        workRoot = createWorkDir('evp-agreed-multi');
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(workRoot, { recursive: true, force: true });
    });

    it('byte-identical operations.json and cluster.json under divergent local REMOVE outcomes', async () => {
        const { hpOverrides } = consensusContract([REMOVE_PUBKEY]);
        const dirs = ['n1', 'n2'].map((n) => path.join(workRoot, n));
        dirs.forEach((d, i) => {
            fs.mkdirSync(d, { recursive: true });
            const prev = process.cwd();
            process.chdir(d);
            writeAcquiresFile();
            writeClusterFiles({
                nodes: [{ ...defaultClusterNode(REMOVE_PUBKEY), isUnl: true, domain: 'd', peerPort: 1 }],
                pendingNodes: [],
                operations: [{
                    type: OperationType.REMOVE_NODE,
                    ref: REMOVE_PUBKEY,
                    data: { nodePubkey: REMOVE_PUBKEY, force: true },
                }],
            });
            process.chdir(prev);
        });

        async function runNode(dir, failConfig) {
            const prev = process.cwd();
            process.chdir(dir);
            const ctx = buildClusterContext({
                getIfAcquired: () => null,
                getIfPending: () => false,
            }, {
                ...hpOverrides,
                updateContractConfig: async (cfg) => {
                    if (failConfig) throw new Error('cfg write fail');
                    return hpOverrides.updateContractConfig(cfg);
                },
                updatePeers: async () => {
                    if (!failConfig) throw new Error('peer update fail');
                },
            });
            await ctx.init();
            await ctx.deinit();
            process.chdir(prev);
        }

        await runNode(dirs[0], true);
        await runNode(dirs[1], false);

        const opsA = fs.readFileSync(path.join(dirs[0], 'operations.json'), 'utf8');
        const opsB = fs.readFileSync(path.join(dirs[1], 'operations.json'), 'utf8');
        const clusterA = fs.readFileSync(path.join(dirs[0], 'cluster.json'), 'utf8');
        const clusterB = fs.readFileSync(path.join(dirs[1], 'cluster.json'), 'utf8');
        assert.strictEqual(opsA, opsB);
        assert.strictEqual(clusterA, clusterB);
    });
});
