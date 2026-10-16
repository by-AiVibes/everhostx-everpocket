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
import { deriveMessagePublicKey } from './DeterministicTx';

export const MAX_OPERATION_ATTEMPTS = 8;

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

export async function isAddComplete(
    op: Operation,
    snap: FrozenRoundSnapshot,
    ledger: QueueLedgerReader,
): Promise<boolean> {
    const data = op.data as AddNodeOperation;
    const hash = data.acquireTxHash;
    if (hash && snap.acquireData.acquiredNodes.some((n) => n.refId === hash))
        return true;
    if (!hash || !data.acquireLedgerCap || snap.anchorLedger < data.acquireLedgerCap)
        return false;
    const tx = await ledger.getTxAt(hash, snap.anchorLedger);
    if (!tx)
        return false;
    if (tx.resultCode === 'tesSUCCESS')
        return false;
    return tx.lastLedgerSequence <= snap.anchorLedger;
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
    if (!data.messagePublicKey)
        data.messagePublicKey = deriveMessagePublicKey(snap, op.ref);

    const pending = snap.acquireData.pendingAcquires.find((p) => p.opRef === op.ref);
    if (!data.acquireTxHash && pending?.refId) {
        data.acquireTxHash = pending.refId;
        data.acquireLedgerCap = pending.acquireLedgerCap;
    }

    if (data.acquireTxHash && data.acquireLedgerCap && snap.anchorLedger >= data.acquireLedgerCap) {
        const tx = await ledger.getTxAt(data.acquireTxHash, snap.anchorLedger);
        if (!tx || (tx.resultCode !== 'tesSUCCESS' && tx.lastLedgerSequence <= snap.anchorLedger)) {
            delete data.acquireTxHash;
            delete data.acquireLedgerCap;
        }
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
            const list = await ledger.getSignerListAt(cap);
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

export function shouldPerformAdd(op: Operation, snap: FrozenRoundSnapshot): boolean {
    const snapOp = snap.operations.find((o) => o.ref === op.ref && o.type === OperationType.ADD_NODE);
    const snapData = snapOp?.data as AddNodeOperation | undefined;
    if (!snapData?.messagePublicKey)
        return false;
    const data = op.data as AddNodeOperation;
    if (data.acquireTxHash)
        return false;
    if (snap.acquireData.pendingAcquires.some((p) => p.opRef === op.ref))
        return false;
    return true;
}
