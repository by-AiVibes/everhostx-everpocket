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
    let sharedConfig;

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
        sharedConfig = {
            unl: ['non_quorum_helper_pubkey', TARGET_PUBKEY],
            consensus: { roundtime: 1000, stage_slice: 100 },
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
            getContractConfig: async () => sharedConfig,
            updateContractConfig: async (config) => {
                if (failAfterSignerOnce && replaceCalls >= 1) {
                    failAfterSignerOnce = false;
                    throw new Error('fail after signer step');
                }
                sharedConfig.unl = config.unl.filter((p) => p !== TARGET_PUBKEY);
                return sharedConfig;
            },
        });

        ctx.evernodeContext.xrplContext.getSignerList = () => signerList;
        const xrpl = ctx.evernodeContext.xrplContext;
        const originalReplace = xrpl.replaceSignerList?.bind?.(xrpl);
        xrpl.replaceSignerList = async (oldSigner, newSigner) => {
            if (!signerList.signerList.some((s) => s.account === oldSigner)) {
                return;
            }
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
        assert.ok(replaceCalls >= 1 || !signerList.signerList.some((s) => s.account === SIGNER_ADDR));

        let ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        let nextRetryLcl = ops.operations[0].nextRetryLcl;

        for (let attempt = 0; attempt < 6 && ops.operations.length > 0; attempt++) {
            const ctxN = makeContext(nextRetryLcl);
            await ctxN.init();
            await ctxN.deinit();
            ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
            if (ops.operations.length === 0) {
                break;
            }
            nextRetryLcl = ops.operations[0].nextRetryLcl;
        }

        assert.strictEqual(replaceCalls, 1);
        assert.strictEqual(ops.operations.length, 0);
    });
});
