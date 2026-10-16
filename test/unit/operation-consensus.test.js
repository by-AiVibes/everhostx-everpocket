const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, defaultClusterNode, buildClusterContext } = require('./cluster-test-helpers');
const { OperationVoteCoordinator } = require('./operation-vote-coordinator');

const TARGET_PUBKEY = 'consensus_remove_target_pubkey';
const SIGNER_ADDR = 'rOldSignerAddressForConsensusTest';

function seedWorkDir(workDir) {
    const originalCwd = process.cwd();
    process.chdir(workDir);
    writeAcquiresFile();
    writeClusterFiles({
        nodes: [
            { ...defaultClusterNode('non_quorum_helper_pubkey'), isUnl: true },
            {
            ...defaultClusterNode(TARGET_PUBKEY),
            signerAddress: SIGNER_ADDR,
            isUnl: true,
            domain: 'node.example',
            peerPort: 1234,
        }],
        pendingNodes: [],
        operations: [{
            type: 'remove_node',
            ref: TARGET_PUBKEY,
            data: { nodePubkey: TARGET_PUBKEY, force: true },
        }],
    });
    process.chdir(originalCwd);
}

function buildNodeContext(workDir, nodeId, coordinator, { localThrows }) {
    const originalCwd = process.cwd();
    process.chdir(workDir);

    const signerList = {
        signerQuorum: 1,
        signerList: [{ account: SIGNER_ADDR, weight: 1 }],
    };

    let replaceCalls = 0;
    const ctx = buildClusterContext({
        voteContext: coordinator.createVoteContext(nodeId),
        getIfAcquired: () => null,
        getIfPending: () => false,
    }, {
        getContractUnl: () => [
            { publicKey: 'node_a' },
            { publicKey: 'node_b' },
            { publicKey: 'non_quorum_helper_pubkey' },
            { publicKey: TARGET_PUBKEY },
        ],
        getContractConfig: async () => ({
            unl: ['non_quorum_helper_pubkey', TARGET_PUBKEY],
            consensus: { roundtime: 1000, stage_slice: 100 },
        }),
        updateContractConfig: async (config) => {
            if (localThrows) {
                throw new Error('local UNL update failure');
            }
            config.unl = config.unl.filter((p) => p !== TARGET_PUBKEY);
            return config;
        },
    });

    ctx.evernodeContext.xrplContext.getSignerList = () => signerList;
    ctx.evernodeContext.xrplContext.replaceSignerList = async (oldSigner) => {
        replaceCalls++;
        signerList.signerList = signerList.signerList.filter((s) => s.account !== oldSigner);
    };
    ctx.evernodeContext.xrplContext.multiSigner = {
        isSignerNode: () => false,
        getSigner: () => null,
        generateSigner: () => ({ account: 'rNewSigner' }),
    };
    ctx.evernodeContext.xrplContext.getTransactionSubmissionInfo = async () => ({
        options: { key: 'non_quorum_helper_pubkey', options: { signerAddress: 'rNewSigner' } },
    });

    process.chdir(originalCwd);
    return ctx;
}

describe('Operation queue consensus (NPL outcome vote)', () => {
    let workRoot;
    let nodeADir;
    let nodeBDir;

    beforeEach(() => {
        workRoot = createWorkDir('evp-consensus-root');
        nodeADir = path.join(workRoot, 'node-a');
        nodeBDir = path.join(workRoot, 'node-b');
        fs.mkdirSync(nodeADir, { recursive: true });
        fs.mkdirSync(nodeBDir, { recursive: true });
        seedWorkDir(nodeADir);
        seedWorkDir(nodeBDir);
    });

    afterEach(() => {
        fs.rmSync(workRoot, { recursive: true, force: true });
    });

    it('writes identical operations.json on all nodes when one attempt throws locally', async () => {
        const coordinator = new OperationVoteCoordinator(2);
        const ctxA = buildNodeContext(nodeADir, 'node_a', coordinator, { localThrows: true });
        const ctxB = buildNodeContext(nodeBDir, 'node_b', coordinator, { localThrows: false });

        async function runRound(ctx, workDir) {
            const prev = process.cwd();
            process.chdir(workDir);
            try {
                await ctx.init();
                await ctx.deinit();
            } finally {
                process.chdir(prev);
            }
        }

        await Promise.all([
            runRound(ctxA, nodeADir),
            runRound(ctxB, nodeBDir),
        ]);

        const opsA = fs.readFileSync(path.join(nodeADir, 'operations.json'), 'utf8');
        const opsB = fs.readFileSync(path.join(nodeBDir, 'operations.json'), 'utf8');
        assert.strictEqual(opsA, opsB);
        assert.match(opsA, /"retryCount":\s*1/);
        assert.match(opsA, /"nextRetryLcl":/);
    });
});
