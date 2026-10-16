const fs = require('fs');
const path = require('path');

const { buildClusterContext, writeAcquiresFile, TENANT_ADDRESS, DEFAULT_TENANT_SEQUENCE } = require('./cluster-test-helpers');
const { unlPubkey, fakeUsersCollection } = require('./consensus-input-helpers');
const { ledgerBackendFromPinned, readLedger, ledgerHashAt } = require('./shared-ledger-store');
const { buildLastLedgerSequence } = require('../../dist/cluster/DeterministicTx');
const { buildAnchorObservationPayload } = require('../../dist/observation/ObservationSubmitter');

const workRoot = process.env.EVP_WORK_ROOT;
const nodeDir = process.env.EVP_NODE_DIR;
const nodeId = process.env.EVP_NODE_ID;
const seed = Number(process.env.EVP_SEED);
const round = Number(process.env.EVP_ROUND);
const lcl = Number(process.env.EVP_LCL);
const phase = process.env.EVP_PHASE || 'exec';
const EXTEND_PUBKEY = 'sim_extend_pubkey';

function shouldFailSubmit(s, nodeIndex, r) {
    const mix = (s * 31 + nodeIndex * 17 + r * 13) % 5;
    return mix === 0 || mix === 2;
}

function inboxPath() {
    return path.join(workRoot, 'inbox', `seed-${seed}-r${round}-${nodeId}.json`);
}

function buildLocalObservation(ledgerApi, anchor, tenantSequence) {
    const validatedIndex = ledgerApi.getValidatedLedgerIndex();
    const submittedTx = ledgerApi.getPendingSubmitsForNode();
    return {
        userPublicKey: unlPubkey(Number(nodeId.replace('n', ''))),
        payload: JSON.stringify(buildAnchorObservationPayload({
            observedLcl: lcl,
            observedLclHash: process.env.EVP_LCL_HASH,
            nonce: round + 1,
            validatedIndex,
            ledgerHash: ledgerHashAt(validatedIndex),
            tenantSequence,
            signerListHash: 'sim_signer_hash',
            submittedTx,
        })),
    };
}

async function main() {
    const nodePath = path.resolve(workRoot, nodeDir);
    if (!fs.existsSync(nodePath))
        throw new Error(`Missing node dir ${nodePath}`);
    process.chdir(nodePath);
    writeAcquiresFile();
    const ledgerApi = ledgerBackendFromPinned(workRoot, round, nodeId);
    const ops = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
    const anchor = ops.anchorLedger ?? ops.agreedAnchor ?? 1_000_000;
    const tenantSequence = ops.agreedTenantSequence ?? DEFAULT_TENANT_SEQUENCE;

    if (phase === 'observe') {
        fs.mkdirSync(path.dirname(inboxPath()), { recursive: true });
        fs.writeFileSync(inboxPath(), JSON.stringify(buildLocalObservation(ledgerApi, anchor, tenantSequence)));
        return;
    }

    const consensusPath = path.join(workRoot, `consensus-inputs-r${round}.json`);
    const consensusBatch = fs.existsSync(consensusPath)
        ? JSON.parse(fs.readFileSync(consensusPath, 'utf8'))
        : null;

    const ctx = buildClusterContext({
        finishRoundInit: async () => {},
        extendSubmit: async (_host, _moments, _name, options) => {
            const liveOps = JSON.parse(fs.readFileSync('operations.json', 'utf8'));
            if (liveOps.agreedExtendResults?.[EXTEND_PUBKEY]?.resultCode === 'tesSUCCESS')
                return { hash: liveOps.agreedExtendResults[EXTEND_PUBKEY].hash };
            const seq = options?.txSubmitInfo?.sequence ?? tenantSequence;
            if (liveOps.consumedTenantSequences?.includes(seq))
                return false;
            if (shouldFailSubmit(seed, Number(nodeId.replace('n', '')), round))
                throw new Error(`sim extend fail ${nodeId} r${round}`);
            const hash = ledgerApi.realTxHash(seed, round, nodeId, seq, EXTEND_PUBKEY);
            const cap = buildLastLedgerSequence(anchor);
            ledgerApi.recordSubmitIntent({
                ref: EXTEND_PUBKEY,
                hash,
                lastLedgerSequence: cap,
                sequence: seq,
                seed,
                round,
            });
            return { hash, code: 'tesSUCCESS' };
        },
        xrplContext: {
            getValidatedLedgerIndex: () => ledgerApi.getValidatedLedgerIndex(),
            getTxAt: (h, idx) => ledgerApi.getTxAt(h, idx),
            getSignerListAt: (idx) => ledgerApi.getSignerListAt(idx),
            getAccountSequenceAt: (acc, idx) => ledgerApi.getAccountSequenceAt(acc, idx),
        },
    }, {
        lclSeqNo: lcl,
        lclHash: process.env.EVP_LCL_HASH,
        getContractConfig: async () => ({
            unl: [0, 1, 2, 3, 4].map((i) => unlPubkey(i)),
            evernode: {
                hosts: ['host.alpha', 'host.beta'],
                feeCeiling: '12000000',
                anchorLedger: anchor,
                tenantSequence: DEFAULT_TENANT_SEQUENCE,
            },
            consensus: { roundtime: 1000, stage_slice: 100 },
            max_input_ledger_offset: 32,
        }),
    });

    if (consensusBatch?.messages)
        await ctx.processConsensusUserInputs(fakeUsersCollection(consensusBatch.messages));

    await ctx.init();
    const aborted = ctx.isRoundAborted();
    await ctx.deinit();
    fs.writeFileSync(path.join(nodePath, '.evp-round-result.json'), JSON.stringify({ aborted, nodeId }));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
