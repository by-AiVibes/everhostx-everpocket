const fs = require('fs');

const { ClusterContext } = require('../../dist');
const { scheduleObservationSubmit } = require('../../dist/observation/ObservationSidecar');

const DEFAULT_ANCHOR = 1_000_000;
const DEFAULT_TENANT_SEQUENCE = 42;
const TENANT_ADDRESS = 'rTenantAgreedAddress';

function consensusContract(unlPubkeys = []) {
    const state = {
        unl: [...unlPubkeys],
        evernode: {
            hosts: ['host.alpha', 'host.beta'],
            feeCeiling: '12000000',
            anchorLedger: DEFAULT_ANCHOR,
            tenantSequence: DEFAULT_TENANT_SEQUENCE,
            checkpointInterval: 10,
            checkpointWindow: 3,
        },
        consensus: { roundtime: 1000, stage_slice: 100 },
        max_input_ledger_offset: 32,
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

function writeClusterFiles({
    nodes = [],
    pendingNodes = [],
    operations,
    anchorLedger = DEFAULT_ANCHOR,
    agreedTenantSequence = DEFAULT_TENANT_SEQUENCE,
    pinnedExtendTxs,
    agreedExtendResults,
}) {
    fs.writeFileSync('cluster.json', JSON.stringify({
        initialized: true,
        nodes,
        pendingNodes,
    }, null, 4));
    const opsPayload = {
        operations,
        anchorLedger,
        agreedTenantSequence,
    };
    if (pinnedExtendTxs)
        opsPayload.pinnedExtendTxs = pinnedExtendTxs;
    if (agreedExtendResults)
        opsPayload.agreedExtendResults = agreedExtendResults;
    fs.writeFileSync('operations.json', JSON.stringify(opsPayload, null, 4));
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

function buildClusterContext(evernodeContextOverrides = {}, hpOverrides = {}, ledgerHooks = {}) {
    const { xrplContext: xrplOverrides, ...restEvernodeOverrides } = evernodeContextOverrides;
    const hpContext = {
        publicKey: 'self_pubkey',
        contractId: 'contract_id',
        lclSeqNo: 100,
        lclHash: 'hash',
        timestamp: Date.now(),
        getContractConfig: async () => ({
            unl: [],
            evernode: {
                hosts: ['host.alpha', 'host.beta'],
                feeCeiling: '12000000',
                anchorLedger: DEFAULT_ANCHOR,
                tenantSequence: DEFAULT_TENANT_SEQUENCE,
                checkpointInterval: 10,
                checkpointWindow: 3,
            },
            consensus: { roundtime: 1000, stage_slice: 100 },
            max_input_ledger_offset: 32,
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
        xrplAcc: { address: TENANT_ADDRESS },
        bootstrapForRound: async () => {},
        reconcileValidatedTransactions: async () => {},
        deriveTxSubmitInfo: (snap) => {
            const { deriveTxSubmitInfo } = require('../../dist/context/XrplContext');
            // use real derivation via snapshot-shaped object
            const { readFeeCeiling, readTenantSequence, buildLastLedgerSequenceFromSnapshot } = require('../../dist/cluster/DeterministicTx');
            return {
                sequence: readTenantSequence(snap),
                maxLedgerSequence: buildLastLedgerSequenceFromSnapshot(snap),
                fee: readFeeCeiling(snap),
            };
        },
        getValidatedLedgerIndex: () => ledgerHooks.getValidatedLedgerIndex?.() ?? DEFAULT_ANCHOR,
        getSignerList: () => null,
        getSignerListAt: async (idx) => ledgerHooks.getSignerListAt?.(idx) ?? { signerQuorum: 1, signerList: [] },
        getAccountSequenceAt: async (account, idx) => {
            if (ledgerHooks.getAccountSequenceAt)
                return ledgerHooks.getAccountSequenceAt(account, idx);
            if (idx === DEFAULT_ANCHOR && account === TENANT_ADDRESS)
                return DEFAULT_TENANT_SEQUENCE;
            throw new Error(`No sequence stub for ${account}@${idx}`);
        },
        getTxAt: async (hash, idx) => ledgerHooks.getTxAt?.(hash, idx) ?? null,
        getAccountSequenceAtForObservation: async (account, idx) => {
            if (ledgerHooks.getAccountSequenceAtForObservation)
                return ledgerHooks.getAccountSequenceAtForObservation(account, idx);
            if (ledgerHooks.getAccountSequenceAt)
                try {
                    return await ledgerHooks.getAccountSequenceAt(account, idx);
                } catch {
                    return null;
                }
            if (idx === DEFAULT_ANCHOR && account === TENANT_ADDRESS)
                return DEFAULT_TENANT_SEQUENCE;
            return null;
        },
        deinit: async () => {},
        multiSigner: { isSignerNode: () => false, getSigner: () => null },
        ...(xrplOverrides || {}),
    };

    const observationPendingSubmits = [];
    const evernodeContext = {
        hpContext,
        voteContext,
        observationPendingSubmits,
        init: async () => {},
        bootstrapForRound: async () => { await defaultXrpl.bootstrapForRound(); },
        finishRoundInit: async () => {},
        deinit: async () => {},
        getAcquireDataSnapshot: () => readAcquiresFile(),
        getIfAcquired: () => null,
        getIfPending: () => null,
        acquireNode: async () => { throw new Error('acquire should not run in phase 1'); },
        extendSubmit: async () => false,
        scheduleObservationSubmitOutOfBand: (peers, hooks) => scheduleObservationSubmit(
            hpContext,
            defaultXrpl,
            peers,
            observationPendingSubmits,
            hooks,
        ),
        xrplContext: defaultXrpl,
        ...restEvernodeOverrides,
    };

    if (restEvernodeOverrides.xrplContext)
        evernodeContext.xrplContext = { ...defaultXrpl, ...restEvernodeOverrides.xrplContext };

    evernodeContext.hpContext = hpContext;
    return new ClusterContext(evernodeContext);
}

async function runClusterRound(evernodeOverrides, hpOverrides, ledgerHooks) {
    const ctx = buildClusterContext(evernodeOverrides, hpOverrides, ledgerHooks);
    await ctx.init();
    await ctx.deinit();
    return ctx;
}

module.exports = {
    DEFAULT_ANCHOR,
    DEFAULT_TENANT_SEQUENCE,
    TENANT_ADDRESS,
    consensusContract,
    writeAcquiresFile,
    readAcquiresFile,
    writeClusterFiles,
    defaultClusterNode,
    buildClusterContext,
    runClusterRound,
};
