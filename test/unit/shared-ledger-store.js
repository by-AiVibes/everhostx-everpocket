const fs = require('fs');
const path = require('path');

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

function initLedger(root, { anchor, tenantSequence, tenantAddress }) {
    writeLedger(root, {
        globalValidatedIndex: anchor,
        nodeValidated: {},
        txs: {},
        accountSequences: { [`${anchor}:${tenantAddress}`]: tenantSequence },
        signerLists: {},
    });
}

function writePinnedRound(root, round, { anchor, tenantAddress, tenantSequence }) {
    const pinned = readLedger(root);
    if (anchor && tenantAddress && tenantSequence !== undefined)
        pinned.accountSequences[`${anchor}:${tenantAddress}`] = tenantSequence;
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
            return data.txs[`${ledgerIndex}:${hash}`] ?? null;
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
        recordSubmitIntent: (tx) => {
            fs.writeFileSync(submitPath(root, nodeId, round), JSON.stringify({ tx }));
        },
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
};
