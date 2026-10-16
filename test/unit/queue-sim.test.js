const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { OperationType } = require('../../dist/models/cluster');
const { createWorkDir } = require('./test-workdir');
const { writeAcquiresFile, writeClusterFiles } = require('./cluster-test-helpers');
const {
    NODE_COUNT,
    messagePublicKeyForAdd,
    initNodeDirs,
    runAllNodesOneRound,
    assertHashConsensus,
    resetNodeContexts,
    FakeXahauLedger,
} = require('./queue-sim-harness');

const ADD_REF = 'queue_sim_add_ref';

function addOp(ref, lcl, anchor) {
    return {
        type: OperationType.ADD_NODE,
        ref,
        data: {
            acquireOptions: {},
            lifeMoments: 1,
            messagePublicKey: messagePublicKeyForAdd(ref, lcl, anchor),
        },
    };
}

function markAcquiredAll(dirs, refId, addRef = ADD_REF) {
    for (const dir of dirs) {
        const file = path.join(dir, 'acquires.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!data.acquiredNodes.some((n) => n.refId === refId)) {
            data.acquiredNodes.push({
                refId,
                host: 'host.alpha',
                name: 'inst',
                domain: 'node.example',
                pubkey: 'acquired_pk',
                userPort: 1,
                peerPort: 2,
                contractId: 'cid',
                outboundIp: '1.2.3.4',
            });
        }
        data.pendingAcquires = data.pendingAcquires.filter((p) => p.refId !== refId);
        fs.writeFileSync(file, JSON.stringify(data));
        const opsPath = path.join(dir, 'operations.json');
        const ops = JSON.parse(fs.readFileSync(opsPath, 'utf8'));
        for (const op of ops.operations) {
            if (op.ref === addRef && op.type === OperationType.ADD_NODE) {
                op.data.acquireTxHash = refId;
                op.data.acquireLedgerCap = 10_030;
            }
        }
        fs.writeFileSync(opsPath, JSON.stringify(ops));
    }
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
        resetNodeContexts();
    });

    afterEach(() => {
        resetNodeContexts();
        process.chdir(originalCwd);
        fs.rmSync(workRoot, { recursive: true, force: true });
    });

    it('matrix 1: partial acquireSubmit throws on 2 nodes, equal hashes, ADD completes', async () => {
        const anchor = 10_000;
        const dirs = initNodeDirs(workRoot, 1, () => ({
            nodes: [],
            pendingNodes: [],
            operations: [addOp(ADD_REF, 100, anchor)],
        }));
        for (let round = 0; round < 12; round++) {
            ledger.setGlobalValidatedIndex(anchor + round);
            const { hashes } = await runAllNodesOneRound({
                dirs,
                ledger,
                lcl: 100 + round * 4,
                hooks: {
                    round,
                    simOptions: { throwAllUntilRound: 3 },
                },
            });
            assertHashConsensus(hashes);
        }
        assert.strictEqual(ledger.uniqueAcquireHashes().size, 1);
        const refId = [...ledger.uniqueAcquireHashes()][0];
        markAcquiredAll(dirs, refId);
        ledger.setGlobalValidatedIndex(anchor + 40);
        const { hashes: finalHashes } = await runAllNodesOneRound({
            dirs,
            ledger,
            lcl: 200,
            hooks: { round: 99 },
        });
        assertHashConsensus(finalHashes);
        for (const dir of dirs) {
            const ops = JSON.parse(fs.readFileSync(path.join(dir, 'operations.json'), 'utf8'));
            assert.strictEqual(ops.operations.length, 0);
        }
    });

    it('matrix 2: partial delivery — votes drop for 2/5 nodes, no vote fields persisted', async () => {
        const anchor = 10_000;
        const dirs = initNodeDirs(workRoot, 2, () => ({
            nodes: [],
            pendingNodes: [],
            operations: [addOp(ADD_REF, 100, anchor)],
        }));
        for (let round = 0; round < 6; round++) {
            ledger.setGlobalValidatedIndex(anchor + round);
            const { hashes } = await runAllNodesOneRound({
                dirs,
                ledger,
                lcl: 100 + round * 4,
                hooks: {
                    round,
                    evernodeForNode: (i) => ({
                        voteContext: {
                            getUniqueNumber: () => 1,
                            vote: async (_name, cast) => (i === 1 || i === 3 ? [] : [{ sender: 'self', data: cast[0] }]),
                        },
                    }),
                },
            });
            assertHashConsensus(hashes);
            for (const dir of dirs) {
                const raw = fs.readFileSync(path.join(dir, 'operations.json'), 'utf8');
                assert.ok(!raw.includes('transactionMaxLls'));
                assert.ok(!raw.includes('message_key_selection'));
            }
        }
    });

    it('matrix 3: multi-node ADD — ledger has tx, one node throws after submit — exactly 1 acquire', async () => {
        const anchor = 10_000;
        const seedRoot = path.join(workRoot, 'm3');
        fs.mkdirSync(seedRoot, { recursive: true });
        const dirs = initNodeDirs(seedRoot, 3, () => ({
            nodes: [],
            pendingNodes: [],
            operations: [addOp(ADD_REF, 100, anchor)],
        }));
        resetNodeContexts();
        for (let round = 0; round < 8; round++) {
            ledger.setGlobalValidatedIndex(anchor + round);
            await runAllNodesOneRound({
                dirs,
                ledger,
                lcl: 100 + round * 4,
                hooks: {
                    round,
                    simOptions: { throwOnNodes: [0], throwUntilRound: 1 },
                },
            });
        }
        assert.strictEqual(ledger.uniqueAcquireHashes().size, 1);
        assert.ok(ledger.acquireSubmitCount() >= 1);
    });

    it('matrix 4: ADD tx failed (tecX) then one re-acquire after cap', async () => {
        const anchor = 10_000;
        const dirs = initNodeDirs(workRoot, 4, () => ({
            nodes: [],
            pendingNodes: [],
            operations: [addOp(ADD_REF, 100, anchor)],
        }));
        resetNodeContexts();
        await runAllNodesOneRound({
            dirs,
            ledger,
            lcl: 100,
            hooks: { round: 0, simOptions: { txResultCode: 'tecINSUFFICIENT_RESERVE' } },
        });
        const firstCount = ledger.acquireSubmitCount();
        assert.ok(firstCount >= 1);
        ledger.setGlobalValidatedIndex(anchor + 35);
        resetNodeContexts();
        await runAllNodesOneRound({
            dirs,
            ledger,
            lcl: 104,
            hooks: { round: 1, simOptions: { txResultCode: 'tesSUCCESS' } },
        });
        assert.ok(ledger.acquireSubmitCount() > firstCount);
        assert.strictEqual(ledger.uniqueAcquireHashes().size, 2);
    });

    it('matrix 5: REMOVE crash after SIGNER — no second replaceSignerList on resume', async () => {
        const anchor = 10_000;
        const removePk = 'remove_crash_pubkey';
        const dir = path.join(workRoot, 'm5');
        fs.mkdirSync(dir, { recursive: true });
        process.chdir(dir);
        writeAcquiresFile();
        writeClusterFiles({
            nodes: [{
                pubkey: removePk,
                contractId: 'cid',
                isUnl: true,
                signerAddress: 'rOldSigner',
                lifeMoments: 1,
                targetLifeMoments: 1,
                owner: 1,
                status: { status: 1, onLcl: 1 },
                domain: 'd.example',
                peerPort: 9,
            }],
            pendingNodes: [],
            operations: [{
                type: OperationType.REMOVE_NODE,
                ref: removePk,
                data: { nodePubkey: removePk, force: true, step: 'UNL' },
            }],
        });
        ledger.setSignerListAt(anchor, { signerQuorum: 1, signerList: [{ account: 'rOther', weight: 1 }] });
        let replaceCalls = 0;
        const { buildClusterContext } = require('./cluster-test-helpers');
        const { xahauStub } = require('./queue-sim-harness');
        const ctx = buildClusterContext({
            xrplContext: {
                ...xahauStub(ledger, 'n0'),
                replaceSignerList: async () => { replaceCalls++; },
            },
        }, {
            lclSeqNo: 200,
            lclHash: 'cafebabe00cafebabe00cafebabe00cafebabe',
            getContractConfig: async () => ({
                unl: [removePk],
                evernode: { hosts: ['host.alpha'], feeCeiling: '12000000' },
                consensus: { roundtime: 1000, stage_slice: 100 },
            }),
            getContractUnl: () => [{ publicKey: removePk }],
            updateContractConfig: async (cfg) => cfg,
            updatePeers: async () => {},
        });
        ledger.setGlobalValidatedIndex(anchor);
        await ctx.init();
        await ctx.deinit();
        assert.strictEqual(replaceCalls, 0);
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        assert.ok(ops.operations.length <= 1);
    });

    it('matrix 6: lagging node aborts without persisting', async () => {
        const dirs = initNodeDirs(workRoot, 6, () => ({
            nodes: [],
            pendingNodes: [],
            operations: [{
                type: OperationType.ADD_NODE,
                ref: ADD_REF,
                data: { acquireOptions: {}, lifeMoments: 1, acquireLedgerCap: 99_000 },
            }],
        }));
        fs.writeFileSync(path.join(dirs[2], 'operations.json'), JSON.stringify({
            operations: [{
                type: OperationType.ADD_NODE,
                ref: ADD_REF,
                data: { acquireOptions: {}, lifeMoments: 1, acquireLedgerCap: 99_000 },
            }],
            anchorLedger: 99_000,
        }));
        const before = fs.readFileSync(path.join(dirs[2], 'operations.json'), 'utf8');
        ledger.setGlobalValidatedIndex(1000);
        ledger.setNodeValidatedIndex('n2', 500);
        resetNodeContexts();
        process.chdir(dirs[2]);
        const { buildClusterContext } = require('./cluster-test-helpers');
        const { xahauStub } = require('./queue-sim-harness');
        const ctx = buildClusterContext({ xrplContext: xahauStub(ledger, 'n2') }, { lclSeqNo: 200 });
        await ctx.init();
        assert.strictEqual(ctx.isRoundAborted(), true);
        await ctx.deinit();
        const after = fs.readFileSync(path.join(dirs[2], 'operations.json'), 'utf8');
        assert.strictEqual(after, before);
    });

    it('acquire tx canonical bytes match across 5 nodes (evidence)', async () => {
        const anchor = 10_000;
        const dirs = initNodeDirs(workRoot, 99, () => ({
            nodes: [],
            pendingNodes: [],
            operations: [addOp(ADD_REF, 100, anchor)],
        }));
        resetNodeContexts();
        ledger.setGlobalValidatedIndex(anchor);
        await runAllNodesOneRound({ dirs, ledger, lcl: 100, hooks: { round: 0 } });
        const submits = ledger.submittedAcquires;
        assert.strictEqual(submits.length, NODE_COUNT);
        const first = FakeXahauLedger.acquireTxCanonicalBytes(submits[0].fields).toString('hex');
        for (const s of submits)
            assert.strictEqual(FakeXahauLedger.acquireTxCanonicalBytes(s.fields).toString('hex'), first);
        assert.strictEqual(new Set(submits.map((s) => s.hash)).size, 1);
    });

    it('matrix 7: 11 seeds x 100 rounds — 0 divergence', async () => {
        for (let seed = 0; seed < 11; seed++) {
            const seedRoot = path.join(workRoot, `seed${seed}`);
            fs.mkdirSync(seedRoot, { recursive: true });
            const anchor = 20_000 + seed * 1000;
            const ref = `${ADD_REF}_${seed}`;
            const dirs = initNodeDirs(seedRoot, seed, () => ({
                nodes: [],
                pendingNodes: [],
                operations: [addOp(ref, 500, anchor)],
            }));
            resetNodeContexts();
            for (let round = 0; round < 100; round++) {
                ledger.setGlobalValidatedIndex(anchor + round);
                const { hashes } = await runAllNodesOneRound({
                    dirs,
                    ledger,
                    lcl: 500 + round * 4,
                    hooks: { round },
                });
                assertHashConsensus(hashes);
            }
        }
    });

    it('rejects lazy getIfPending stubs in this file', () => {
        const src = fs.readFileSync(path.join(__dirname, 'queue-sim.test.js'), 'utf8');
        assert.ok(!/getIfPending:\s*\(\)\s*=>\s*true/.test(src));
    });
});
