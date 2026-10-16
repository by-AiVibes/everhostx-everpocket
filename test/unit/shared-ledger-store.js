const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ledgerPath(root) {
    return path.join(root, 'shared-ledger.json');
}

function pinnedPath(root, round) {
    return path.join(root, `pinned-ledger-r${round}.json`);
}

function submitPath(root, nodeId, round) {
    return path.join(root, `submit-${nodeId}-r${round}.json`);
}

function readLedger(root) {
    return JSON.parse(fs.readFileSync(ledgerPath(root), 'utf8'));
}

function writeLedger(root, data) {
    fs.writeFileSync(ledgerPath(root), JSON.stringify(data));
}

const DEFAULT_SIGNER_LIST = { signerQuorum: 1, signerList: [{ account: 'rSimSigner', weight: 1 }] };

function seedCheckpointLedgerFields(ledger, centerIndex, tenantAddress, tenantSequence, interval = 10, span = 50) {
    if (!ledger.ledgerHashes)
        ledger.ledgerHashes = {};
    if (!ledger.signerLists)
        ledger.signerLists = {};
    const base = Math.floor(centerIndex / interval) * interval;
    for (let i = -span; i <= span; i++) {
        const idx = base + i * interval;
        if (idx <= 0)
            continue;
        ledger.ledgerHashes[idx] = ledgerHashAt(idx);
        ledger.signerLists[idx] = DEFAULT_SIGNER_LIST;
        ledger.accountSequences[`${idx}:${tenantAddress}`] = tenantSequence;
    }
}

function initLedger(root, { anchor, tenantSequence, tenantAddress }) {
    const ledger = {
        globalValidatedIndex: anchor,
        nodeValidated: {},
        txs: {},
        accountSequences: {},
        signerLists: {},
        ledgerHashes: {},
        landedHashes: {},
        landedCountByRef: {},
        nodePendingSubmits: {},
    };
    seedCheckpointLedgerFields(ledger, anchor, tenantAddress, tenantSequence);
    writeLedger(root, ledger);
}

function writePinnedRound(root, round, { anchor, tenantAddress, tenantSequence }) {
    const pinned = readLedger(root);
    if (anchor && tenantAddress && tenantSequence !== undefined)
        seedCheckpointLedgerFields(pinned, anchor, tenantAddress, tenantSequence);
    fs.writeFileSync(pinnedPath(root, round), JSON.stringify(pinned));
}

function mergeSubmitIntents(root, round) {
    const ledger = readLedger(root);
    for (const file of fs.readdirSync(root)) {
        const m = file.match(/^submit-(n\d+)-r(\d+)\.json$/);
        if (!m || Number(m[2]) !== round)
            continue;
        const intent = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
        if (intent.tx)
            ledger.txs[`${intent.tx.ledgerIndex}:${intent.tx.hash}`] = intent.tx;
        fs.unlinkSync(path.join(root, file));
    }
    writeLedger(root, ledger);
}

function realTxHash(seed, round, nodeId, sequence, opRef) {
    return crypto.createHash('sha256')
        .update(`${seed}|${round}|${nodeId}|${sequence}|${opRef}`)
        .digest('hex');
}

function ledgerHashAt(index) {
    return crypto.createHash('sha256').update(`ledger-${index}`).digest('hex');
}

function ledgerBackendFromPinned(root, round, nodeId) {
    const file = pinnedPath(root, round);
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

    return {
        getValidatedLedgerIndex: () => {
            const data = read();
            return data.nodeValidated[nodeId] ?? data.globalValidatedIndex;
        },
        getTxAt: async (hash, ledgerIndex) => {
            const data = read();
            const pinnedTx = data.txs[`${ledgerIndex}:${hash}`];
            if (pinnedTx)
                return pinnedTx;
            const live = readLedger(root);
            return live.txs[`${ledgerIndex}:${hash}`] ?? null;
        },
        getSignerListAt: async (ledgerIndex) => {
            const data = read();
            return data.signerLists[ledgerIndex] ?? { signerQuorum: 1, signerList: [] };
        },
        getAccountSequenceAt: async (account, ledgerIndex) => {
            const data = read();
            const seq = data.accountSequences[`${ledgerIndex}:${account}`];
            if (seq === undefined)
                throw new Error(`No sequence at ${ledgerIndex} for ${account}`);
            return seq;
        },
        getLedgerHashAt: async (ledgerIndex) => {
            const data = read();
            return data.ledgerHashes?.[ledgerIndex] ?? null;
        },
        getPendingSubmitsForNode: () => {
            const data = read();
            return data.nodePendingSubmits[nodeId] ?? [];
        },
        recordSubmitIntent: ({ ref, hash, lastLedgerSequence, sequence, tenantAddress }) => {
            const ledger = readLedger(root);
            if ((ledger.landedCountByRef[ref] || 0) >= 1)
                return;
            if (!ledger.landedHashes[hash]) {
                ledger.landedHashes[hash] = true;
                ledger.landedCountByRef[ref] = 1;
            }
            if (tenantAddress) {
                const nextSeq = sequence + 1;
                for (const key of Object.keys(ledger.accountSequences)) {
                    if (key.endsWith(`:${tenantAddress}`))
                        ledger.accountSequences[key] = nextSeq;
                }
            }
            const tx = {
                hash,
                resultCode: 'tesSUCCESS',
                lastLedgerSequence,
                ledgerIndex: lastLedgerSequence,
                sequence,
            };
            ledger.txs[`${lastLedgerSequence}:${hash}`] = tx;
            if (!ledger.nodePendingSubmits[nodeId])
                ledger.nodePendingSubmits[nodeId] = [];
            ledger.nodePendingSubmits[nodeId].push({
                ref,
                hash,
                lastLedgerSequence,
                resultCode: 'tesSUCCESS',
            });
            writeLedger(root, ledger);
            fs.writeFileSync(submitPath(root, nodeId, round), JSON.stringify({ tx }));
        },
        ledgerHashAt,
        realTxHash,
    };
}

module.exports = {
    initLedger,
    ledgerBackendFromPinned,
    readLedger,
    writeLedger,
    writePinnedRound,
    mergeSubmitIntents,
    pinnedPath,
    realTxHash,
    ledgerHashAt,
};
