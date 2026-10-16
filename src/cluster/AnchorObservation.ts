import { Buffer } from 'buffer';
import { OperationData } from '../models/cluster';
import * as kp from 'ripple-keypairs';

export const ANCHOR_OBSERVATION_MESSAGE_TYPE = 'anchor_observation';
export const NODE_USER_REGISTER_MESSAGE_TYPE = 'node_user_register';

export interface SubmittedTxObservation {
    ref: string;
    hash: string;
    lastLedgerSequence: number;
    resultCode: string;
}

export interface ObservationCheckpointFields {
    validatedIndex: number;
    ledgerHash: string;
    tenantSequence: number;
    signerListHash: string;
}

export interface AnchorObservationPayload {
    type: typeof ANCHOR_OBSERVATION_MESSAGE_TYPE;
    observedLcl: number;
    observedLclHash: string;
    nonce: number;
    validatedIndex: number;
    ledgerHash: string;
    tenantSequence: number;
    signerListHash: string;
    submittedTx: SubmittedTxObservation[];
    /** Recent deterministic checkpoint indices (multiples of checkpoint interval). */
    checkpoints?: ObservationCheckpointFields[];
}

export interface NodeUserRegisterPayload {
    type: typeof NODE_USER_REGISTER_MESSAGE_TYPE;
    unlPubkey: string;
    userPubkey: string;
    signature: string;
}

export type AnchorUserMessage = AnchorObservationPayload | NodeUserRegisterPayload;

export interface ParsedObservation {
    unlPubkey: string;
    userPubkey: string;
    observedLcl: number;
    nonce: number;
    validatedIndex: number;
    ledgerHash: string;
    tenantSequence: number;
    signerListHash: string;
    submittedTx: SubmittedTxObservation[];
}

export interface AnchorQuorumResult {
    anchorLedger: number;
    ledgerHash: string;
    tenantSequence: number;
    signerListHash: string;
    agreedExtendResults: Record<string, { hash: string; lastLedgerSequence: number; resultCode: string }>;
}

export function quorumThreshold(unlSize: number): number {
    if (unlSize <= 0)
        return Number.MAX_SAFE_INTEGER;
    return Math.ceil((2 / 3) * unlSize);
}

function canonicalRegisterPayload(unlPubkey: string, userPubkey: string): string {
    return JSON.stringify({ unlPubkey, userPubkey });
}

export function verifyNodeUserRegistration(payload: NodeUserRegisterPayload): boolean {
    if (!payload.unlPubkey || !payload.userPubkey || !payload.signature)
        return false;
    try {
        const messageHex = Buffer.from(canonicalRegisterPayload(payload.unlPubkey, payload.userPubkey)).toString('hex');
        return kp.verify(messageHex, payload.signature, payload.unlPubkey);
    } catch {
        return false;
    }
}

export function resolveUnlPubkeyForUser(
    userPubkey: string,
    contractUnl: string[],
    operationData: OperationData,
): string | null {
    const normalizedUnl = contractUnl.map((k) => k.toLowerCase());
    if (normalizedUnl.includes(userPubkey.toLowerCase()))
        return contractUnl.find((k) => k.toLowerCase() === userPubkey.toLowerCase()) || userPubkey;

    const reg = operationData.nodeUserRegistrations?.[userPubkey];
    if (reg && normalizedUnl.includes(reg.toLowerCase()))
        return reg;
    return null;
}

export function parseAnchorUserMessage(raw: Buffer | string): AnchorUserMessage | null {
    try {
        const obj = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as AnchorUserMessage;
        if (!obj || typeof obj !== 'object' || !obj.type)
            return null;
        return obj;
    } catch {
        return null;
    }
}

