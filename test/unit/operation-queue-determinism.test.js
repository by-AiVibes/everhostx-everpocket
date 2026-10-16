const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, defaultClusterNode, buildClusterContext, consensusContract } = require('./cluster-test-helpers');

const TARGET_PUBKEY = 'deterministic_queue_remove_pubkey';
const PENDING_REF = 'pending_ref_determinism';

function seedWorkDir(workDir) {
    const prev = process.cwd();
    process.chdir(workDir);
    writeAcquiresFile();
    writeClusterFiles({
        nodes: [defaultClusterNode(TARGET_PUBKEY)],
        pendingNodes: [{
            refId: PENDING_REF,
            host: 'host',
            targetLifeMoments: 1,
            aliveCheckCount: 0,
        }],
        operations: [{
            type: 'remove_node',
            ref: TARGET_PUBKEY,
            data: { nodePubkey: TARGET_PUBKEY, force: false },
        }],
    });
    process.chdir(prev);
}

function buildNode(workDir, nodeId, { throwOnAttempt }, hpBase) {
    const prev = process.cwd();
    process.chdir(workDir);
    const ctx = buildClusterContext({
        getIfAcquired: () => null,
        getIfPending: (refId) => refId === PENDING_REF,
        voteContext: {
            getUniqueNumber: () => 0,
            vote: async () => {
                if (nodeId === 'node_c') {
                    return [{ data: { success: false } }];
                }
                return [];
            },
        },
    }, {
        getContractUnl: () => [{ publicKey: TARGET_PUBKEY }],
        ...hpBase,
        updateContractConfig: async (cfg) => {
            if (throwOnAttempt) throw new Error(`local failure on ${nodeId}`);
            return cfg;
        },
    });
    process.chdir(prev);
    return ctx;
}

