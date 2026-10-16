const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { FakeXahauLedger } = require('../helpers/FakeXahauLedger');
const {
    writeAcquiresFile,
    writeClusterFiles,
    buildClusterContext,
    readAcquiresFile,
} = require('./cluster-test-helpers');

const NODE_COUNT = 5;
const SHARED_LCL_HASH = 'cafebabe00cafebabe00cafebabe00cafebabe';
let activeSimRound = 0;

function mulberry32(seed) {
    return function next() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function stateSha256(dir) {
    const ops = fs.readFileSync(path.join(dir, 'operations.json'));
    const cluster = fs.readFileSync(path.join(dir, 'cluster.json'));
    const acquires = fs.readFileSync(path.join(dir, 'acquires.json'));
    return crypto.createHash('sha256').update(ops).update(cluster).update(acquires).digest('hex');
}

function messagePublicKeyForAdd(ref, lclSeqNo, anchorLedger) {
    const { deriveMessagePublicKey } = require('../../dist/cluster/DeterministicTx');
    return deriveMessagePublicKey({ anchorLedger, tenantSequence: 1, lclSeqNo }, ref);
}

function defaultHpOverrides(lclSeqNo) {
    return {
        lclSeqNo,
        lclHash: SHARED_LCL_HASH,
        getContractConfig: async () => ({
            unl: ['pk0', 'pk1', 'pk2', 'pk3', 'pk4'],
            evernode: { hosts: ['host.alpha', 'host.beta'], feeCeiling: '12000000' },
            consensus: { roundtime: 1000, stage_slice: 100 },
        }),
        getContractUnl: () => [{ publicKey: 'pk0' }],
        updateContractConfig: async (cfg) => cfg,
        updatePeers: async () => {},
        checkLiveness: async () => false,
    };
}

function xahauStub(ledger, nodeId) {
    return {
        bootstrapForRound: async () => {},
        reconcileValidatedTransactions: async () => {},
        deriveTxSubmitInfo: (snap) => ({
            sequence: snap?.tenantSequence ?? 1,
            maxLedgerSequence: (snap?.anchorLedger ?? ledger.getValidatedLedgerIndex()) + 30,
            fee: '12000000',
        }),
        getValidatedLedgerIndex: () => ledger.getNodeValidatedIndex(nodeId),
        getTxAt: (hash, idx) => ledger.getTxAt(hash, idx),
        getSignerListAt: (idx) => ledger.getSignerListAt(idx),
        getSignerList: () => null,
        deinit: async () => {},
        multiSigner: { isSignerNode: () => false, getSigner: () => null },
    };
}

function createSimEvernode(nodeIndex, ledger, options = {}) {
    const deferred = [];
    const {
        acquireTxCanonicalFields,
        computeAcquireTxHash,
        deriveHost,
        deriveLastLedgerSequence,
    } = require('../../dist/cluster/DeterministicTx');

    return {
        applyDeferredAcquireWrites: () => {
            const data = readAcquiresFile();
            for (const p of deferred) {
                if (!data.pendingAcquires.some((x) => x.refId === p.refId))
                    data.pendingAcquires.push(p);
            }
            deferred.length = 0;
            writeAcquiresFile(data);
        },
        acquireNodeFromSnapshot: async (snap, opRef) => {
            const snapOp = snap.operations.find((o) => o.ref === opRef);
            const messagePublicKey = snapOp?.data?.messagePublicKey;
            if (!messagePublicKey)
                throw new Error('messagePublicKey missing from snapshot');
            const canonical = acquireTxCanonicalFields(snap, opRef, messagePublicKey);
            const refId = computeAcquireTxHash(canonical, '1');
            const acquireLedgerCap = deriveLastLedgerSequence(snap);
            ledger.recordAcquireSubmit(canonical, refId);
            const resultCode = options.txResultCode || 'tesSUCCESS';
            if (!options.skipLedgerRecord) {
                ledger.putTxAt(snap.anchorLedger, {
                    hash: refId,
                    resultCode,
                    lastLedgerSequence: acquireLedgerCap,
                });
            }
            const pending = {
                refId,
                host: deriveHost(snap, opRef),
                leaseOfferIdx: '1',
                messageKey: messagePublicKey,
                acquireSentOnLcl: snap.lclSeqNo,
                opRef,
                acquireLedgerCap,
            };
            deferred.push(pending);
            if (options.throwAllUntilRound !== undefined && activeSimRound < options.throwAllUntilRound)
                throw new Error('sim acquire throw');
            if (options.throwOnNodes?.includes(nodeIndex) && activeSimRound < (options.throwUntilRound ?? 0))
                throw new Error('sim acquire throw');
            return pending;
        },
        getAcquireDataSnapshot: () => readAcquiresFile(),
        getIfPending: (refId) => readAcquiresFile().pendingAcquires.find((p) => p.refId === refId) || null,
        getIfAcquired: (refId) => readAcquiresFile().acquiredNodes.find((n) => n.refId === refId) || null,
        extendSubmit: async () => false,
    };
}

function initNodeDirs(workRoot, seed, opsFactory) {
    const dirs = Array.from({ length: NODE_COUNT }, (_, i) => path.join(workRoot, `n${i}`));
    const rng = mulberry32(seed);
    dirs.forEach((dir, i) => {
        fs.mkdirSync(dir, { recursive: true });
        process.chdir(dir);
        writeAcquiresFile();
        writeClusterFiles(opsFactory(rng, i));
    });
    return dirs;
}

const nodeContexts = new Map();

function getOrCreateNodeContext(dir, nodeIndex, ledger, lcl, hooks) {
    const nodeId = `n${nodeIndex}`;
    if (!nodeContexts.has(dir)) {
        const sim = createSimEvernode(nodeIndex, ledger, hooks.simOptions || {});
        nodeContexts.set(dir, buildClusterContext({
            ...sim,
            ...hooks.evernodeForNode?.(nodeIndex),
            xrplContext: xahauStub(ledger, nodeId),
        }, { ...defaultHpOverrides(lcl), ...hooks.hpForNode?.(nodeIndex) }));
    }
    const ctx = nodeContexts.get(dir);
    ctx.hpContext.lclSeqNo = lcl;
    return ctx;
}

function resetNodeContexts() {
    nodeContexts.clear();
}

async function runAllNodesOneRound({ dirs, ledger, lcl, hooks = {} }) {
    activeSimRound = hooks.round ?? 0;
    const hashes = [];
    const aborted = [];
    for (let i = 0; i < dirs.length; i++) {
        const nodeId = `n${i}`;
        ledger.setNodeValidatedIndex(nodeId, ledger.getValidatedLedgerIndex());
        process.chdir(dirs[i]);
        const ctx = getOrCreateNodeContext(dirs[i], i, ledger, lcl, hooks);
        await ctx.init();
        const wasAborted = ctx.isRoundAborted?.() ?? false;
        await ctx.deinit();
        aborted.push(wasAborted);
        if (!wasAborted)
            hashes.push(stateSha256(dirs[i]));
    }
    return { hashes, aborted };
}

function assertHashConsensus(hashes) {
    const first = hashes[0];
    for (const h of hashes) {
        if (h !== first)
            throw new Error(`state hash divergence: ${h} vs ${first}`);
    }
}

module.exports = {
    NODE_COUNT,
    SHARED_LCL_HASH,
    mulberry32,
    stateSha256,
    messagePublicKeyForAdd,
    xahauStub,
    createSimEvernode,
    initNodeDirs,
    runAllNodesOneRound,
    assertHashConsensus,
    FakeXahauLedger,
    resetNodeContexts,
};