function countBy<T>(items: T[], keyFn: (t: T) => string): Map<string, number> {
    const m = new Map<string, number>();
    for (const item of items) {
        const k = keyFn(item);
        m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
}

function modeWithQuorum(values: string[], quorum: number): string | null {
    const counts = countBy(values, (v) => v);
    let best: string | null = null;
    let bestCount = 0;
    for (const [v, c] of counts) {
        if (c >= quorum && c > bestCount) {
            best = v;
            bestCount = c;
        }
    }
    return best;
}

export function isObservationStale(observedLcl: number, currentLcl: number, maxInputLedgerOffset: number): boolean {
    return observedLcl < currentLcl - maxInputLedgerOffset;
}

export function acceptObservationDedup(
    operationData: OperationData,
    unlPubkey: string,
    observedLcl: number,
    nonce: number,
): boolean {
    if (!operationData.observationDedup)
        operationData.observationDedup = {};
    const prev = operationData.observationDedup[unlPubkey];
    if (prev) {
        if (nonce <= prev.nonce)
            return false;
        if (observedLcl < prev.observedLcl)
            return false;
    }
    operationData.observationDedup[unlPubkey] = { nonce, observedLcl };
    return true;
}

function selectAnchorCandidate(observations: ParsedObservation[], quorum: number): { index: number; hash: string } | null {
    const indexToObs = new Map<number, ParsedObservation[]>();
    for (const o of observations) {
        if (!indexToObs.has(o.validatedIndex))
            indexToObs.set(o.validatedIndex, []);
        indexToObs.get(o.validatedIndex)!.push(o);
    }

    const candidates: { index: number; hash: string }[] = [];
    for (const [index, list] of indexToObs) {
        const hashCounts = countBy(list, (o) => o.ledgerHash);
        for (const [hash, count] of hashCounts) {
            if (count >= quorum)
                candidates.push({ index, hash });
        }
    }
    if (!candidates.length)
        return null;

    candidates.sort((a, b) => a.index - b.index);
    const median = candidates[Math.floor((candidates.length - 1) / 2)];
    const atMedian = observations.filter((o) => o.validatedIndex === median.index);
    const hashAtMedian = modeWithQuorum(atMedian.map((o) => o.ledgerHash), quorum);
    if (hashAtMedian)
        return { index: median.index, hash: hashAtMedian };

    return candidates[0];
}

function mergeAgreedExtendResults(observations: ParsedObservation[], quorum: number): Record<string, { hash: string; lastLedgerSequence: number; resultCode: string }> {
    const out: Record<string, { hash: string; lastLedgerSequence: number; resultCode: string }> = {};
    const byRef = new Map<string, SubmittedTxObservation[]>();
    for (const o of observations) {
        for (const tx of o.submittedTx || []) {
            if (!byRef.has(tx.ref))
                byRef.set(tx.ref, []);
            byRef.get(tx.ref)!.push(tx);
        }
    }
    for (const [ref, txs] of byRef) {
        const keyCounts = new Map<string, { count: number; sample: SubmittedTxObservation }>();
        for (const tx of txs) {
            const key = `${tx.hash}|${tx.lastLedgerSequence}|${tx.resultCode}`;
            const cur = keyCounts.get(key);
            if (!cur)
                keyCounts.set(key, { count: 1, sample: tx });
            else
                cur.count++;
        }
        let best: SubmittedTxObservation | null = null;
        let bestCount = 0;
        for (const { count, sample } of keyCounts.values()) {
            if (count >= quorum && count > bestCount) {
                best = sample;
                bestCount = count;
            }
        }
        if (best)
            out[ref] = {
                hash: best.hash,
                lastLedgerSequence: best.lastLedgerSequence,
                resultCode: best.resultCode,
            };
    }
    return out;
}

export function aggregateAnchorFromObservations(
    observations: ParsedObservation[],
    contractUnl: string[],
): AnchorQuorumResult | null {
    const quorum = quorumThreshold(contractUnl.length);
    const unlSet = new Set(contractUnl.map((k) => k.toLowerCase()));
    const fromUnl = observations.filter((o) => unlSet.has(o.unlPubkey.toLowerCase()));
    if (!fromUnl.length)
        return null;

    const pick = selectAnchorCandidate(fromUnl, quorum);
    if (!pick)
        return null;

    const supporting = fromUnl.filter((o) => o.validatedIndex === pick.index && o.ledgerHash === pick.hash);
    const tenantSequenceStr = modeWithQuorum(supporting.map((o) => String(o.tenantSequence)), quorum);
    const signerListHash = modeWithQuorum(supporting.map((o) => o.signerListHash), quorum);
    if (!tenantSequenceStr || !signerListHash)
        return null;

    return {
        anchorLedger: pick.index,
        ledgerHash: pick.hash,
        tenantSequence: Number(tenantSequenceStr),
        signerListHash,
        agreedExtendResults: mergeAgreedExtendResults(supporting, quorum),
    };
}

export interface ApplyObservationInputsParams {
    operationData: OperationData;
    contractUnl: string[];
    currentLcl: number;
    maxInputLedgerOffset: number;
    messages: { userPublicKey: string; payload: Buffer }[];
}

export function applyObservationInputs(params: ApplyObservationInputsParams): ParsedObservation[] {
    const { operationData, contractUnl, currentLcl, maxInputLedgerOffset, messages } = params;
    const accepted: ParsedObservation[] = [];

    for (const { userPublicKey, payload } of messages) {
        const msg = parseAnchorUserMessage(payload);
        if (!msg)
            continue;

        if (msg.type === NODE_USER_REGISTER_MESSAGE_TYPE) {
            if (!verifyNodeUserRegistration(msg))
                continue;
            if (!contractUnl.find((k) => k.toLowerCase() === msg.unlPubkey.toLowerCase()))
                continue;
            if (!operationData.nodeUserRegistrations)
                operationData.nodeUserRegistrations = {};
            operationData.nodeUserRegistrations[msg.userPubkey] = msg.unlPubkey;
            continue;
        }

        if (msg.type !== ANCHOR_OBSERVATION_MESSAGE_TYPE)
            continue;

        const unlPubkey = resolveUnlPubkeyForUser(userPublicKey, contractUnl, operationData);
        if (!unlPubkey)
            continue;

        if (isObservationStale(msg.observedLcl, currentLcl, maxInputLedgerOffset))
            continue;

        if (!acceptObservationDedup(operationData, unlPubkey, msg.observedLcl, msg.nonce))
            continue;

        const submittedTx = Array.isArray(msg.submittedTx) ? msg.submittedTx : [];
        const points = (msg.checkpoints && msg.checkpoints.length > 0)
            ? msg.checkpoints
            : [{
                validatedIndex: msg.validatedIndex,
                ledgerHash: msg.ledgerHash,
                tenantSequence: msg.tenantSequence,
                signerListHash: msg.signerListHash,
            }];

        for (const cp of points) {
            accepted.push({
                unlPubkey,
                userPubkey: userPublicKey,
                observedLcl: msg.observedLcl,
                nonce: msg.nonce,
                validatedIndex: cp.validatedIndex,
                ledgerHash: cp.ledgerHash,
                tenantSequence: cp.tenantSequence,
                signerListHash: cp.signerListHash,
                submittedTx,
            });
        }
    }

    const quorum = quorumThreshold(contractUnl.length);
    const result = aggregateAnchorFromObservations(accepted, contractUnl);
    if (result) {
        const prev = operationData.anchorLedger ?? 0;
        if (result.anchorLedger > prev) {
            operationData.anchorLedger = result.anchorLedger;
            operationData.agreedLedgerHash = result.ledgerHash;
            operationData.agreedTenantSequence = result.tenantSequence;
            operationData.agreedSignerListHash = result.signerListHash;
        }
    }

    const extendMerged = mergeAgreedExtendResults(accepted, quorum);
    if (Object.keys(extendMerged).length > 0) {
        operationData.agreedExtendResults = {
            ...(operationData.agreedExtendResults || {}),
            ...extendMerged,
        };
    }

    return accepted;
}
