import { Buffer } from 'buffer';
import { SignerListInfo } from '../models';
import { XahauLedgerBackend, XahauTxRecord } from './XahauLedgerBackend';
import { XAHAU_NETWORK_ID } from './xahauConstants';

type LedgerEntry = {
    signerList: SignerListInfo | null;
    txs: Map<string, XahauTxRecord>;
};

/**
 * In-process Xahau ledger model (networkID {@link XAHAU_NETWORK_ID}) for multi-node sims.
 * Each simulated node may lag `validatedIndex` independently.
 */
export class FakeXahauLedger implements XahauLedgerBackend {
    readonly networkID = XAHAU_NETWORK_ID;
    private ledgers = new Map<number, LedgerEntry>();
    private nodeValidatedIndex = new Map<string, number>();
    private globalValidatedIndex = 0;

    setGlobalValidatedIndex(index: number): void {
        this.globalValidatedIndex = index;
    }

    setNodeValidatedIndex(nodeId: string, index: number): void {
        this.nodeValidatedIndex.set(nodeId, index);
    }

    getNodeValidatedIndex(nodeId: string): number {
        return this.nodeValidatedIndex.get(nodeId) ?? this.globalValidatedIndex;
    }

    getValidatedLedgerIndex(): number {
        return this.globalValidatedIndex;
    }

    ensureLedger(index: number): LedgerEntry {
        if (!this.ledgers.has(index)) {
            const prev = this.ledgers.get(index - 1);
            this.ledgers.set(index, {
                signerList: prev?.signerList ? {
                    signerQuorum: prev.signerList.signerQuorum,
                    signerList: prev.signerList.signerList.map((s) => ({ ...s })),
                } : { signerQuorum: 1, signerList: [] },
                txs: new Map(),
            });
        }
        return this.ledgers.get(index)!;
    }

    putTxAt(ledgerIndex: number, tx: XahauTxRecord): void {
        const entry = this.ensureLedger(ledgerIndex);
        entry.txs.set(tx.hash, { ...tx });
    }

    setSignerListAt(ledgerIndex: number, info: SignerListInfo): void {
        const entry = this.ensureLedger(ledgerIndex);
        entry.signerList = {
            signerQuorum: info.signerQuorum,
            signerList: info.signerList.map((s) => ({ ...s })),
        };
    }

    private assertCanRead(ledgerIndex: number, nodeId?: string): void {
        const validated = nodeId ? this.getNodeValidatedIndex(nodeId) : this.globalValidatedIndex;
        if (validated < ledgerIndex) {
            throw new Error(`Xahau ledger lag: validated ${validated} < pinned ${ledgerIndex}`);
        }
    }

    async getTxAt(hash: string, ledgerIndex: number): Promise<XahauTxRecord | null> {
        this.assertCanRead(ledgerIndex);
        const entry = this.ensureLedger(ledgerIndex);
        return entry.txs.get(hash) ?? null;
    }

    async getSignerListAt(ledgerIndex: number): Promise<SignerListInfo | null> {
        this.assertCanRead(ledgerIndex);
        return this.ensureLedger(ledgerIndex).signerList;
    }

    async getAccountTxAt(_account: string, ledgerIndexMax: number): Promise<unknown[]> {
        this.assertCanRead(ledgerIndexMax);
        const txs: unknown[] = [];
        for (let i = 1; i <= ledgerIndexMax; i++) {
            const entry = this.ledgers.get(i);
            if (entry) {
                for (const tx of entry.txs.values()) {
                    txs.push({ tx: tx.raw ?? { hash: tx.hash }, meta: { TransactionResult: tx.resultCode } });
                }
            }
        }
        return txs;
    }

    /** For tests: canonical bytes identity of an acquire submission. */
    static acquireTxCanonicalBytes(fields: {
        sequence: number;
        lastLedgerSequence: number;
        fee: string;
        account: string;
        memos?: unknown[];
    }): Buffer {
        return Buffer.from(JSON.stringify(fields));
    }
}
