const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, defaultClusterNode, buildClusterContext } = require('./cluster-test-helpers');

const TARGET = 'remove_step_guard_pubkey';
const SIGNER = 'rOldSignerGuard';

describe('REMOVE step guards (N5–N7)', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-remove-guards');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('N5: replaceSignerList no-ops when the old signer is already absent', async () => {
        let replaceCalls = 0;
        const signerList = { signerQuorum: 1, signerList: [{ account: 'rOther', weight: 1 }] };
        writeClusterFiles({
            nodes: [{ ...defaultClusterNode(TARGET), isUnl: true, signerAddress: SIGNER }],
            pendingNodes: [],
            operations: [{ type: 'remove_node', ref: TARGET, data: { nodePubkey: TARGET, force: true } }],
        });
        const ctx = buildClusterContext({}, {
            getContractUnl: () => [{ publicKey: TARGET }],
            getContractConfig: async () => ({ unl: [TARGET], consensus: { roundtime: 1000, stage_slice: 100 } }),
        });
        ctx.evernodeContext.xrplContext.getSignerList = () => signerList;
        ctx.evernodeContext.xrplContext.replaceSignerList = async () => { replaceCalls++; };
        ctx.evernodeContext.xrplContext.multiSigner = { isSignerNode: () => false, getSigner: () => null };
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(replaceCalls, 0);
    });

    it('N6: UNL drop is idempotent when pubkey is already absent from config.unl', async () => {
        let unlUpdates = 0;
        writeClusterFiles({
            nodes: [{ ...defaultClusterNode(TARGET), isUnl: true }],
            pendingNodes: [],
            operations: [{ type: 'remove_node', ref: TARGET, data: { nodePubkey: TARGET, force: true } }],
        });
        const ctx = buildClusterContext({}, {
            getContractUnl: () => [],
            getContractConfig: async () => ({ unl: [], consensus: { roundtime: 1000, stage_slice: 100 } }),
            updateContractConfig: async (cfg) => {
                unlUpdates++;
                return cfg;
            },
        });
        ctx.evernodeContext.xrplContext.getSignerList = () => null;
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(unlUpdates, 0);
    });

    it('N7: peer remove re-reads the node record before updatePeers', async () => {
        let peerRemoves = 0;
        writeClusterFiles({
            nodes: [{ ...defaultClusterNode(TARGET), isUnl: true, domain: 'd.example', peerPort: 9 }],
            pendingNodes: [],
            operations: [{ type: 'remove_node', ref: TARGET, data: { nodePubkey: TARGET, force: true } }],
        });
        const ctx = buildClusterContext({}, {
            getContractUnl: () => [{ publicKey: TARGET }],
            getContractConfig: async () => ({ unl: [TARGET], consensus: { roundtime: 1000, stage_slice: 100 } }),
            updatePeers: async (_add, remove) => {
                assert.strictEqual(remove?.length, 1);
                assert.strictEqual(remove[0], 'd.example:9');
                peerRemoves++;
            },
        });
        ctx.evernodeContext.xrplContext.getSignerList = () => null;
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(peerRemoves, 1);
    });
});
