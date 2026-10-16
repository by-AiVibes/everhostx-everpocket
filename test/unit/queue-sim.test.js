const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { OperationType } = require('../../dist/models/cluster');
const { FakeXahauLedger } = require('../../dist/ledger/FakeXahauLedger');
const { createWorkDir } = require('./test-workdir');
const {
    writeAcquiresFile,
    writeClusterFiles,
    buildClusterContext,
    createAcquireTxHarness,
} = require('./cluster-test-helpers');

const ADD_REF = 'queue_sim_add_ref';

function xahauStub(ledger, nodeId) {
    return {
        getValidatedLedgerIndex: () => (nodeId ? ledger.getNodeValidatedIndex(nodeId) : ledger.getValidatedLedgerIndex()),
        getTxAt: (hash, idx) => ledger.getTxAt(hash, idx),
        getSignerList: () => null,
        multiSigner: { isSignerNode: () => false, getSigner: () => null },
    };
}

function stateSha256(dir) {
    const ops = fs.readFileSync(path.join(dir, 'operations.json'));
    const cluster = fs.readFileSync(path.join(dir, 'cluster.json'));
    const acquires = fs.readFileSync(path.join(dir, 'acquires.json'));
    return crypto.createHash('sha256').update(ops).update(cluster).update(acquires).digest('hex');
}

describe('queue-sim (shared FakeXahau ledger)', () => {
    let workRoot;
    let originalCwd;
    let ledger;

    beforeEach(() => {
        originalCwd = process.cwd();
        workRoot = createWorkDir('evp-queue-sim');
        ledger = new FakeXahauLedger();
        ledger.setGlobalValidatedIndex(10_000);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(workRoot, { recursive: true, force: true });
    });

    it('uses real getIfPending keyed by tx hash (no stub) and one acquire for ADD', async () => {
        const harness = createAcquireTxHarness();
        const nodeDir = path.join(workRoot, 'n0');
        fs.mkdirSync(nodeDir, { recursive: true });
        process.chdir(nodeDir);
        writeAcquiresFile();
        writeClusterFiles({
            nodes: [],
            pendingNodes: [],
            operations: [{
                type: OperationType.ADD_NODE,
                ref: ADD_REF,
                data: { acquireOptions: {}, lifeMoments: 1 },
            }],
        });

        let acquireCalls = 0;
        const ctx = buildClusterContext({
            ...harness.evernodeOverrides,
            acquireNode: async (opts, opRef) => {
                acquireCalls++;
                const pending = await harness.evernodeOverrides.acquireNode(opts);
                pending.opRef = opRef;
                return pending;
            },
            xrplContext: xahauStub(ledger),
        }, { lclSeqNo: 100 });

        await ctx.init();
        await ctx.deinit();

        assert.strictEqual(acquireCalls, 1);
        const pending = JSON.parse(fs.readFileSync('cluster.json', 'utf8')).pendingNodes[0];
        assert.strictEqual(pending.opRef, ADD_REF);
        assert.ok(harness.evernodeOverrides.getIfPending(pending.refId));
    });

    it('five nodes produce identical state hashes over 20 rounds (sequential)', async () => {
        const dirs = Array.from({ length: 5 }, (_, i) => path.join(workRoot, `n${i}`));
        for (const dir of dirs) {
            fs.mkdirSync(dir, { recursive: true });
            process.chdir(dir);
            writeAcquiresFile();
            writeClusterFiles({
                nodes: [],
                pendingNodes: [],
                operations: [{
                    type: OperationType.ADD_NODE,
                    ref: ADD_REF,
                    data: { acquireOptions: {}, lifeMoments: 1 },
                }],
            });
        }

        for (let round = 0; round < 20; round++) {
            ledger.setGlobalValidatedIndex(10_000 + round);
            const sharedRefId = `0xacquire_${ADD_REF}_r${round}`;
            for (let i = 0; i < dirs.length; i++) {
                const harness = createAcquireTxHarness();
                process.chdir(dirs[i]);
                const ctx = buildClusterContext({
                    ...harness.evernodeOverrides,
                    acquireNode: async (opts, opRef) => {
                        harness.pendingTxHashes.add(sharedRefId);
                        return { refId: sharedRefId, host: 'host.example', opRef };
                    },
                    xrplContext: xahauStub(ledger, `n${i}`),
                }, { lclSeqNo: 100 + round * 4 });
                ledger.setNodeValidatedIndex(`n${i}`, 10_000 + round);
                await ctx.init();
                await ctx.deinit();
            }
            const roundHashes = dirs.map((d) => stateSha256(d));
            const first = roundHashes[0];
            for (const h of roundHashes) {
                assert.strictEqual(h, first);
            }
        }
    });
});
