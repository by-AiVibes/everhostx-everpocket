import { FrozenRoundSnapshot } from './RoundSnapshot';
import { ExtendLedgerCheck } from './RoundSnapshot';
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
    tenantAddress: string;
    sequence: number;
    lastLedgerSequence: number;
    fee: string;
    host: string;
    anchorLedger: number;
    nodePubkey: string;
    moments: number;
    tokenId: string;
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
    const data = operation.data as ExtendNodeOperation;
    const snapNode = snap.cluster.nodes.find((n) => n.pubkey === data.nodePubkey);
    if (!snapNode?.name)
        throw new Error('Missing lease token id for extend pin');
    const host = pickHostForOpRef(snap, operation.ref);
    const sequence = nextExtendSequenceForPin(operationData, snap);
    return {
        tenantAddress: snap.tenantAddress,
        sequence,
        lastLedgerSequence: buildLastLedgerSequenceFromSnapshot(snap),
        fee: readFeeCeiling(snap),
        host,
        anchorLedger: snap.anchorLedger,
        nodePubkey: data.nodePubkey,
        moments: data.moments,
        tokenId: snapNode.name,
    };
}

export function getPinnedExtendTx(operationData: OperationData, opRef: string): PinnedExtendTx | undefined {
    return operationData.pinnedExtendTxs?.[opRef];
}

export function shouldRepinPinnedExtend(
    operationData: OperationData,
    pin: PinnedExtendTx,
    anchorLedger: number,
    opRef: string,
): boolean {
    if (anchorLedger > pin.anchorLedger)
        return true;
    if (pin.lastLedgerSequence >= anchorLedger)
        return false;
    const agreedResult = operationData.agreedExtendResults?.[opRef];
    if (agreedResult?.resultCode === 'tesSUCCESS' && agreedResult.lastLedgerSequence === pin.lastLedgerSequence)
        return false;
    const agreed = operationData.agreedTenantSequence;
    if (agreed === undefined)
        return true;
    if (agreed > pin.sequence)
        return false;
    return true;
}

export function findInFlightExtendRef(operationData: OperationData, _anchorLedger: number): string | null {
    for (const op of operationData.operations) {
        if (op.type !== OperationType.EXTEND_NODE || op.extendHoldReason)
            continue;
        return op.ref;
    }
    return null;
}

export function quorumExtendFieldsAgree(operationData: OperationData, operation: Operation): boolean {
    const pin = getPinnedExtendTx(operationData, operation.ref);
    if (!pin)
        return false;
    const agreed = operationData.agreedExtendResults?.[operation.ref];
    if (!agreed || agreed.resultCode !== 'tesSUCCESS')
        return false;
    if (agreed.lastLedgerSequence !== pin.lastLedgerSequence)
        return false;
    const data = operation.data as ExtendNodeOperation;
    return data.nodePubkey === pin.nodePubkey && data.moments === pin.moments;
}

export function quorumExtendCompletesOp(operationData: OperationData, operation: Operation): boolean {
    if (!quorumExtendFieldsAgree(operationData, operation))
        return false;
    const pin = getPinnedExtendTx(operationData, operation.ref);
    if (!pin)
        return false;
    const attempt = operation.attempt !== undefined ? operation.attempt : 0;
    const observedSeq = operationData.observedTenantSequenceQuorum;
    const observedConsumed = observedSeq !== undefined && observedSeq === pin.sequence + 1;
    if (observedConsumed && (attempt > 0 || operationData.anchorQuorumStalled))
        return true;
    if (operationData.anchorQuorumStalled)
        return false;
    const tenantSeq = operationData.agreedTenantSequence;
    return tenantSeq !== undefined && tenantSeq > pin.sequence;
}

export function detectPinnedExtendConflict(
    operationData: OperationData,
    operation: Operation,
): string | null {
    const pin = getPinnedExtendTx(operationData, operation.ref);
    if (!pin)
        return null;
    const agreed = operationData.agreedExtendResults?.[operation.ref];
    if (agreed?.resultCode === 'tesSUCCESS' && agreed.lastLedgerSequence !== pin.lastLedgerSequence)
        return `quorum extend LLS ${agreed.lastLedgerSequence} != pin ${pin.lastLedgerSequence}`;
    const consumed = operationData.consumedTenantSequences || [];
    if (consumed.includes(pin.sequence)) {
        if (!agreed || agreed.resultCode !== 'tesSUCCESS')
            return `tenant sequence ${pin.sequence} consumed without quorum tesSUCCESS for ${operation.ref}`;
        const data = operation.data as ExtendNodeOperation;
        if (data.nodePubkey !== pin.nodePubkey || data.moments !== pin.moments)
            return `quorum extend consumed sequence ${pin.sequence} with non-matching op fields`;
    }
    return null;
}

export function buildExtendLedgerChecksFromQuorum(
    operationData: OperationData,
    operations: Operation[],
): ExtendLedgerCheck[] {
    const checks: ExtendLedgerCheck[] = [];
    for (const op of operations) {
        if (op.type !== OperationType.EXTEND_NODE)
            continue;
        const pin = getPinnedExtendTx(operationData, op.ref);
        const agreed = operationData.agreedExtendResults?.[op.ref];
        let tx = null;
        if (quorumExtendCompletesOp(operationData, op) && agreed) {
            tx = {
                hash: agreed.hash,
                resultCode: 'tesSUCCESS',
                lastLedgerSequence: agreed.lastLedgerSequence,
            };
        }
        let hash = '';
        if (agreed)
            hash = agreed.hash;
        let lastLedgerSequence = 0;
        if (pin)
            lastLedgerSequence = pin.lastLedgerSequence;
        else if (agreed)
            lastLedgerSequence = agreed.lastLedgerSequence;
        checks.push({
            ref: op.ref,
            hash,
            lastLedgerSequence,
            tx,
        });
    }
    return checks;
}

export function ensurePinnedExtendTx(
    operationData: OperationData,
    operation: Operation,
    snapshot: FrozenRoundSnapshot,
): PinnedExtendTx | null {
    if (!operationData.pinnedExtendTxs)
        operationData.pinnedExtendTxs = {};

    let pin: PinnedExtendTx | undefined = operationData.pinnedExtendTxs[operation.ref];
    if (pin && shouldRepinPinnedExtend(operationData, pin, snapshot.anchorLedger, operation.ref)) {
        delete operationData.pinnedExtendTxs[operation.ref];
        if (operationData.agreedExtendResults)
            delete operationData.agreedExtendResults[operation.ref];
        clearExtendSubmitVotesForOp(operationData, operation.ref);
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

function clearExtendSubmitVotesForOp(operationData: OperationData, opRef: string): void {
    if (!operationData.observationDedup)
        return;
    for (const [unl, dedup] of Object.entries(operationData.observationDedup)) {
        if (dedup.extendSubmitVote?.opRef === opRef) {
            const { extendSubmitVote, ...rest } = dedup;
            operationData.observationDedup[unl] = rest;
        }
    }
}

export function clearPinnedExtendTx(operationData: OperationData, opRef: string): void {
    if (operationData.pinnedExtendTxs)
        delete operationData.pinnedExtendTxs[opRef];
    clearExtendSubmitVotesForOp(operationData, opRef);
    if (operationData.agreedExtendResults)
        delete operationData.agreedExtendResults[opRef];
}
