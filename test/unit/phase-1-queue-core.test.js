const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { OperationType } = require('../../dist/models/cluster');
const { MAX_OPERATION_ATTEMPTS } = require('../../dist/cluster/OperationQueueProcessor');
const { createWorkDir } = require('./test-workdir');
const {
    writeAcquiresFile,
    writeClusterFiles,
    defaultClusterNode,
    buildClusterContext,
    consensusContract,
    DEFAULT_ANCHOR,
} = require('./cluster-test-helpers');

const EXTEND_PUBKEY = 'extend_phase1_pubkey';
const ADD_REF = 'add_held_ref';

describe('Phase 1 queue core', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-phase1');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('holds ADD at queue head without mutating attempt counters', async () => {
        writeClusterFiles({
            nodes: [],
            pendingNodes: [],
            operations: [{
                type: OperationType.ADD_NODE,
                ref: ADD_REF,
                data: { acquireOptions: {}, lifeMoments: 1 },
                attempt: 0,
                nextAttemptLcl: 0,
            }],
        });
        const ctx = buildClusterContext();
        await ctx.init();
        await ctx.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        assert.strictEqual(ops.operations[0].attempt ?? 0, 0);
    });

    it('skips held ADD at head and still runs EXTEND behind it', async () => {
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
    });

    it('holds REMOVE at queue head untouched', async () => {
        const pk = 'remove_held_pubkey';
        writeClusterFiles({
            nodes: [defaultClusterNode(pk)],
            operations: [{
                type: OperationType.REMOVE_NODE,
                ref: pk,
                data: { nodePubkey: pk, force: true },
            }],
        });
        const ctx = buildClusterContext();
        await ctx.init();
        await ctx.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        assert.strictEqual(ops.operations[0].attempt ?? 0, 0);
    });

    it('aborts round without persisting when anchorLedger is zero and config has no bootstrap anchor', async () => {
        writeClusterFiles({
            nodes: [defaultClusterNode(EXTEND_PUBKEY)],
            operations: [{
                type: OperationType.EXTEND_NODE,
                ref: EXTEND_PUBKEY,
                data: { nodePubkey: EXTEND_PUBKEY, moments: 2 },
            }],
            anchorLedger: 0,
        });
        const ctx = buildClusterContext({}, {
            getContractConfig: async () => ({
                unl: [],
                evernode: { hosts: ['host.alpha', 'host.beta'], feeCeiling: '12000000' },
                consensus: { roundtime: 1000, stage_slice: 100 },
                max_input_ledger_offset: 32,
            }),
        });
        await ctx.init();
        assert.strictEqual(ctx.isRoundAborted(), true);
        await ctx.deinit();
        const raw = fs.readFileSync('operations.json', 'utf8');
        assert.ok(!raw.includes('extendTxHash'));
    });

    it('continues round on Xahau lag using last agreed anchor', async () => {
        writeClusterFiles({
            nodes: [defaultClusterNode(EXTEND_PUBKEY)],
            operations: [{
                type: OperationType.EXTEND_NODE,
                ref: EXTEND_PUBKEY,
                data: { nodePubkey: EXTEND_PUBKEY, moments: 2 },
            }],
        });
        const ctx = buildClusterContext({
            xrplContext: {
                getValidatedLedgerIndex: () => DEFAULT_ANCHOR - 1,
            },
        });
        await ctx.init();
        assert.strictEqual(ctx.isRoundAborted(), false);
        await ctx.deinit();
    });

    it('does not dequeue EXTEND after local submit in the same round', async () => {
        writeClusterFiles({
            nodes: [{
                ...defaultClusterNode(EXTEND_PUBKEY),
                lifeMoments: 1,
                targetLifeMoments: 5,
            }],
            operations: [{
                type: OperationType.EXTEND_NODE,
                ref: EXTEND_PUBKEY,
                data: { nodePubkey: EXTEND_PUBKEY, moments: 4 },
            }],
        });
        const ctx = buildClusterContext({
            extendSubmit: async () => ({ hash: '0xextend' }),
        });
        await ctx.init();
        await ctx.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        const node = JSON.parse(fs.readFileSync('cluster.json', 'utf8')).nodes[0];
        assert.strictEqual(node.lifeMoments, 1);
    });

    it('dequeues EXTEND when ledger reports tesSUCCESS for pinned tx hash', async () => {
        const { buildPinnedExtendTx } = require('../../dist/cluster/ExtendPinning');
        const lls = DEFAULT_ANCHOR + 30;
        const nodes = [{
            ...defaultClusterNode(EXTEND_PUBKEY),
            lifeMoments: 1,
            targetLifeMoments: 5,
        }];
        const op = {
            type: OperationType.EXTEND_NODE,
            ref: EXTEND_PUBKEY,
            data: { nodePubkey: EXTEND_PUBKEY, moments: 4 },
        };
        const snap = {
            lclSeqNo: 1,
            lclHash: 'h',
            anchorLedger: DEFAULT_ANCHOR,
            tenantSequence: 42,
            tenantAddress: require('./cluster-test-helpers').TENANT_ADDRESS,
            feeCeiling: '12000000',
            hostList: ['host.alpha', 'host.beta'],
            cluster: { nodes, pendingNodes: [], initialized: true },
            operations: [op],
            acquireData: { acquiredNodes: [], pendingAcquires: [] },
            unl: [],
            signerList: null,
            extendLedgerChecks: [],
        };
        const pin = buildPinnedExtendTx(snap, op, { operations: [op], consumedTenantSequences: [] });
        writeClusterFiles({
            nodes,
            anchorLedger: DEFAULT_ANCHOR,
            agreedTenantSequence: 42,
            operations: [op],
            pinnedExtendTxs: { [EXTEND_PUBKEY]: pin },
        });
        const ctx = buildClusterContext({
            xrplContext: {
                getTxAt: async (hash, idx) => (
                    hash === pin.txHash && idx === lls
                        ? { resultCode: 'tesSUCCESS', lastLedgerSequence: lls }
                        : null
                ),
                getValidatedLedgerIndex: () => DEFAULT_ANCHOR + 30,
            },
        });
        await ctx.init();
        await ctx.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 0);
        const node = JSON.parse(fs.readFileSync('cluster.json', 'utf8')).nodes[0];
        assert.strictEqual(node.lifeMoments, 5);
    });

    it('increments attempt with deterministic backoff and drops after cap', async () => {
        writeClusterFiles({
            nodes: [defaultClusterNode(EXTEND_PUBKEY)],
            operations: [{
                type: OperationType.EXTEND_NODE,
                ref: EXTEND_PUBKEY,
                data: { nodePubkey: EXTEND_PUBKEY, moments: 1 },
                attempt: MAX_OPERATION_ATTEMPTS,
            }],
        });
        const ctx = buildClusterContext({
            extendSubmit: async () => { throw new Error('fail'); },
        });
        await ctx.init();
        await ctx.deinit();
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 0);
    });

    it('sets nextAttemptLcl from lclSeqNo and attempt backoff', async () => {
        const curLcl = 250;
        writeClusterFiles({
            nodes: [defaultClusterNode(EXTEND_PUBKEY)],
            operations: [{
                type: OperationType.EXTEND_NODE,
                ref: EXTEND_PUBKEY,
                data: { nodePubkey: EXTEND_PUBKEY, moments: 1 },
            }],
        });
        const ctx = buildClusterContext({
            extendSubmit: async () => { throw new Error('fail'); },
        }, { lclSeqNo: curLcl });
        await ctx.init();
        await ctx.deinit();
        const op = JSON.parse(fs.readFileSync('operations.json', 'utf8')).operations[0];
        const attempt = op.attempt ?? 1;
        const expectedBackoff = Math.min(2 ** attempt, 32);
        assert.strictEqual(op.nextAttemptLcl, curLcl + expectedBackoff);
    });
});
