const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { OperationType } = require('../../dist/models/cluster');
const { MAX_OPERATION_ATTEMPTS, MAX_OPS_PER_ROUND, backoffLcl, isExtendComplete } = require('../../dist/cluster/OperationQueueProcessor');
const { computeExtendTxHash, LLS_LEDGER_WINDOW } = require('../../dist/cluster/DeterministicTx');
const { createWorkDir } = require('./test-workdir');
const {
    writeAcquiresFile,
    writeClusterFiles,
    defaultClusterNode,
    buildClusterContext,
    DEFAULT_ANCHOR,
    DEFAULT_TENANT_SEQUENCE,
    TENANT_ADDRESS,
} = require('./cluster-test-helpers');

const EXTEND_PUBKEY = 'mutation_extend_pubkey';

describe('Phase 1 mutation guards', () => {
    it('enforces MAX_OPERATION_ATTEMPTS === 8 and strict drop', () => {
        assert.strictEqual(MAX_OPERATION_ATTEMPTS, 8);
        assert.strictEqual(MAX_OPS_PER_ROUND, 1);
        assert.strictEqual(backoffLcl(1), 2);
        assert.strictEqual(LLS_LEDGER_WINDOW, 30);
    });

    it('isExtendComplete requires ledger tesSUCCESS at pinned anchor', () => {
        const snap = {
            anchorLedger: DEFAULT_ANCHOR,
            lclHash: 'h',
            tenantSequence: DEFAULT_TENANT_SEQUENCE,
            tenantAddress: TENANT_ADDRESS,
            feeCeiling: '12000000',
            hostList: ['host.alpha'],
            cluster: { nodes: [{ pubkey: EXTEND_PUBKEY, name: 'lease-token-idx' }], pendingNodes: [], initialized: true },
            operations: [],
            acquireData: { acquiredNodes: [], pendingAcquires: [] },
            unl: [],
            signerList: null,
            lclSeqNo: 1,
            extendLedgerChecks: [],
        };
        const op = { type: OperationType.EXTEND_NODE, ref: EXTEND_PUBKEY, data: { nodePubkey: EXTEND_PUBKEY, moments: 1 } };
        const hash = computeExtendTxHash(snap, op);
        assert.strictEqual(isExtendComplete(op, snap), false);
        snap.extendLedgerChecks = [{
            ref: EXTEND_PUBKEY,
            hash,
            lastLedgerSequence: DEFAULT_ANCHOR + 30,
            tx: { hash, resultCode: 'tesSUCCESS', lastLedgerSequence: DEFAULT_ANCHOR + 30 },
        }];
        assert.strictEqual(isExtendComplete(op, snap), true);
    });
});

describe('Phase 1 behavioral mutation guards', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-mutations');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('does not persist extendTxHash after perform', async () => {
        writeClusterFiles({
            nodes: [defaultClusterNode(EXTEND_PUBKEY)],
            operations: [{
                type: OperationType.EXTEND_NODE,
                ref: EXTEND_PUBKEY,
                data: { nodePubkey: EXTEND_PUBKEY, moments: 1 },
            }],
        });
        const ctx = buildClusterContext({ extendSubmit: async () => ({ hash: '0xlocal_only' }) });
        await ctx.init();
        await ctx.deinit();
        const raw = fs.readFileSync('operations.json', 'utf8');
        assert.ok(!raw.includes('extendTxHash'));
        assert.ok(!raw.includes('0xlocal_only'));
    });

    it('skips held ADD and still performs EXTEND behind it', async () => {
        writeClusterFiles({
            nodes: [defaultClusterNode(EXTEND_PUBKEY)],
            operations: [
                { type: OperationType.ADD_NODE, ref: 'add', data: { acquireOptions: {}, lifeMoments: 1 } },
                { type: OperationType.EXTEND_NODE, ref: EXTEND_PUBKEY, data: { nodePubkey: EXTEND_PUBKEY, moments: 1 } },
            ],
        });
        let extendCalls = 0;
        const ctx = buildClusterContext({
            extendSubmit: async () => {
                extendCalls++;
                throw new Error('fail');
            },
        });
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(extendCalls, 1);
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 2);
        assert.strictEqual(ops.operations[0].type, OperationType.ADD_NODE);
    });

    it('throws when txSubmitInfo has no fee', async () => {
        const { default: XrplContext } = require('../../dist/context/XrplContext');
        const hp = { voteContext: { getUniqueNumber: () => 0, vote: async () => [] }, getContractUnl: () => [] };
        const xrpl = new XrplContext(hp, TENANT_ADDRESS, null, {});
        xrpl.signerListInfo = { signerQuorum: 1, signerList: [{ account: 'rS', weight: 1 }] };
        xrpl.multiSigner = { isSignerNode: () => false };
        await assert.rejects(
            () => xrpl.multiSignAndSubmitTransaction({ TransactionType: 'Test', Fee: '10' }, {
                txSubmitInfo: { sequence: 1, maxLedgerSequence: 999 },
            }),
            /Missing fee in txSubmitInfo/,
        );
    });
});
