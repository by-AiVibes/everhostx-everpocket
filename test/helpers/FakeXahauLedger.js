const { XAHAU_NETWORK_ID } = require('../../dist/ledger/xahauConstants');

class FakeXahauLedger {
    static acquireTxCanonicalBytes(fields) {
        return Buffer.from(JSON.stringify(fields), 'utf8');
    }

    constructor() {
        this.networkID = XAHAU_NETWORK_ID;
        this.ledgers = new Map();
        this.nodeValidatedIndex = new Map();
        this.globalValidatedIndex = 0;
        this.submittedAcquires = [];
    }

    setGlobalValidatedIndex(index) {
        this.globalValidatedIndex = index;
    }

    setNodeValidatedIndex(nodeId, index) {
        this.nodeValidatedIndex.set(nodeId, index);
    }

    getNodeValidatedIndex(nodeId) {
        return this.nodeValidatedIndex.get(nodeId) ?? this.globalValidatedIndex;
    }

    getValidatedLedgerIndex() {
        return this.globalValidatedIndex;
    }

    ensureLedger(index) {
        if (!this.ledgers.has(index)) {
            const prev = this.ledgers.get(index - 1);
            this.ledgers.set(index, {
                signerList: prev?.signerList ? JSON.parse(JSON.stringify(prev.signerList)) : { signerQuorum: 1, signerList: [] },
                txs: new Map(),
            });
        }
        return this.ledgers.get(index);
    }

    putTxAt(ledgerIndex, tx) {
        const entry = this.ensureLedger(ledgerIndex);
        entry.txs.set(tx.hash, { ...tx });
    }

    setSignerListAt(ledgerIndex, info) {
        const entry = this.ensureLedger(ledgerIndex);
        entry.signerList = {
            signerQuorum: info.signerQuorum,
            signerList: info.signerList.map((s) => ({ ...s })),
        };
    }

    recordAcquireSubmit(fields, hash) {
        this.submittedAcquires.push({ fields: { ...fields }, hash });
    }

    acquireSubmitCount() {
        return this.submittedAcquires.length;
    }

    uniqueAcquireHashes() {
        return new Set(this.submittedAcquires.map((a) => a.hash));
    }

    async getTxAt(hash, ledgerIndex) {
        const validated = this.globalValidatedIndex;
        if (validated < ledgerIndex)
            throw new Error(`Xahau ledger lag: validated ${validated} < pinned ${ledgerIndex}`);
        const entry = this.ensureLedger(ledgerIndex);
        return entry.txs.get(hash) ?? null;
    }

    async getSignerListAt(ledgerIndex) {
        const validated = this.globalValidatedIndex;
        if (validated < ledgerIndex)
            throw new Error(`Xahau ledger lag: validated ${validated} < pinned ${ledgerIndex}`);
        return this.ensureLedger(ledgerIndex).signerList;
    }

    async getAccountTxAt(_account, ledgerIndexMax) {
        const txs = [];
        for (let i = 1; i <= ledgerIndexMax; i++) {
            const entry = this.ledgers.get(i);
            if (entry) {
                for (const tx of entry.txs.values())
                    txs.push({ tx: { hash: tx.hash }, meta: { TransactionResult: tx.resultCode } });
            }
        }
        return txs;
    }
}

module.exports = { FakeXahauLedger };
