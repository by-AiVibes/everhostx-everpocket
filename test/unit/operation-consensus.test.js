const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, defaultClusterNode, buildClusterContext, consensusContract } = require('./cluster-test-helpers');

const TARGET_PUBKEY = 'consensus_remove_target_pubkey';

describe('Operation queue consensus (agreed-state dequeue)', () => {
    let workRoot;
    let nodeADir;
    let nodeBDir;
    let originalCwd;

    beforeEach(() => {
        originalCwd = process.cwd();
        workRoot = createWorkDir('evp-consensus-root');
        nodeADir = path.join(workRoot, 'node-a');
        nodeBDir = path.join(workRoot, 'node-b');
        [nodeADir, nodeBDir].forEach((workDir) => {
            fs.mkdirSync(workDir, { recursive: true });
            const prev = process.cwd();
            process.chdir(workDir);
            writeAcquiresFile();
            writeClusterFiles({
                nodes: [{ ...defaultClusterNode('helper'), isUnl: true }, {
                    ...defaultClusterNode(TARGET_PUBKEY),
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
            process.chdir(prev);
        });
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(workRoot, { recursive: true, force: true });
    });

    it('writes identical operations.json after a round with mismatched local outcomes', async () => {
        const { state: sharedConfig, hpOverrides: baseHp } = consensusContract(['helper', TARGET_PUBKEY]);
        function buildNode(workDir, localThrows) {
            const prev = process.cwd();
            process.chdir(workDir);
            const ctx = buildClusterContext({
                getIfAcquired: () => null,
                getIfPending: () => false,
            }, {
                getContractUnl: () => [{ publicKey: 'helper' }, { publicKey: TARGET_PUBKEY }],
                ...baseHp,
                updateContractConfig: async (config) => {
                    if (localThrows) throw new Error('local UNL failure');
                    sharedConfig.unl = config.unl.filter((p) => p !== TARGET_PUBKEY);
                    return sharedConfig;
                },
            });
            ctx.evernodeContext.xrplContext.getSignerList = () => null;
            process.chdir(prev);
            return ctx;
        }

        async function run(ctx, workDir) {
            const prev = process.cwd();
            process.chdir(workDir);
            try {
                await ctx.init();
                await ctx.deinit();
            } finally {
                process.chdir(prev);
            }
        }

        const nodeA = buildNode(nodeADir, true);
        const nodeB = buildNode(nodeBDir, true);
        await run(nodeA, nodeADir);
        await run(nodeB, nodeBDir);

        const opsA = fs.readFileSync(path.join(nodeADir, 'operations.json'), 'utf8');
        const opsB = fs.readFileSync(path.join(nodeBDir, 'operations.json'), 'utf8');
        assert.deepStrictEqual(JSON.parse(opsA), JSON.parse(opsB));
        assert.ok((JSON.parse(opsA).operations[0]?.retryCount || 0) >= 1);
    });
});
