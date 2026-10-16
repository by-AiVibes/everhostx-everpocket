import { createHash } from 'crypto';
import * as kp from 'ripple-keypairs';
import { FrozenRoundSnapshot } from './RoundSnapshot';
import { AddNodeOperation } from '../models/cluster';

export const LLS_LEDGER_WINDOW = 30;
export const DEFAULT_FEE_CEILING = '12000000';

export function deriveAnchorLedger(snap: FrozenRoundSnapshot): number {
    return snap.anchorLedger;
}

export function deriveLastLedgerSequence(snap: FrozenRoundSnapshot): number {
    return snap.anchorLedger + LLS_LEDGER_WINDOW;
}

export function deriveFee(snap: FrozenRoundSnapshot): string {
    return snap.feeCeiling || DEFAULT_FEE_CEILING;
}

export function deriveSequence(snap: FrozenRoundSnapshot): number {
    return snap.tenantSequence;
}

export function deriveHost(snap: FrozenRoundSnapshot, opRef: string): string {
    const hosts = [...snap.hostList].sort();
    if (hosts.length === 0)
        throw new Error('No hosts in snapshot');
    const h = createHash('sha256').update(`${snap.lclHash}|${opRef}`).digest();
    const idx = h.readUInt32BE(0) % hosts.length;
    return hosts[idx];
}

/** Deterministic message public key (never uses lclHash). */
export function deriveMessageKeypair(snap: FrozenRoundSnapshot, opRef: string): { publicKey: string; privateKey: string } {
    const entropy = createHash('sha256')
        .update(`everpocket-msg|${opRef}|${snap.anchorLedger}|${snap.tenantSequence}|${snap.lclSeqNo}`)
        .digest();
    const seed = kp.generateSeed({ entropy: new Uint8Array(entropy.subarray(0, 16)) });
    const pair = kp.deriveKeypair(seed);
    return { publicKey: pair.publicKey, privateKey: pair.privateKey };
}

export function deriveMessagePublicKey(snap: FrozenRoundSnapshot, opRef: string): string {
    return deriveMessageKeypair(snap, opRef).publicKey;
}

export function computeAcquireTxHash(
    fields: ReturnType<typeof acquireTxCanonicalFields>,
    leaseOfferIdx: string,
): string {
    const payload = JSON.stringify({ ...fields, leaseOfferIdx });
    return `0x${createHash('sha256').update(payload).digest('hex')}`;
}

export function lowestUnlPubkey(snap: FrozenRoundSnapshot): string | null {
    const keys = [...snap.unl].sort();
    return keys.length ? keys[0] : null;
}

export function snapAddData(snap: FrozenRoundSnapshot, opRef: string): AddNodeOperation | null {
    const op = snap.operations.find((o) => o.ref === opRef && o.type === 'add_node');
    return op ? (op.data as AddNodeOperation) : null;
}

export function deriveReplacementSignerKeypair(snap: FrozenRoundSnapshot, removePubkey: string, candidatePubkey: string): { account: string; secret: string } {
    const entropy = createHash('sha256')
        .update(`everpocket-signer|${removePubkey}|${candidatePubkey}|${snap.anchorLedger}|${snap.tenantSequence}`)
        .digest();
    const seed = kp.generateSeed({ entropy: new Uint8Array(entropy.subarray(0, 16)) });
    const pair = kp.deriveKeypair(seed);
    return { account: kp.deriveAddress(pair.publicKey), secret: pair.privateKey };
}

export function acquireTxCanonicalFields(snap: FrozenRoundSnapshot, opRef: string, messagePublicKey: string): {
    sequence: number;
    lastLedgerSequence: number;
    fee: string;
    account: string;
    messagePublicKey: string;
    host: string;
} {
    return {
        sequence: deriveSequence(snap),
        lastLedgerSequence: deriveLastLedgerSequence(snap),
        fee: deriveFee(snap),
        account: snap.tenantAddress,
        messagePublicKey,
        host: deriveHost(snap, opRef),
    };
}
