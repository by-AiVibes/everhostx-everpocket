const fs = require('fs');
const path = require('path');

const { buildClusterContext, writeAcquiresFile, TENANT_ADDRESS } = require('./cluster-test-helpers');
const { ledgerBackendFromPinned } = require('./shared-ledger-store');
const { computeExtendTxHash, buildLastLedgerSequence } = require('../../dist/cluster/DeterministicTx');
const { RoundSnapshot } = require('../../dist/cluster/RoundSnapshot');

const workRoot = process.env.EVP_WORK_ROOT;
const nodeDir = process.env.EVP_NODE_DIR;
const nodeId = process.env.EVP_NODE_ID;
const seed = Number(process.env.EVP_SEED);
const round = Number(process.env.EVP_ROUND);
const lcl = Number(process.env.EVP_LCL);

function shouldFailSubmit(s, nodeIndex, r) {
    const mix = (s * 31 + nodeIndex * 17 + r * 13) % 5;
    return mix === 0 || mix === 2;
}

async function buildSnapshotFromDisk(anchor, ledgerApi) {
    const config = {
        unl: [],
        evernode: { hosts: ['host.alpha', 'host.beta'], feeCeiling: '12000000', anchorLedger: anchor },
        consensus: { roundtime: 1000, stage_slice: 100 },
    };
    const operationData = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
    const clusterData = JSON.parse(fs.readFileSync('cluster.json', 'utf8'));
    const acquireData = JSON.parse(fs.readFileSync('acquires.json', 'utf8'));
    const tenantSequence = anchor > 0
        ? await ledgerApi.getAccountSequenceAt(TENANT_ADDRESS, anchor)
        : 0;
    return RoundSnapshot.capture({
        lclSeqNo: lcl,
        lclHash: process.env.EVP_LCL_HASH,
        operationData,
        clusterData,
        acquireData,
        contractUnl: config.unl,
        signerListInfo: null,
        tenantSequence,
        tenantAddress: TENANT_ADDRESS,
        feeCeiling: config.evernode.feeCeiling,
        hostList: config.evernode.hosts,
        extendLedgerChecks: [],
    });
}

async function main() {
    const nodePath = path.resolve(workRoot, nodeDir);
    if (!fs.existsSync(nodePath))
        throw new Error(`Missing node dir ${nodePath}`);
    process.chdir(nodePath);
    writeAcquiresFile();
    const ledgerApi = ledgerBackendFromPinned(workRoot, round, nodeId);
    const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
    const anchor = ops.anchorLedger;

    const ctx = buildClusterContext({
        finishRoundInit: async () => {},
        extendSubmit: async () => {
            if (shouldFailSubmit(seed, Number(nodeId.replace('n', '')), round))
                throw new Error(`sim extend fail ${nodeId} r${round}`);
            const snap = await buildSnapshotFromDisk(anchor, ledgerApi);
            const op = snap.operations.find((o) => o.type === 'extend_node');
            if (!op)
                return false;
            const hash = computeExtendTxHash(snap, op);
            const cap = buildLastLedgerSequence(anchor);
            ledgerApi.recordSubmitIntent({
                ledgerIndex: cap,
                hash,
                resultCode: 'tesSUCCESS',
                lastLedgerSequence: cap,
            });
            return { hash };
        },
        xrplContext: {
            deriveTxSubmitInfo: (snap) => {
                const { readFeeCeiling, readTenantSequence, buildLastLedgerSequenceFromSnapshot } = require('../../dist/cluster/DeterministicTx');
                return {
                    sequence: readTenantSequence(snap),
                    maxLedgerSequence: buildLastLedgerSequenceFromSnapshot(snap),
                    fee: readFeeCeiling(snap),
                };
            },
            getValidatedLedgerIndex: () => ledgerApi.getValidatedLedgerIndex(),
            getTxAt: (h, idx) => ledgerApi.getTxAt(h, idx),
            getSignerListAt: (idx) => ledgerApi.getSignerListAt(idx),
            getAccountSequenceAt: (acc, idx) => ledgerApi.getAccountSequenceAt(acc, idx),
        },
    }, {
        lclSeqNo: lcl,
        lclHash: process.env.EVP_LCL_HASH,
        getContractConfig: async () => ({
            unl: [],
            evernode: { hosts: ['host.alpha', 'host.beta'], feeCeiling: '12000000', anchorLedger: anchor },
            consensus: { roundtime: 1000, stage_slice: 100 },
        }),
    });

    await ctx.init();
    const aborted = ctx.isRoundAborted();
    await ctx.deinit();
    fs.writeFileSync(path.join(nodePath, '.evp-round-result.json'), JSON.stringify({ aborted, nodeId }));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
