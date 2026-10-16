import { FrozenRoundSnapshot } from './RoundSnapshot';
import {
    ExtendNodeOperation,
    Operation,
    OperationType,
} from '../models/cluster';
import { SignerListInfo } from '../models';

export const MAX_OPERATION_ATTEMPTS = 8;
export const MAX_OPS_PER_ROUND = 1;

export function operationAttempt(operation: Operation): number {
    return operation.attempt ?? operation.retryCount ?? 0;
}

export function operationNextAttemptLcl(operation: Operation): number | undefined {
    return operation.nextAttemptLcl ?? operation.nextRetryLcl;
}

export function backoffLcl(attempt: number): number {
    return Math.min(2 ** attempt, 32);
}

export type QueueLedgerReader = {
    getTxAt(hash: string, ledgerIndex: number): Promise<{ resultCode: string; lastLedgerSequence: number } | null>;
    getSignerListAt(ledgerIndex: number): Promise<SignerListInfo | null>;
};

export function isHeldOperationType(type: OperationType): boolean {
    return type === OperationType.ADD_NODE || type === OperationType.REMOVE_NODE;
}

export async function isExtendComplete(
    op: Operation,
    snap: FrozenRoundSnapshot,
    ledger: QueueLedgerReader,
): Promise<boolean> {
    const data = op.data as ExtendNodeOperation;
    if (!data.extendTxHash || data.extendLedgerCap === undefined)
        return false;
    if (snap.anchorLedger < data.extendLedgerCap)
        return false;
    const tx = await ledger.getTxAt(data.extendTxHash, snap.anchorLedger);
    return !!tx && tx.resultCode === 'tesSUCCESS';
}

export async function isOperationComplete(
    op: Operation,
    snap: FrozenRoundSnapshot,
    ledger: QueueLedgerReader,
): Promise<boolean> {
    if (op.type === OperationType.EXTEND_NODE)
        return await isExtendComplete(op, snap, ledger);
    return false;
}
