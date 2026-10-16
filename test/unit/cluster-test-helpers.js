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

function writeAcquiresFile() {
    fs.writeFileSync('acquires.json', JSON.stringify({ acquiredNodes: [], pendingAcquires: [] }));
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

    const evernodeContext = {
        hpContext,
        voteContext,
        init: async () => {},
        deinit: async () => {},
        getIfAcquired: () => null,
        getIfPending: () => false,
        acquireNode: async () => { throw new Error('acquire should not run'); },
        extendSubmit: async () => false,
        xrplContext: { multiSigner: { isSignerNode: () => false, getSigner: () => null } },
        ...evernodeContextOverrides,
    };

    evernodeContext.hpContext = hpContext;
    return new ClusterContext(evernodeContext);
}

async function runClusterRound(evernodeOverrides, hpOverrides) {
    const ctx = buildClusterContext(evernodeOverrides, hpOverrides);
    await ctx.init();
    await ctx.deinit();
}

/**
 * Simulates Evernode pending/acquired lookups keyed by transaction hash refId.
 */
function createAcquireTxHarness() {
    const pendingTxHashes = new Set();
    const acquiredByTx = new Map();
    let txSeq = 0;

    const evernodeOverrides = {
        acquireNode: async () => {
            const refId = `0xacquire_tx_${++txSeq}`;
            pendingTxHashes.add(refId);
            return { refId, host: 'host.example' };
        },
        getIfPending: (refId) => pendingTxHashes.has(refId),
        getIfAcquired: (refId) => acquiredByTx.get(refId) ?? null,
    };

    return {
        evernodeOverrides,
        pendingTxHashes,
        acquiredByTx,
        markAcquired(refId, info) {
            pendingTxHashes.delete(refId);
            acquiredByTx.set(refId, info);
        },
    };
}

module.exports = {
    consensusContract,
    createAcquireTxHarness,
    writeAcquiresFile,
    writeClusterFiles,
    defaultClusterNode,
    buildClusterContext,
    runClusterRound,
};
