const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { OperationType } = require('../../dist/models/cluster');
const NomadContext = require('../../dist/context/NomadContext').default;
const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, defaultClusterNode, buildClusterContext, consensusContract } = require('./cluster-test-helpers');

const SIGNER_A = 'signer_remove_a_pubkey';
const SIGNER_B = 'signer_remove_b_pubkey';
const SIGNER_ADDR_A = 'rSignerA';
const SIGNER_ADDR_B = 'rSignerB';

describe('Fix 2: parallel ops per round', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-parallel-ops');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('default maxOpsPerRound processes one operation per init', async () => {
        let acquireCalls = 0;
        writeClusterFiles({
            nodes: [],
            pendingNodes: [],
            operations: [
                { type: OperationType.ADD_NODE, ref: 'add1', data: { acquireOptions: {}, lifeMoments: 1 } },
                { type: OperationType.ADD_NODE, ref: 'add2', data: { acquireOptions: {}, lifeMoments: 1 } },
            ],
        });
        const ctx = buildClusterContext({
            acquireNode: async () => {
                acquireCalls++;
                return { refId: `ref_${acquireCalls}`, host: 'h' };
            },
        });
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(acquireCalls, 1);
    });

    it('respects maxOpsPerRound as an upper bound per init', async () => {
        let acquireCalls = 0;
        writeClusterFiles({
            nodes: [],
            pendingNodes: [],
            operations: [
                { type: OperationType.ADD_NODE, ref: 'add1', data: { acquireOptions: {}, lifeMoments: 1 } },
                { type: OperationType.ADD_NODE, ref: 'add2', data: { acquireOptions: {}, lifeMoments: 1 } },
                { type: OperationType.ADD_NODE, ref: 'add3', data: { acquireOptions: {}, lifeMoments: 1 } },
            ],
        });
        const ctx = buildClusterContext({
            acquireNode: async () => {
                acquireCalls++;
                return { refId: `ref_${acquireCalls}`, host: 'h' };
            },
        }, {}, { maxOpsPerRound: 2 });
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(acquireCalls, 2);
    });

    it('queues the full grow deficit in one grow() call', async () => {
        writeClusterFiles({
            nodes: [defaultClusterNode('only_node')],
            pendingNodes: [],
            operations: [],
        });
        const clusterCtx = buildClusterContext({
            getEvernodeConfig: () => ({ momentSize: 1000 }),
        }, {
            lclSeqNo: 50,
            lclHash: 'abc',
        });
        const nomad = new NomadContext(clusterCtx, {
            targetNodeCount: 4,
            lifeIncrMomentMinLimit: 1,
            parallelGrow: true,
        });
        await nomad.grow();
        await nomad.clusterContext.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 3);
        assert.ok(ops.operations.every((o) => o.type === OperationType.ADD_NODE));
    });

    it('rejects maxOpsPerRound below 1', () => {
        assert.throws(() => {
            buildClusterContext({}, {}, { maxOpsPerRound: 0 });
        }, /maxOpsPerRound must be at least 1/);
    });

    it('runs at most one signer-touching REMOVE per init round', async () => {
        let replaceCalls = 0;
        const unlRemovalAttempts = [];
        const signerList = {
            signerQuorum: 2,
            signerList: [
                { account: SIGNER_ADDR_A, weight: 1 },
                { account: SIGNER_ADDR_B, weight: 1 },
            ],
        };
        writeClusterFiles({
            nodes: [
                { ...defaultClusterNode('helper'), isUnl: true },
                { ...defaultClusterNode(SIGNER_A), isUnl: true, signerAddress: SIGNER_ADDR_A },
                { ...defaultClusterNode(SIGNER_B), isUnl: true, signerAddress: SIGNER_ADDR_B },
            ],
            pendingNodes: [],
            operations: [
                { type: OperationType.REMOVE_NODE, ref: SIGNER_A, data: { nodePubkey: SIGNER_A, force: true } },
                { type: OperationType.REMOVE_NODE, ref: SIGNER_B, data: { nodePubkey: SIGNER_B, force: true } },
            ],
        });
        const { hpOverrides } = consensusContract(['helper', SIGNER_A, SIGNER_B]);
        const ctx = buildClusterContext({
            getIfAcquired: () => null,
            getIfPending: () => false,
        }, {
            getContractUnl: () => [
                { publicKey: 'helper' },
                { publicKey: SIGNER_A },
                { publicKey: SIGNER_B },
            ],
            ...hpOverrides,
            updateContractConfig: async (config) => {
                const before = await hpOverrides.getContractConfig();
                before.unl.forEach((p) => {
                    if (!config.unl.includes(p)) {
                        unlRemovalAttempts.push(p);
                    }
                });
                return hpOverrides.updateContractConfig(config);
            },
        }, { maxOpsPerRound: 3 });

        ctx.evernodeContext.xrplContext.getSignerList = () => signerList;
        ctx.evernodeContext.xrplContext.replaceSignerList = async (oldSigner, newSigner) => {
            replaceCalls++;
            signerList.signerList = signerList.signerList.filter((s) => s.account !== oldSigner);
            if (!signerList.signerList.find((s) => s.account === newSigner)) {
                signerList.signerList.push({ account: newSigner, weight: 1 });
            }
        };
        ctx.evernodeContext.xrplContext.multiSigner = {
            isSignerNode: () => false,
            getSigner: () => null,
            generateSigner: () => ({ account: 'rReplacement' }),
        };
        ctx.evernodeContext.xrplContext.getTransactionSubmissionInfo = async () => ({
            options: { key: 'helper', options: { signerAddress: 'rReplacement' } },
        });

        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(replaceCalls, 1);
        assert.deepStrictEqual(unlRemovalAttempts, [SIGNER_A]);
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        assert.strictEqual(ops.operations[0].ref, SIGNER_B);
    });
});
