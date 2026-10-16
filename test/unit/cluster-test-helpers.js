const fs = require('fs');

const { ClusterContext } = require('../../dist');

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
        getIfPending: () => true,
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

module.exports = {
    writeAcquiresFile,
    writeClusterFiles,
    defaultClusterNode,
    buildClusterContext,
    runClusterRound,
};
