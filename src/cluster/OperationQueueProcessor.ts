import { FrozenRoundSnapshot } from './RoundSnapshot';
import {
    AddNodeOperation,
    ExtendNodeOperation,
    Operation,
    OperationType,
    RemoveNodeOperation,
    RemoveNodeStep,
} from '../models/cluster';
import { SignerListInfo } from '../models';

export const MAX_OPERATION_ATTEMPTS = 8;

export function operationAttempt(operation: Operation): number {
    return operation.attempt ?? operation.retryCount ?? 0;
}

export function operationNextAttemptLcl(operation: Operation): number {
    return operation.nextAttemptLcl ?? operation.nextRetryLcl ?? 0;
}

export function backoffLcl(attempt: number): number {
    return Math.min(2 ** attempt, 32);
}

export type QueueLedgerReader = {
    getTxAt(hash: string, ledgerIndex: number): Promise<{ resultCode: string; lastLedgerSequence: number } | null>;
    getSignerListAt(ledgerIndex: number): Promise<SignerListInfo | null>;
};

export type QueueAcquireReader = {
    getLeasePending(hash: string): boolean;
};

export async function isAddComplete(
    op: Operation,
    snap: FrozenRoundSnapshot,
    ledger: QueueLedgerReader,
): Promise<boolean> {
    const data = op.data as AddNodeOperation;
    if (snap.acquireData.acquiredNodes.some((n) => n.refId === data.acquireTxHash))
        return true;
    if (snap.cluster.pendingNodes.some((p) => p.opRef === op.ref))
        return true;
    if (snap.cluster.nodes.some((n) => n.addOpRef === op.ref))
        return true;
    return false;
}

export async function isExtendComplete(
    op: Operation,
    snap: FrozenRoundSnapshot,
    ledger: QueueLedgerReader,
): Promise<boolean> {
    const data = op.data as ExtendNodeOperation;
    if (!data.extendTxHash || !data.extendLedgerCap)
        return false;
    if (snap.anchorLedger < data.extendLedgerCap)
        return false;
    const tx = await ledger.getTxAt(data.extendTxHash, snap.anchorLedger);
    return !!tx && tx.resultCode === 'tesSUCCESS';
}

export async function isRemoveComplete(op: Operation): Promise<boolean> {
    const data = op.data as RemoveNodeOperation;
    return (data.step ?? 'SIGNER') === 'DONE';
}

export async function isOperationComplete(
    op: Operation,
    snap: FrozenRoundSnapshot,
    ledger: QueueLedgerReader,
): Promise<boolean> {
    if (op.type === OperationType.ADD_NODE)
        return await isAddComplete(op, snap, ledger);
    if (op.type === OperationType.EXTEND_NODE)
        return await isExtendComplete(op, snap, ledger);
    if (op.type === OperationType.REMOVE_NODE)
        return await isRemoveComplete(op);
    return false;
}

export async function stepAdvanceAdd(op: Operation, snap: FrozenRoundSnapshot, ledger: QueueLedgerReader): Promise<void> {
    const data = op.data as AddNodeOperation;
    if (!data.acquireTxHash) {
        const pending = snap.acquireData.pendingAcquires.find((p) => p.opRef === op.ref);
        if (pending) {
            data.acquireTxHash = pending.refId;
            data.acquireLedgerCap = pending.acquireLedgerCap;
            if (pending.leaseOfferIdx)
                data.leaseOfferIdx = pending.leaseOfferIdx;
            if (pending.host)
                data.host = pending.host;
        }
        return;
    }
    if (snap.anchorLedger < (data.acquireLedgerCap || 0))
        return;
    const tx = await ledger.getTxAt(data.acquireTxHash, snap.anchorLedger);
    if (!tx || (tx.resultCode !== 'tesSUCCESS' && tx.lastLedgerSequence <= snap.anchorLedger)) {
        delete data.acquireTxHash;
        delete data.acquireLedgerCap;
    }
}

export async function stepAdvanceRemove(
    op: Operation,
    snap: FrozenRoundSnapshot,
    ledger: QueueLedgerReader,
): Promise<void> {
    const data = op.data as RemoveNodeOperation;
    const pubkey = data.nodePubkey;
    const cap = snap.anchorLedger;

    for (let i = 0; i < 4; i++) {
        const step: RemoveNodeStep = data.step ?? 'SIGNER';
        const snapNode = snap.cluster.nodes.find((n) => n.pubkey === pubkey);
        if (step === 'SIGNER') {
            const signerAddr = snapNode?.signerAddress;
            if (!signerAddr) {
                data.step = 'UNL';
                continue;
            }
            const list = cap > 0 ? await ledger.getSignerListAt(cap) : null;
            const onLedger = list?.signerList.some((s) => s.account === signerAddr) ?? false;
            if (!onLedger)
                data.step = 'UNL';
            break;
        }
        if (step === 'UNL') {
            if (!snap.unl.includes(pubkey)) {
                data.step = 'PEER';
                continue;
            }
            break;
        }
        if (step === 'PEER') {
            if (!snap.cluster.nodes.some((n) => n.pubkey === pubkey))
                data.step = 'DONE';
            break;
        }
        break;
    }
}

export async function stepAdvanceOperation(
    op: Operation,
    snap: FrozenRoundSnapshot,
    ledger: QueueLedgerReader,
): Promise<void> {
    if (op.type === OperationType.ADD_NODE)
        await stepAdvanceAdd(op, snap, ledger);
    else if (op.type === OperationType.REMOVE_NODE)
        await stepAdvanceRemove(op, snap, ledger);
}

export function shouldPerformAdd(
    op: Operation,
    snap: FrozenRoundSnapshot,
    acquire: QueueAcquireReader,
): boolean {
    const data = op.data as AddNodeOperation;
    if (data.acquireTxHash && acquire.getLeasePending(data.acquireTxHash))
        return false;
    if (snap.acquireData.pendingAcquires.some((p) => p.opRef === op.ref && p.refId))
        return false;
    return true;
}
