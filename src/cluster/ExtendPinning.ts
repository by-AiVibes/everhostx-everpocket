import { createHash } from 'crypto';
import { FrozenRoundSnapshot } from './RoundSnapshot';
import {
    ExtendNodeOperation,
    Operation,
    OperationData,
    OperationType,
} from '../models/cluster';
import {
    buildLastLedgerSequenceFromSnapshot,
    pickHostForOpRef,
    readFeeCeiling,
    readTenantSequence,
} from './DeterministicTx';

export interface PinnedExtendTx {
    sequence: number;
    lastLedgerSequence: number;
    fee: string;
    host: string;
    txHash: string;
    anchorLedger: number;
}

export function extendCanonicalFromPin(
    snap: FrozenRoundSnapshot,
    operation: Operation,
    pin: PinnedExtendTx,
): Record<string, string | number> {
    const data = operation.data as ExtendNodeOperation;
    const snapNode = snap.cluster.nodes.find((n) => n.pubkey === data.nodePubkey);
    if (!snapNode?.name)
        throw new Error('Missing lease token id in round snapshot');
    return {
        account: snap.tenantAddress,
        sequence: pin.sequence,
        lastLedgerSequence: pin.lastLedgerSequence,
        fee: pin.fee,
        host: pin.host,
        nodePubkey: data.nodePubkey,
        moments: data.moments,
        tokenId: snapNode.name,
    };
}

export function hashExtendCanonical(canonical: Record<string, string | number>): string {
    const keys = Object.keys(canonical).sort();
    const ordered: Record<string, string | number> = {};
    for (const k of keys)
        ordered[k] = canonical[k];
    return `0x${createHash('sha256').update(JSON.stringify(ordered)).digest('hex')}`;
}

export function nextExtendSequenceForPin(operationData: OperationData, snap: FrozenRoundSnapshot): number {
    let seq = readTenantSequence(snap);
    const consumed = operationData.consumedTenantSequences || [];
    while (consumed.includes(seq))
        seq++;
    return seq;
}

export function buildPinnedExtendTx(
    snap: FrozenRoundSnapshot,
    operation: Operation,
    operationData: OperationData,
): PinnedExtendTx {
    const host = pickHostForOpRef(snap, operation.ref);
    const sequence = nextExtendSequenceForPin(operationData, snap);
    const canonical = {
        account: snap.tenantAddress,
        sequence,
        lastLedgerSequence: buildLastLedgerSequenceFromSnapshot(snap),
        fee: readFeeCeiling(snap),
        host,
        nodePubkey: (operation.data as ExtendNodeOperation).nodePubkey,
        moments: (operation.data as ExtendNodeOperation).moments,
        tokenId: snap.cluster.nodes.find((n) => n.pubkey === (operation.data as ExtendNodeOperation).nodePubkey)?.name ?? '',
    };
    if (!canonical.tokenId)
        throw new Error('Missing lease token id for extend pin');
    const txHash = hashExtendCanonical(canonical);
    return {
        sequence: canonical.sequence,
        lastLedgerSequence: canonical.lastLedgerSequence,
        fee: canonical.fee,
        host,
        txHash,
        anchorLedger: snap.anchorLedger,
    };
}

export function getPinnedExtendTx(operationData: OperationData, opRef: string): PinnedExtendTx | undefined {
    return operationData.pinnedExtendTxs?.[opRef];
}

export function shouldRepinPinnedExtend(
    operationData: OperationData,
    pin: PinnedExtendTx,
    anchorLedger: number,
): boolean {
    if (pin.lastLedgerSequence >= anchorLedger)
        return false;
    const agreed = operationData.agreedTenantSequence;
    if (agreed === undefined)
        return true;
    return agreed <= pin.sequence;
}

export function findInFlightExtendRef(operationData: OperationData, anchorLedger: number): string | null {
    const pins = operationData.pinnedExtendTxs;
    if (!pins)
        return null;
    for (const op of operationData.operations) {
        if (op.type !== OperationType.EXTEND_NODE || op.extendHoldReason)
            continue;
        const pin = pins[op.ref];
        if (!pin)
            continue;
        if (pin.lastLedgerSequence < anchorLedger)
            continue;
        return op.ref;
    }
    return null;
}

export function detectPinnedExtendConflict(
    operationData: OperationData,
    operation: Operation,
): string | null {
    const pin = getPinnedExtendTx(operationData, operation.ref);
    if (!pin)
        return null;
    const agreed = operationData.agreedTenantSequence;
    if (agreed === undefined || agreed <= pin.sequence)
        return null;
    const agreedResult = operationData.agreedExtendResults?.[operation.ref];
    if (agreedResult?.resultCode === 'tesSUCCESS' && agreedResult.hash !== pin.txHash)
        return `pinned sequence ${pin.sequence} consumed by quorum tx ${agreedResult.hash}`;
    return null;
}

/**
 * Create or return the agreed pin for this op. Returns null when another extend is in flight.
 */
export function ensurePinnedExtendTx(
    operationData: OperationData,
    operation: Operation,
    snapshot: FrozenRoundSnapshot,
): PinnedExtendTx | null {
    if (!operationData.pinnedExtendTxs)
        operationData.pinnedExtendTxs = {};

    let pin: PinnedExtendTx | undefined = operationData.pinnedExtendTxs[operation.ref];
    if (pin && shouldRepinPinnedExtend(operationData, pin, snapshot.anchorLedger)) {
        delete operationData.pinnedExtendTxs[operation.ref];
        pin = undefined;
    }
    if (pin)
        return pin;

    const inFlight = findInFlightExtendRef(operationData, snapshot.anchorLedger);
    if (inFlight && inFlight !== operation.ref)
        return null;

    pin = buildPinnedExtendTx(snapshot, operation, operationData);
    operationData.pinnedExtendTxs[operation.ref] = pin;
    return pin;
}

export function clearPinnedExtendTx(operationData: OperationData, opRef: string): void {
    if (operationData.pinnedExtendTxs)
        delete operationData.pinnedExtendTxs[opRef];
}
