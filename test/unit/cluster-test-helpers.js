const fs = require('fs');

const { ClusterContext } = require('../../dist');

const DEFAULT_ANCHOR = 1_000_000;
const DEFAULT_TENANT_SEQUENCE = 42;

function consensusContract(unlPubkeys = []) {
    const state = {
        unl: [...unlPubkeys],
        evernode: { hosts: ['host.alpha', 'host.beta'], feeCeiling: '12000000' },
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

function writeClusterFiles({ nodes = [], pendingNodes = [], operations, anchorLedger = DEFAULT_ANCHOR, tenantSequence = DEFAULT_TENANT_SEQUENCE }) {
    fs.writeFileSync('cluster.json', JSON.stringify({
        initialized: true,
        nodes,
        pendingNodes,
    }, null, 4));
    fs.writeFileSync('operations.json', JSON.stringify({
        operations,
        anchorLedger,
        tenantSequence,
    }, null, 4));
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
        host: 'host.alpha',
        name: 'lease-token-idx',
        domain: 'node.example',
        peerPort: 2,
        userPort: 1,
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
            evernode: { hosts: ['host.alpha', 'host.beta'], feeCeiling: '12000000' },
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
        xrplAcc: { address: 'rTenantAgreedAddress' },
        bootstrapForRound: async () => {},
        reconcileValidatedTransactions: async () => {},
        deriveTxSubmitInfo: (snap) => ({
            sequence: snap.tenantSequence,
            maxLedgerSequence: snap.anchorLedger + 30,
            fee: snap.feeCeiling,
        }),
        getValidatedLedgerIndex: () => DEFAULT_ANCHOR,
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
        deinit: async () => {},
        getAcquireDataSnapshot: () => readAcquiresFile(),
        getIfAcquired: () => null,
        getIfPending: () => null,
        acquireNode: async () => { throw new Error('acquire should not run in phase 1'); },
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
    return ctx;
}

module.exports = {
    DEFAULT_ANCHOR,
    DEFAULT_TENANT_SEQUENCE,
    consensusContract,
    writeAcquiresFile,
    readAcquiresFile,
    writeClusterFiles,
    defaultClusterNode,
    buildClusterContext,
    runClusterRound,
};
