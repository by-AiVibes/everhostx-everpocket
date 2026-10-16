const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { FakeXahauLedger } = require('../helpers/FakeXahauLedger');
const {
    writeAcquiresFile,
    writeClusterFiles,
    buildClusterContext,
    DEFAULT_ANCHOR,
    DEFAULT_TENANT_SEQUENCE,
} = require('./cluster-test-helpers');
const { OperationType } = require('../../dist/models/cluster');

const NODE_COUNT = 5;
const SHARED_LCL_HASH = 'cafebabe00cafebabe00cafebabe00cafebabe';

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

function defaultHpOverrides(lclSeqNo) {
    return {
        lclSeqNo,
        lclHash: SHARED_LCL_HASH,
        getContractConfig: async () => ({
            unl: ['pk0', 'pk1', 'pk2', 'pk3', 'pk4'],
            evernode: { hosts: ['host.alpha', 'host.beta'], feeCeiling: '12000000' },
            consensus: { roundtime: 1000, stage_slice: 100 },
        }),
        getContractUnl: () => [],
        updateContractConfig: async (cfg) => cfg,
        updatePeers: async () => {},
        checkLiveness: async () => false,
    };
}

function xahauStub(ledger, nodeId) {
    return {
        xrplAcc: { address: 'rSimTenant' },
        bootstrapForRound: async () => {},
        reconcileValidatedTransactions: async () => {},
        deriveTxSubmitInfo: (snap) => ({
            sequence: snap.tenantSequence,
            maxLedgerSequence: snap.anchorLedger + 30,
            fee: snap.feeCeiling,
        }),
        getValidatedLedgerIndex: () => ledger.getNodeValidatedIndex(nodeId),
        getTxAt: (hash, idx) => ledger.getTxAt(hash, idx),
        getSignerListAt: (idx) => ledger.getSignerListAt(idx),
        getSignerList: () => null,
        deinit: async () => {},
        multiSigner: { isSignerNode: () => false, getSigner: () => null },
    };
}

function extendOp(pubkey, moments) {
    return {
        type: OperationType.EXTEND_NODE,
        ref: pubkey,
        data: { nodePubkey: pubkey, moments },
    };
}

function initNodeDirs(workRoot, seed, opsFactory) {
    const dirs = Array.from({ length: NODE_COUNT }, (_, i) => path.join(workRoot, `n${i}`));
    const rng = mulberry32(seed);
    dirs.forEach((dir, i) => {
        fs.mkdirSync(dir, { recursive: true });
        process.chdir(dir);
        writeAcquiresFile();
        const clusterPayload = opsFactory(rng, i);
        writeClusterFiles({
            ...clusterPayload,
            anchorLedger: clusterPayload.anchorLedger ?? DEFAULT_ANCHOR,
            tenantSequence: clusterPayload.tenantSequence ?? DEFAULT_TENANT_SEQUENCE,
        });
    });
    return dirs;
}

const nodeContexts = new Map();
let activeSimRound = 0;

function getOrCreateNodeContext(dir, nodeIndex, ledger, lcl, hooks) {
    const nodeId = `n${nodeIndex}`;
    if (!nodeContexts.has(dir)) {
        const simOptions = hooks.simOptions || {};
        nodeContexts.set(dir, buildClusterContext({
            finishRoundInit: async () => {},
            extendSubmit: async (_host, _moments, _name) => {
                if (simOptions.throwAllUntilRound !== undefined && activeSimRound < simOptions.throwAllUntilRound)
                    throw new Error('sim extend throw');
                if (simOptions.throwOnNodes?.includes(nodeIndex) && activeSimRound < (simOptions.throwUntilRound ?? 0))
                    throw new Error('sim extend throw');
                const hash = `0xextend_round_${activeSimRound}`;
                const cap = DEFAULT_ANCHOR + 30;
                ledger.putTxAt(DEFAULT_ANCHOR, {
                    hash,
                    resultCode: 'tesSUCCESS',
                    lastLedgerSequence: cap,
                });
                return { hash, lastLedgerSequence: cap };
            },
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

function bumpAgreedAnchor(dirs, ledgerIndex) {
    for (const dir of dirs) {
        const p = path.join(dir, 'operations.json');
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        data.anchorLedger = Math.max(data.anchorLedger || 0, ledgerIndex);
        fs.writeFileSync(p, JSON.stringify(data));
    }
}

async function runAllNodesOneRound({ dirs, ledger, lcl, hooks = {} }) {
    activeSimRound = hooks.round ?? 0;
    const hashes = [];
    for (let i = 0; i < dirs.length; i++) {
        const nodeId = `n${i}`;
        ledger.setNodeValidatedIndex(nodeId, ledger.getValidatedLedgerIndex());
        process.chdir(dirs[i]);
        const ctx = getOrCreateNodeContext(dirs[i], i, ledger, lcl, hooks);
        await ctx.init();
        const wasAborted = ctx.isRoundAborted?.() ?? false;
        await ctx.deinit();
        if (!wasAborted)
            hashes.push(stateSha256(dirs[i]));
    }
    bumpAgreedAnchor(dirs, ledger.getValidatedLedgerIndex());
    return { hashes };
}

function assertHashConsensus(hashes) {
    const first = hashes[0];
    for (const h of hashes) {
        if (h !== first)
            throw new Error(`state hash divergence: ${h} vs ${first}`);
    }
}

function markExtendSuccessAll(dirs, hash, cap) {
    for (const dir of dirs) {
        ledgerPutExtendSuccess(dir, hash, cap);
    }
}

function ledgerPutExtendSuccess(dir, hash, cap) {
    const opsPath = path.join(dir, 'operations.json');
    const ops = JSON.parse(fs.readFileSync(opsPath, 'utf8'));
    for (const op of ops.operations) {
        if (op.type === OperationType.EXTEND_NODE && !op.data.extendTxHash) {
            op.data.extendTxHash = hash;
            op.data.extendLedgerCap = cap;
        }
    }
    fs.writeFileSync(opsPath, JSON.stringify(ops));
}

module.exports = {
    NODE_COUNT,
    SHARED_LCL_HASH,
    mulberry32,
    stateSha256,
    extendOp,
    xahauStub,
    initNodeDirs,
    runAllNodesOneRound,
    assertHashConsensus,
    FakeXahauLedger,
    resetNodeContexts,
    markExtendSuccessAll,
    DEFAULT_ANCHOR,
};