describe('Operation queue determinism (no vote-majority)', () => {
    let workRoot;
    let originalCwd;

    beforeEach(() => {
        originalCwd = process.cwd();
        workRoot = createWorkDir('evp-queue-determinism');
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(workRoot, { recursive: true, force: true });
    });

    it('writes byte-identical operations.json across nodes with different local outcomes and partial votes', async () => {
        const { state: sharedConfig, hpOverrides } = consensusContract([TARGET_PUBKEY]);
        const dirs = ['node_a', 'node_b', 'node_c'].map((n) => path.join(workRoot, n));
        dirs.forEach((d) => {
            fs.mkdirSync(d, { recursive: true });
            seedWorkDir(d);
        });

        async function run(ctx, dir) {
            const prev = process.cwd();
            process.chdir(dir);
            try {
                await ctx.init();
                await ctx.deinit();
            } finally {
                process.chdir(prev);
            }
        }

        const contexts = dirs.map((dir, i) => buildNode(dir, `node_${i}`, { throwOnAttempt: i !== 1 }, hpOverrides));
        for (let i = 0; i < dirs.length; i++) {
            await run(contexts[i], dirs[i]);
        }

        const payloads = dirs.map((d) => fs.readFileSync(path.join(d, 'operations.json'), 'utf8'));
        const parsed = payloads.map((p) => JSON.parse(p));
        assert.deepStrictEqual(parsed[0], parsed[1]);
        assert.deepStrictEqual(parsed[1], parsed[2]);
        const op0 = parsed[0].operations[0];
        assert.ok((op0?.attempt ?? op0?.retryCount ?? 0) >= 1);
    });

    it('dequeues on all nodes when agreed REMOVE state is already complete', async () => {
        const { hpOverrides } = consensusContract([]);
        const dirs = ['a', 'b'].map((n) => path.join(workRoot, n));
        dirs.forEach((d) => {
            fs.mkdirSync(d, { recursive: true });
            const prev = process.cwd();
            process.chdir(d);
            writeAcquiresFile();
            writeClusterFiles({
                nodes: [],
                pendingNodes: [],
                operations: [{
                    type: 'remove_node',
                    ref: TARGET_PUBKEY,
                    data: { nodePubkey: TARGET_PUBKEY, force: true },
                }],
            });
            process.chdir(prev);
        });

        const payloads = [];
        for (const dir of dirs) {
            const prev = process.cwd();
            process.chdir(dir);
            const ctx = buildClusterContext({
                getIfAcquired: () => null,
                getIfPending: () => false,
            }, {
                ...hpOverrides,
            });
            await ctx.init();
            await ctx.deinit();
            payloads.push(fs.readFileSync('operations.json', 'utf8'));
            process.chdir(prev);
        }
        assert.deepStrictEqual(JSON.parse(payloads[0]), JSON.parse(payloads[1]));
        assert.strictEqual(JSON.parse(payloads[0]).operations.length, 0);
    });

    async function assertIdenticalQueuesAcrossNodes(nodeCount, { partialVoteNodeIds = [], throwOnNodeIds = [] }) {
        const { hpOverrides } = consensusContract([TARGET_PUBKEY]);
        const dirs = Array.from({ length: nodeCount }, (_, i) => path.join(workRoot, `n${i}`));
        dirs.forEach((d) => {
            fs.mkdirSync(d, { recursive: true });
            seedWorkDir(d);
        });

        async function run(ctx, dir) {
            const prev = process.cwd();
            process.chdir(dir);
            try {
                await ctx.init();
                await ctx.deinit();
            } finally {
                process.chdir(prev);
            }
        }

        for (let i = 0; i < nodeCount; i++) {
            const nodeId = `node_${i}`;
            const ctx = buildNode(dirs[i], nodeId, {
                throwOnAttempt: throwOnNodeIds.includes(nodeId),
            }, hpOverrides);
            if (partialVoteNodeIds.includes(nodeId)) {
                ctx.evernodeContext.voteContext.vote = async () => [];
            }
            await run(ctx, dirs[i]);
        }

        const parsed = dirs.map((d) => JSON.parse(fs.readFileSync(path.join(d, 'operations.json'), 'utf8')));
        for (let i = 1; i < parsed.length; i++) {
            assert.deepStrictEqual(parsed[0], parsed[i]);
        }
        const op0 = parsed[0].operations[0];
        assert.ok((op0?.attempt ?? op0?.retryCount ?? 0) >= 1);
    }

    it('3 nodes with one missing votes: identical operations.json', async () => {
        await assertIdenticalQueuesAcrossNodes(3, { partialVoteNodeIds: ['node_2'] });
    });

    it('5 nodes with one missing two vote rounds: identical operations.json', async () => {
        let misses = 0;
        const dirs = Array.from({ length: 5 }, (_, i) => path.join(workRoot, `five_${i}`));
        const { hpOverrides } = consensusContract([TARGET_PUBKEY]);
        dirs.forEach((d) => {
            fs.mkdirSync(d, { recursive: true });
            seedWorkDir(d);
        });
        for (let i = 0; i < 5; i++) {
            const prev = process.cwd();
            process.chdir(dirs[i]);
            const ctx = buildClusterContext({
                getIfAcquired: () => null,
                getIfPending: () => true,
                voteContext: {
                    getUniqueNumber: () => misses,
                    vote: async () => {
                        if (i === 4 && misses < 2) {
                            misses++;
                            return [];
                        }
                        return [{ sender: `node_${i}`, data: { success: true } }];
                    },
                },
            }, hpOverrides);
            process.chdir(prev);
            const runPrev = process.cwd();
            process.chdir(dirs[i]);
            await ctx.init();
            await ctx.deinit();
            process.chdir(runPrev);
        }
        const parsed = dirs.map((d) => JSON.parse(fs.readFileSync(path.join(d, 'operations.json'), 'utf8')));
        for (let i = 1; i < parsed.length; i++) {
            assert.deepStrictEqual(parsed[0], parsed[i]);
        }
    });

    it('4-node tie with one missing vote: identical operations.json', async () => {
        await assertIdenticalQueuesAcrossNodes(4, { partialVoteNodeIds: ['node_3'] });
    });
});
