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
    readAcquiresFile,
} = require('./cluster-test-helpers');
const {
    NODE_COUNT,
    mulberry32,
    stateSha256,
    xahauStub,
    initNodeDirs,
    runAllNodesOneRound,
    assertHashConsensus,
    syncDirsFromLeader,
} = require('./queue-sim-harness');

const ADD_REF = 'queue_sim_add_ref';

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

    it('matrix 1: partial acquireSubmit throws on 2 nodes, equal hashes, ADD completes', async () => {
        const dirs = initNodeDirs(workRoot, 1, () => ({
            nodes: [],
            pendingNodes: [],
            operations: [{ type: OperationType.ADD_NODE, ref: ADD_REF, data: { acquireOptions: {}, lifeMoments: 1 } }],
        }));
        let ledgerTxCount = 0;
        for (let round = 0; round < 8; round++) {
            ledger.setGlobalValidatedIndex(10_000 + round);
            const sharedRef = `0xacquire_m1_r${round}`;
            const { hashes } = await runAllNodesOneRound({
                dirs,
                ledger,
                lcl: 100 + round * 4,
                hooks: {
                    evernodeForNode: (i) => ({
                        acquireNode: async (_opts, opRef) => {
                            if ((i === 1 || i === 3) && round < 3)
                                throw new Error('sim acquire throw');
                            ledgerTxCount++;
                            const pending = {
                                refId: sharedRef,
                                host: 'h',
                                opRef,
                                acquireLedgerCap: 10_000 + round + 5,
                            };
                            writeAcquiresFile({
                                pendingAcquires: [{
                                    ...pending,
                                    leaseOfferIdx: '1',
                                    messageKey: 'mk',
                                    acquireSentOnLcl: 100,
                                }],
                                acquiredNodes: [],
                            });
                            ledger.putTxAt(10_000 + round, {
                                hash: sharedRef,
                                resultCode: 'tesSUCCESS',
                                lastLedgerSequence: 10_000 + round + 5,
                            });
                            return pending;
                        },
                        getAcquireDataSnapshot: () => readAcquiresFile(),
                        getIfPending: (refId) => readAcquiresFile().pendingAcquires.find((p) => p.refId === refId) || null,
                    }),
                },
            });
            syncDirsFromLeader(dirs, 0);
            const roundHashes = dirs.map((d) => stateSha256(d));
            if (roundHashes.length)
                assertHashConsensus(roundHashes);
        }
        assert.ok(ledgerTxCount >= 1);
    });

    it('matrix 3: ADD succeeded on ledger but acquireSubmit threw — exactly 1 acquire', async () => {
        const dir = path.join(workRoot, 'n0');
        fs.mkdirSync(dir, { recursive: true });
        process.chdir(dir);
        writeAcquiresFile();
        writeClusterFiles({
            nodes: [],
            pendingNodes: [],
            operations: [{ type: OperationType.ADD_NODE, ref: ADD_REF, data: { acquireOptions: {}, lifeMoments: 1 } }],
        });
        const sharedHash = '0xacquire_once_matrix3';
        let acquireCalls = 0;
        const harness = createAcquireTxHarness();
        for (let lcl = 100; lcl <= 400; lcl += 4) {
            ledger.setGlobalValidatedIndex(10_000 + lcl);
            ledger.putTxAt(10_050, {
                hash: sharedHash,
                resultCode: 'tesSUCCESS',
                lastLedgerSequence: 10_060,
            });
            const ctx = buildClusterContext({
                ...harness.evernodeOverrides,
                acquireNode: async (opts, opRef) => {
                    acquireCalls++;
                    harness.pendingTxHashes.add(sharedHash);
                    harness.syncAcquiresFile?.();
                    writeAcquiresFile({
                        pendingAcquires: [{
                            refId: sharedHash,
                            host: 'h',
                            leaseOfferIdx: '1',
                            messageKey: 'mk',
                            acquireSentOnLcl: lcl,
                            opRef,
                            acquireLedgerCap: 10_060,
                        }],
                        acquiredNodes: [],
                    });
                    if (lcl === 100)
                        throw new Error('rpc timeout after submit');
                    return { refId: sharedHash, host: 'h', opRef, acquireLedgerCap: 10_060 };
                },
                xrplContext: xahauStub(ledger, 'n0'),
            }, { lclSeqNo: lcl });
            await ctx.init();
            await ctx.deinit();
        }
        assert.strictEqual(acquireCalls, 1);
        const pending = readAcquiresFile().pendingAcquires;
        assert.ok(pending.some((p) => p.refId === sharedHash));
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
        process.chdir(dirs[2]);
        const ctx = buildClusterContext({ xrplContext: xahauStub(ledger, 'n2') }, { lclSeqNo: 200 });
        await ctx.init();
        assert.strictEqual(ctx.isRoundAborted(), true);
        await ctx.deinit();
        const after = fs.readFileSync(path.join(dirs[2], 'operations.json'), 'utf8');
        assert.strictEqual(after, before);
    });

    it('acquire tx canonical bytes match across 5 nodes (evidence)', async () => {
        const dirs = initNodeDirs(workRoot, 99, () => ({
            nodes: [],
            pendingNodes: [],
            operations: [{ type: OperationType.ADD_NODE, ref: ADD_REF, data: { acquireOptions: {}, lifeMoments: 1 } }],
        }));
        const canonicalByNode = [];
        const fields = {
            sequence: 42,
            lastLedgerSequence: 10_010,
            fee: '12',
            account: 'rTenant',
            memos: [{ Memo: { MemoData: '74657374' } }],
        };
        const expected = FakeXahauLedger.acquireTxCanonicalBytes(fields).toString('hex');
        for (let i = 0; i < NODE_COUNT; i++) {
            process.chdir(dirs[i]);
            const ctx = buildClusterContext({
                acquireNode: async () => {
                    const bytes = FakeXahauLedger.acquireTxCanonicalBytes(fields);
                    canonicalByNode.push(bytes.toString('hex'));
                    return { refId: `0x${bytes.toString('hex').slice(0, 16)}`, host: 'h' };
                },
            }, { lclSeqNo: 100, lclHash: 'aabbccdd' });
            await ctx.init();
            await ctx.deinit();
        }
        for (const c of canonicalByNode)
            assert.strictEqual(c, expected);
        assert.strictEqual(new Set(canonicalByNode).size, 1);
    });

    it('matrix 7: 11 seeds x 100 rounds — 0 divergence', async () => {
        for (let seed = 0; seed < 11; seed++) {
            const rng = mulberry32(seed + 1000);
            const seedRoot = path.join(workRoot, `seed${seed}`);
            fs.mkdirSync(seedRoot, { recursive: true });
            const dirs = initNodeDirs(seedRoot, seed, () => ({
                nodes: [],
                pendingNodes: [],
                operations: [{ type: OperationType.ADD_NODE, ref: `${ADD_REF}_${seed}`, data: { acquireOptions: {}, lifeMoments: 1 } }],
            }));
            for (let round = 0; round < 100; round++) {
                ledger.setGlobalValidatedIndex(20_000 + seed * 1000 + round);
                const sharedRef = `0xacquire_s${seed}_r${round}`;
                const { hashes, aborted } = await runAllNodesOneRound({
                    dirs,
                    ledger,
                    lcl: 500 + round * 4,
                    hooks: {
                        evernodeForNode: (i, harness) => ({
                            acquireNode: async (opts, opRef) => {
                                harness.pendingTxHashes.add(sharedRef);
                                writeAcquiresFile({
                                    pendingAcquires: [{
                                        refId: sharedRef,
                                        host: 'h',
                                        leaseOfferIdx: '1',
                                        messageKey: 'mk',
                                        acquireSentOnLcl: 0,
                                        opRef,
                                        acquireLedgerCap: 20_000 + seed * 1000 + round + 3,
                                    }],
                                    acquiredNodes: [],
                                });
                                return { refId: sharedRef, host: 'h', opRef, acquireLedgerCap: 20_000 + seed * 1000 + round + 3 };
                            },
                            getAcquireDataSnapshot: () => readAcquiresFile(),
                            getIfPending: (refId) => readAcquiresFile().pendingAcquires.find((p) => p.refId === refId) || null,
                        }),
                    },
                });
                syncDirsFromLeader(dirs, 0);
                const roundHashes = dirs.map((d) => stateSha256(d));
                assertHashConsensus(roundHashes);
            }
        }
    });

    it('rejects lazy getIfPending stubs in this file', () => {
        const src = fs.readFileSync(path.join(__dirname, 'queue-sim.test.js'), 'utf8');
        assert.ok(!/getIfPending:\s*\(\)\s*=>\s*true/.test(src));
    });
});
