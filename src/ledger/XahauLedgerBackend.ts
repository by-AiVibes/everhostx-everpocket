import { SignerListInfo } from '../models';
import { TransactionInfo } from '../models/xrpl';

export type XahauTxRecord = TransactionInfo & {
    raw?: Record<string, unknown>;
};

/**
 * Validated Xahau ledger history for pinned-index reads (spec R1c).
 * Production: backed by XrplContext / rippled at ledger_index.
 * Tests: FakeXahauLedger shared across simulated nodes.
 */
export interface XahauLedgerBackend {
    getValidatedLedgerIndex(): number;

    /** Throws if validated index < ledgerIndex (spec R3). */
    getTxAt(hash: string, ledgerIndex: number): Promise<XahauTxRecord | null>;

    getSignerListAt(ledgerIndex: number): Promise<SignerListInfo | null>;

    getAccountTxAt(account: string, ledgerIndexMax: number): Promise<unknown[]>;
}
