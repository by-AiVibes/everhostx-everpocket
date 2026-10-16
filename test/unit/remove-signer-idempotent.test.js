const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles, defaultClusterNode, buildClusterContext } = require('./cluster-test-helpers');

const TARGET_PUBKEY = 'idempotent_remove_signer_pubkey';
const SIGNER_ADDR = 'rSignerToRemoveOnce';

describe('REMOVE signer step idempotency', () => {
    let tmpDir;
    let originalCwd;
    let replaceCalls;
    let signerList;
    let failAfterSignerOnce;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-remove-idempotent');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
        replaceCalls = 0;
        failAfterSignerOnce = true;
        signerList = {
            signerQuorum: 1,
            signerList: [{ account: SIGNER_ADDR, weight: 1 }],
        };
        writeClusterFiles({
            nodes: [
                { ...defaultClusterNode('non_quorum_helper_pubkey'), isUnl: true },
                {
                ...defaultClusterNode(TARGET_PUBKEY),
                signerAddress: SIGNER_ADDR,
                isUnl: true,
                domain: 'rm.example',
                peerPort: 4001,
            }],
            pendingNodes: [],
            operations: [{
                type: 'remove_node',
                ref: TARGET_PUBKEY,
                data: { nodePubkey: TARGET_PUBKEY, force: true },
            }],
        });
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeContext(lclSeqNo) {
        const ctx = buildClusterContext({
            getIfAcquired: () => null,
            getIfPending: () => false,
        }, {
            lclSeqNo,
            getContractUnl: () => [
                { publicKey: 'non_quorum_helper_pubkey' },
                { publicKey: TARGET_PUBKEY },
            ],
            getContractConfig: async () => ({
                unl: ['non_quorum_helper_pubkey', TARGET_PUBKEY],
                consensus: { roundtime: 1000, stage_slice: 100 },
            }),
            updateContractConfig: async (config) => {
                if (failAfterSignerOnce && replaceCalls >= 1) {
                    failAfterSignerOnce = false;
                    throw new Error('fail after signer step');
                }
                config.unl = config.unl.filter((p) => p !== TARGET_PUBKEY);
                return config;
            },
        });

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
            generateSigner: () => ({ account: 'rReplacementSigner' }),
        };
        ctx.evernodeContext.xrplContext.getTransactionSubmissionInfo = async () => ({
            options: { key: 'non_quorum_helper_pubkey', options: { signerAddress: 'rReplacementSigner' } },
        });
        return ctx;
    }

    it('retries REMOVE with exactly one signer-list mutation after a post-signer failure', async () => {
        const ctx1 = makeContext(100);
        await ctx1.init();
        await ctx1.deinit();
        // cwd is already tmpDir from beforeEach
        assert.strictEqual(replaceCalls, 1);

        let ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        const nextRetryLcl = ops.operations[0].nextRetryLcl;

        const ctx2 = makeContext(nextRetryLcl);
        await ctx2.init();
        await ctx2.deinit();

        assert.strictEqual(replaceCalls, 1);
        ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 0);
    });
});
