import { FrozenRoundSnapshot } from './RoundSnapshot';
import {
    Operation,
    OperationType,
} from '../models/cluster';
import { SignerListInfo } from '../models';
import { buildLastLedgerSequenceFromSnapshot, computeExtendTxHash } from './DeterministicTx';

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

export function extendLastLedgerSequence(snap: FrozenRoundSnapshot): number {
    return buildLastLedgerSequenceFromSnapshot(snap);
}

export function isExtendComplete(op: Operation, snap: FrozenRoundSnapshot): boolean {
    if (op.type !== OperationType.EXTEND_NODE)
        return false;
    const entry = snap.extendLedgerChecks.find((e) => e.ref === op.ref);
    return !!entry?.tx && entry.tx.resultCode === 'tesSUCCESS';
}

export async function isOperationComplete(
    op: Operation,
    snap: FrozenRoundSnapshot,
    _ledger: QueueLedgerReader,
): Promise<boolean> {
    if (op.type === OperationType.EXTEND_NODE)
        return isExtendComplete(op, snap);
    return false;
}
