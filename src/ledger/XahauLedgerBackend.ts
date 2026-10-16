import { SignerListInfo } from '../models';
import { TransactionInfo } from '../models/xrpl';

export type XahauTxRecord = TransactionInfo & {
    raw?: Record<string, unknown>;
};

/**
 * Validated Xahau ledger history for pinned-index reads.
 * Production: backed by XrplContext / rippled at ledger_index.
 * Tests: FakeXahauLedger in test/.
 */
export interface XahauLedgerBackend {
    getValidatedLedgerIndex(): number;

    getTxAt(hash: string, ledgerIndex: number): Promise<XahauTxRecord | null>;

    getSignerListAt(ledgerIndex: number): Promise<SignerListInfo | null>;

    getAccountSequenceAt(account: string, ledgerIndex: number): Promise<number>;

    getAccountTxAt(account: string, ledgerIndexMax: number): Promise<unknown[]>;
}
