const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { FakeXahauLedger } = require('../../dist/ledger/FakeXahauLedger');
const {
    writeAcquiresFile,
    writeClusterFiles,
    buildClusterContext,
    createAcquireTxHarness,
    readAcquiresFile,
} = require('./cluster-test-helpers');

const NODE_COUNT = 5;

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

function xahauStub(ledger, nodeId) {
    return {
        getValidatedLedgerIndex: () => ledger.getNodeValidatedIndex(nodeId),
        getTxAt: (hash, idx) => ledger.getTxAt(hash, idx),
        getSignerListAt: (idx) => ledger.getSignerListAt(idx),
        getSignerList: () => null,
        multiSigner: { isSignerNode: () => false, getSigner: () => null },
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

async function runAllNodesOneRound({ dirs, ledger, lcl, hooks = {} }) {
    const hashes = [];
    const aborted = [];
    for (let i = 0; i < dirs.length; i++) {
        const nodeId = `n${i}`;
        ledger.setNodeValidatedIndex(nodeId, ledger.getValidatedLedgerIndex());
        process.chdir(dirs[i]);
        const harness = hooks.harnessFactory ? hooks.harnessFactory(i) : createAcquireTxHarness();
        const ctx = buildClusterContext({
            ...harness.evernodeOverrides,
            ...hooks.evernodeForNode?.(i, harness),
            xrplContext: xahauStub(ledger, nodeId),
        }, { lclSeqNo: lcl, ...hooks.hpForNode?.(i) });
        await ctx.init();
        const wasAborted = ctx.isRoundAborted?.() ?? false;
        await ctx.deinit();
        aborted.push(wasAborted);
        if (!wasAborted)
            hashes.push(stateSha256(dirs[i]));
    }
    return { hashes, aborted };
}

function syncDirsFromLeader(dirs, leaderIndex = 0) {
    for (let i = 0; i < dirs.length; i++) {
        if (i === leaderIndex)
            continue;
        for (const f of ['operations.json', 'cluster.json', 'acquires.json']) {
            fs.copyFileSync(path.join(dirs[leaderIndex], f), path.join(dirs[i], f));
        }
    }
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
    mulberry32,
    stateSha256,
    xahauStub,
    initNodeDirs,
    runAllNodesOneRound,
    assertHashConsensus,
    syncDirsFromLeader,
    FakeXahauLedger,
};
