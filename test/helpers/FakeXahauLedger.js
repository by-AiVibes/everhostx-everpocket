class FakeXahauLedger {
    constructor() {
        this.globalValidatedIndex = 0;
        this.nodeValidated = new Map();
        this.txsByLedger = new Map();
        this.signerListsByLedger = new Map();
        this.acquireCanonical = new Map();
    }

    setGlobalValidatedIndex(idx) {
        this.globalValidatedIndex = idx;
    }

    setNodeValidatedIndex(nodeId, idx) {
        this.nodeValidated.set(nodeId, idx);
    }

    getValidatedLedgerIndex() {
        return this.globalValidatedIndex;
    }

    getNodeValidatedIndex(nodeId) {
        return this.nodeValidated.get(nodeId) ?? this.globalValidatedIndex;
    }

    putTxAt(ledgerIndex, tx) {
        const key = `${ledgerIndex}:${tx.hash}`;
        this.txsByLedger.set(key, { ...tx });
    }

    async getTxAt(hash, ledgerIndex) {
        const key = `${ledgerIndex}:${hash}`;
        return this.txsByLedger.get(key) ?? null;
    }

    putSignerListAt(ledgerIndex, list) {
        this.signerListsByLedger.set(ledgerIndex, list);
    }

    async getSignerListAt(ledgerIndex) {
        return this.signerListsByLedger.get(ledgerIndex) ?? { signerQuorum: 1, signerList: [] };
    }

    async getAccountTxAt() {
        return [];
    }

    recordAcquireSubmit() {
        // Sim harness hook; Phase 1 ADD path is held.
    }
}

module.exports = { FakeXahauLedger };
