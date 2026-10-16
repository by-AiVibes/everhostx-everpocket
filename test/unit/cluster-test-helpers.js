const fs = require('fs');

const { ClusterContext } = require('../../dist');

function consensusContract(unlPubkeys = []) {
    const state = {
        unl: [...unlPubkeys],
        consensus: { roundtime: 1000, stage_slice: 100 },
    };
    return {
        state,
        hpOverrides: {
            getContractConfig: async () => state,
            updateContractConfig: async (cfg) => {
                state.unl = [...cfg.unl];
                return state;
            },
        },
    };
}

function writeAcquiresFile(acquireData = { acquiredNodes: [], pendingAcquires: [] }) {
    fs.writeFileSync('acquires.json', JSON.stringify(acquireData));
}

function readAcquiresFile() {
    return JSON.parse(fs.readFileSync('acquires.json', 'utf8'));
}

function writeClusterFiles({ nodes = [], pendingNodes = [], operations }) {
    fs.writeFileSync('cluster.json', JSON.stringify({
        initialized: true,
        nodes,
        pendingNodes,
    }, null, 4));
    fs.writeFileSync('operations.json', JSON.stringify({ operations }, null, 4));
}

function defaultClusterNode(pubkey) {
    return {
        pubkey,
        contractId: 'cid',
        isUnl: false,
        lifeMoments: 1,
        targetLifeMoments: 1,
        owner: 1,
        status: { status: 1, onLcl: 1 },
    };
}

function buildClusterContext(evernodeContextOverrides = {}, hpOverrides = {}) {
    const { xrplContext: xrplOverrides, ...restEvernodeOverrides } = evernodeContextOverrides;
    const hpContext = {
        publicKey: 'self_pubkey',
        contractId: 'contract_id',
        lclSeqNo: 100,
        lclHash: 'hash',
        timestamp: Date.now(),
        getContractConfig: async () => ({
            unl: [],
            consensus: { roundtime: 1000, stage_slice: 100 },
        }),
        getContractUnl: () => [],
        updateContractConfig: async () => {},
        updatePeers: async () => {},
        checkLiveness: async () => false,
        ...hpOverrides,
    };

    const voteContext = {
        getUniqueNumber: () => 1,
        vote: async (_electionName, cast) => [{ sender: 'self', data: cast[0] }],
    };

    const defaultXrpl = {
        bootstrapForRound: async () => {},
        reconcileValidatedTransactions: async () => {},
        deriveTxSubmitInfo: (snap) => ({
            sequence: snap?.tenantSequence ?? 1,
            maxLedgerSequence: (snap?.anchorLedger ?? 1_000_000) + 30,
            fee: '12000000',
        }),
        getValidatedLedgerIndex: () => 1_000_000,
        getSignerList: () => null,
        getSignerListAt: async () => ({ signerQuorum: 1, signerList: [] }),
        getTxAt: async () => null,
        deinit: async () => {},
        multiSigner: { isSignerNode: () => false, getSigner: () => null },
        ...(xrplOverrides || {}),
    };

    const evernodeContext = {
        hpContext,
        voteContext,
        init: async () => {},
        bootstrapForRound: async () => { await defaultXrpl.bootstrapForRound(); },
        finishRoundInit: async () => {},
        applyDeferredAcquireWrites: () => {},
        deinit: async () => {},
        getAcquireDataSnapshot: () => readAcquiresFile(),
        getIfAcquired: () => null,
        getIfPending: () => null,
        acquireNode: async () => { throw new Error('acquire should not run'); },
        acquireNodeFromSnapshot: async () => { throw new Error('acquireNodeFromSnapshot should be stubbed'); },
        extendSubmit: async () => false,
        xrplContext: defaultXrpl,
        ...restEvernodeOverrides,
    };

    if (restEvernodeOverrides.xrplContext)
        evernodeContext.xrplContext = { ...defaultXrpl, ...restEvernodeOverrides.xrplContext };

    evernodeContext.hpContext = hpContext;
    return new ClusterContext(evernodeContext);
}

async function runClusterRound(evernodeOverrides, hpOverrides) {
    const ctx = buildClusterContext(evernodeOverrides, hpOverrides);
    await ctx.init();
    await ctx.deinit();
}

async function runClusterUntilSettled(evernodeOverrides, hpOverrides = {}, maxRounds = 30) {
    let lcl = hpOverrides.lclSeqNo ?? 100;
    for (let i = 0; i < maxRounds; i++) {
        await runClusterRound(evernodeOverrides, { ...hpOverrides, lclSeqNo: lcl });
        lcl += 4;
        const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
        if (ops.operations.length === 0)
            return i + 1;
    }
    return maxRounds;
}

/**
 * Simulates Evernode pending/acquired lookups keyed by transaction hash refId.
 */
function createAcquireTxHarness() {
    const pendingTxHashes = new Set();
    const acquiredByTx = new Map();
    const deferredPending = [];
    let txSeq = 0;

    function syncAcquiresFile() {
        const pendingAcquires = [...pendingTxHashes].map((refId) => ({
            refId,
            host: 'host.example',
            leaseOfferIdx: 'idx',
            messageKey: 'mk',
            acquireSentOnLcl: 0,
        }));
        const acquiredNodes = [...acquiredByTx.entries()].map(([refId, info]) => ({
            refId,
            host: 'host.example',
            ...info,
        }));
        writeAcquiresFile({ pendingAcquires, acquiredNodes });
    }

    function applyDeferredAcquireWrites() {
        const data = readAcquiresFile();
        for (const p of deferredPending) {
            pendingTxHashes.add(p.refId);
            if (!data.pendingAcquires.some((x) => x.refId === p.refId))
                data.pendingAcquires.push(p);
        }
        deferredPending.length = 0;
        writeAcquiresFile(data);
    }

    const evernodeOverrides = {
        applyDeferredAcquireWrites,
        acquireNodeFromSnapshot: async (_snap, opRef) => {
            const refId = `0xacquire_tx_${++txSeq}`;
            const pending = {
                refId,
                host: 'host.example',
                leaseOfferIdx: 'idx',
                messageKey: 'mk',
                acquireSentOnLcl: 0,
                opRef,
                acquireLedgerCap: 999_000,
            };
            deferredPending.push(pending);
            return pending;
        },
        acquireNode: async () => {
            throw new Error('legacy acquireNode should not run');
        },
        getIfPending: (refId) => {
            const pending = readAcquiresFile().pendingAcquires.find((n) => n.refId === refId);
            return pending || null;
        },
        getIfAcquired: (refId) => {
            const fromFile = readAcquiresFile().acquiredNodes.find((n) => n.refId === refId);
            return fromFile ?? acquiredByTx.get(refId) ?? null;
        },
        getAcquireDataSnapshot: () => readAcquiresFile(),
    };

    return {
        evernodeOverrides,
        pendingTxHashes,
        acquiredByTx,
        applyDeferredAcquireWrites,
        markAcquired(refId, info) {
            pendingTxHashes.delete(refId);
            acquiredByTx.set(refId, info);
            syncAcquiresFile();
        },
    };
}

module.exports = {
    consensusContract,
    createAcquireTxHarness,
    writeAcquiresFile,
    readAcquiresFile,
    writeClusterFiles,
    defaultClusterNode,
    buildClusterContext,
    runClusterRound,
    runClusterUntilSettled,
};
