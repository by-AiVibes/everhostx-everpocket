const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { createWorkDir } = require('./test-workdir');
const {
    writeAcquiresFile,
    writeClusterFiles,
    defaultClusterNode,
    buildClusterContext,
    consensusContract,
} = require('./cluster-test-helpers');

const BLOCKED_PUBKEY = 'blocked_remove_pubkey';
const READY_PUBKEY = 'ready_force_remove_pubkey';
const PENDING_REF = 'pending_ref_retry_guards';

const MAX_OPERATION_ATTEMPTS = 8;

describe('Operation retry guards (regression)', () => {
    let tmpDir;
    let originalCwd;

    beforeEach(() => {
        tmpDir = createWorkDir('evp-retry-guards');
        originalCwd = process.cwd();
        process.chdir(tmpDir);
        writeAcquiresFile();
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('drops an operation after MAX_OPERATION_ATTEMPTS failures (cap enforced)', async () => {
        writeClusterFiles({
            pendingNodes: [{ refId: PENDING_REF, host: 'h', targetLifeMoments: 1, aliveCheckCount: 0 }],
            nodes: [defaultClusterNode(BLOCKED_PUBKEY)],
            operations: [{
                type: 'remove_node',
                ref: BLOCKED_PUBKEY,
                data: { nodePubkey: BLOCKED_PUBKEY, force: false },
                attempt: MAX_OPERATION_ATTEMPTS - 1,
            }],
        });

        const { hpOverrides } = consensusContract([BLOCKED_PUBKEY]);
        const ctx = buildClusterContext({
            getIfAcquired: () => null,
            getIfPending: (refId) => refId === PENDING_REF,
        }, { lclSeqNo: 500, ...hpOverrides });

        await ctx.init();
        await ctx.deinit();

        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 0);
    });

    it('sets nextAttemptLcl strictly after curLcl (non-zero backoff)', async () => {
        const curLcl = 250;
        writeClusterFiles({
            pendingNodes: [{ refId: PENDING_REF, host: 'h', targetLifeMoments: 1, aliveCheckCount: 0 }],
            nodes: [defaultClusterNode(BLOCKED_PUBKEY)],
            operations: [{
                type: 'remove_node',
                ref: BLOCKED_PUBKEY,
                data: { nodePubkey: BLOCKED_PUBKEY, force: false },
            }],
        });

        const { hpOverrides } = consensusContract([BLOCKED_PUBKEY]);
        const ctx = buildClusterContext({
            getIfAcquired: () => null,
            getIfPending: (refId) => refId === PENDING_REF,
        }, { lclSeqNo: curLcl, ...hpOverrides });

        await ctx.init();
        await ctx.deinit();

        const op = JSON.parse(fs.readFileSync('operations.json', 'utf8')).operations[0];
        const attempt = op.attempt ?? op.retryCount ?? 1;
        const expectedBackoff = Math.min(2 ** attempt, 32);
        const nextLcl = op.nextAttemptLcl ?? op.nextRetryLcl;
        assert.strictEqual(nextLcl, curLcl + expectedBackoff);
        assert.ok(nextLcl > curLcl);
    });

    it('does not run a backed-off op while a later ready op can proceed', async () => {
        writeClusterFiles({
            pendingNodes: [],
            nodes: [
                defaultClusterNode(BLOCKED_PUBKEY),
                defaultClusterNode(READY_PUBKEY),
            ],
            operations: [
                {
                    type: 'remove_node',
                    ref: BLOCKED_PUBKEY,
                    data: { nodePubkey: BLOCKED_PUBKEY, force: false },
                    attempt: 1,
                    nextAttemptLcl: 10_000,
                },
                {
                    type: 'remove_node',
                    ref: READY_PUBKEY,
                    data: { nodePubkey: READY_PUBKEY, force: true },
                },
            ],
        });

        const { hpOverrides } = consensusContract([BLOCKED_PUBKEY, READY_PUBKEY]);
        const ctx = buildClusterContext({}, { lclSeqNo: 100, ...hpOverrides });
        await ctx.init();
        await ctx.deinit();

        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 2);
        assert.strictEqual(ops.operations[0].ref, BLOCKED_PUBKEY);
        assert.strictEqual(ops.operations[1].ref, READY_PUBKEY);
        assert.ok((ops.operations[1].attempt ?? ops.operations[1].retryCount ?? 0) >= 1);

        const cluster = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
        assert.ok(!cluster.nodes.some((n) => n.pubkey === READY_PUBKEY));
        assert.ok(cluster.nodes.some((n) => n.pubkey === BLOCKED_PUBKEY));
    });

    it('fails, then succeeds once backoff elapses (same operation)', async () => {
        const curLcl = 300;
        writeClusterFiles({
            pendingNodes: [{ refId: PENDING_REF, host: 'h', targetLifeMoments: 1, aliveCheckCount: 0 }],
            nodes: [defaultClusterNode(BLOCKED_PUBKEY)],
            operations: [{
                type: 'remove_node',
                ref: BLOCKED_PUBKEY,
                data: { nodePubkey: BLOCKED_PUBKEY, force: false },
            }],
        });

        const { hpOverrides } = consensusContract([BLOCKED_PUBKEY]);
        const ctx1 = buildClusterContext({
            getIfAcquired: () => null,
            getIfPending: (refId) => refId === PENDING_REF,
        }, { lclSeqNo: curLcl, ...hpOverrides });
        await ctx1.init();
        await ctx1.deinit();

        let ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        const nextRetryLcl = ops.operations[0].nextAttemptLcl ?? ops.operations[0].nextRetryLcl;
        assert.ok(nextRetryLcl > curLcl);

        writeClusterFiles({
            pendingNodes: [],
            nodes: [defaultClusterNode(BLOCKED_PUBKEY)],
            operations: ops.operations,
        });

        const ctx2 = buildClusterContext({
            getIfAcquired: () => null,
            getIfPending: () => false,
        }, { lclSeqNo: nextRetryLcl, ...hpOverrides });
        await ctx2.init();
        await ctx2.deinit();

        ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 1);
        const nextRetryLcl2 = ops.operations[0].nextAttemptLcl ?? ops.operations[0].nextRetryLcl;

        const ctx3 = buildClusterContext({
            getIfAcquired: () => null,
            getIfPending: () => false,
        }, { lclSeqNo: nextRetryLcl2, ...hpOverrides });
        await ctx3.init();
        await ctx3.deinit();

        ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.strictEqual(ops.operations.length, 0);
        const cluster = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
        assert.ok(!cluster.nodes.some((n) => n.pubkey === BLOCKED_PUBKEY));
    });
});
