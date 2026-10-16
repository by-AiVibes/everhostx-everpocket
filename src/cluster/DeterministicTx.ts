import { createHash } from 'crypto';
import { FrozenRoundSnapshot } from './RoundSnapshot';
import { ExtendNodeOperation, Operation } from '../models/cluster';

/** LastLedgerSequence window above agreed anchor ledger. */
export const LLS_LEDGER_WINDOW = 30;

export function readAnchorLedger(snap: FrozenRoundSnapshot): number {
    return snap.anchorLedger;
}

export function buildLastLedgerSequence(anchorLedger: number): number {
    return anchorLedger + LLS_LEDGER_WINDOW;
}

export function buildLastLedgerSequenceFromSnapshot(snap: FrozenRoundSnapshot): number {
    return buildLastLedgerSequence(readAnchorLedger(snap));
}

export function readFeeCeiling(snap: FrozenRoundSnapshot): string {
    return snap.feeCeiling;
}

export function readTenantSequence(snap: FrozenRoundSnapshot): number {
    return snap.tenantSequence;
}

export function pickHostForOpRef(snap: FrozenRoundSnapshot, opRef: string): string {
    const hosts = [...snap.hostList].sort();
    if (hosts.length === 0)
        throw new Error('No hosts in round snapshot');
    const digest = createHash('sha256').update(snap.lclHash).update(opRef).digest();
    const idx = digest.readUInt32BE(0) % hosts.length;
    return hosts[idx];
}

export function extendTxFields(snap: FrozenRoundSnapshot): {
    sequence: number;
    lastLedgerSequence: number;
    fee: string;
} {
    return {
        sequence: readTenantSequence(snap),
        lastLedgerSequence: buildLastLedgerSequenceFromSnapshot(snap),
        fee: readFeeCeiling(snap),
    };
}

export function snapExtendData(snap: FrozenRoundSnapshot, opRef: string): ExtendNodeOperation | null {
    const op = snap.operations.find((o) => o.ref === opRef && o.type === 'extend_node');
    return op ? (op.data as ExtendNodeOperation) : null;
}

export function extendTxCanonicalFields(
    snap: FrozenRoundSnapshot,
    operation: Operation,
): Record<string, string | number> {
    const data = operation.data as ExtendNodeOperation;
    const snapNode = snap.cluster.nodes.find((n) => n.pubkey === data.nodePubkey);
    if (!snapNode?.name)
        throw new Error('Missing lease token id in round snapshot');
    const tx = extendTxFields(snap);
    return {
        account: snap.tenantAddress,
        sequence: tx.sequence,
        lastLedgerSequence: tx.lastLedgerSequence,
        fee: tx.fee,
        host: pickHostForOpRef(snap, operation.ref),
        nodePubkey: data.nodePubkey,
        moments: data.moments,
        tokenId: snapNode.name,
    };
}

export function computeExtendTxHash(snap: FrozenRoundSnapshot, operation: Operation): string {
    const canonical = extendTxCanonicalFields(snap, operation);
    const keys = Object.keys(canonical).sort();
    const ordered: Record<string, string | number> = {};
    for (const k of keys)
        ordered[k] = canonical[k];
    return `0x${createHash('sha256').update(JSON.stringify(ordered)).digest('hex')}`;
}
