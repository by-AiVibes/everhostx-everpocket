import { Buffer } from 'buffer';
import { ExtendNodeOperation, OperationData, OperationType } from '../models/cluster';
import { backoffLcl, operationAttempt } from './OperationQueueProcessor';
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

function resolveExtendOpRef(operationData: OperationData | undefined, txRef: string): string | null {
    if (!operationData)
        return txRef;
    for (const op of operationData.operations) {
        if (op.type !== OperationType.EXTEND_NODE)
            continue;
        if (op.ref === txRef)
            return op.ref;
        const data = op.data as ExtendNodeOperation;
        if (data.nodePubkey === txRef)
            return op.ref;
    }
    return txRef;
}

function modeWithQuorumDistinctUnl(
    observations: ParsedObservation[],
    valueFn: (o: ParsedObservation) => string,
    quorum: number,
): string | null {
    const valueToUnl = new Map<string, Set<string>>();
    for (const o of observations) {
        const v = valueFn(o);
        const unl = o.unlPubkey.toLowerCase();
        if (!valueToUnl.has(v))
            valueToUnl.set(v, new Set());
        valueToUnl.get(v)!.add(unl);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [v, unls] of valueToUnl) {
        const c = unls.size;
        if (c >= quorum && c > bestCount) {
            best = v;
            bestCount = c;
        }
    }
    return best;
}

export function normalizeObservationCheckpoints(msg: AnchorObservationPayload): ObservationCheckpointFields[] | null {
    const points = (msg.checkpoints && msg.checkpoints.length > 0)
        ? msg.checkpoints
        : [{
            validatedIndex: msg.validatedIndex,
            ledgerHash: msg.ledgerHash,
            tenantSequence: msg.tenantSequence,
            signerListHash: msg.signerListHash,
        }];

    const byIndex = new Map<number, ObservationCheckpointFields>();
    for (const cp of points) {
        if (byIndex.has(cp.validatedIndex))
            return null;
        byIndex.set(cp.validatedIndex, cp);
    }
    return [...byIndex.values()];
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
        const hashToUnl = new Map<string, Set<string>>();
        for (const o of list) {
            const h = o.ledgerHash;
            const unl = o.unlPubkey.toLowerCase();
            if (!hashToUnl.has(h))
                hashToUnl.set(h, new Set());
            hashToUnl.get(h)!.add(unl);
        }
        for (const [hash, unls] of hashToUnl) {
            if (unls.size >= quorum)
                candidates.push({ index, hash });
        }
    }
    if (!candidates.length)
        return null;

    candidates.sort((a, b) => a.index - b.index);
    const median = candidates[Math.floor((candidates.length - 1) / 2)];
    const atMedian = observations.filter((o) => o.validatedIndex === median.index);
    const hashAtMedian = modeWithQuorumDistinctUnl(atMedian, (o) => o.ledgerHash, quorum);
    if (hashAtMedian)
        return { index: median.index, hash: hashAtMedian };

    return candidates[0];
}

function mergeAgreedExtendResults(
    observations: ParsedObservation[],
    quorum: number,
    operationData?: OperationData,
): Record<string, { hash: string; lastLedgerSequence: number; resultCode: string }> {
    const out: Record<string, { hash: string; lastLedgerSequence: number; resultCode: string }> = {};
    const byRef = new Map<string, Map<string, { unls: Set<string>; sample: SubmittedTxObservation }>>();

    const nodesSeen = new Set<string>();
    for (const o of observations) {
        const unl = o.unlPubkey.toLowerCase();
        if (nodesSeen.has(unl))
            continue;
        nodesSeen.add(unl);
        for (const tx of o.submittedTx || []) {
            const opRef = resolveExtendOpRef(operationData, tx.ref);
            if (!opRef)
                continue;
            if (!byRef.has(opRef))
                byRef.set(opRef, new Map());
            const refMap = byRef.get(opRef)!;
            const key = `${tx.hash}|${tx.lastLedgerSequence}|${tx.resultCode}`;
            if (!refMap.has(key))
                refMap.set(key, { unls: new Set(), sample: tx });
            refMap.get(key)!.unls.add(unl);
        }
    }

    for (const [ref, keyMap] of byRef) {
        let best: SubmittedTxObservation | null = null;
        let bestCount = 0;
        for (const { unls, sample } of keyMap.values()) {
            const count = unls.size;
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
    const tenantSequenceStr = modeWithQuorumDistinctUnl(supporting, (o) => String(o.tenantSequence), quorum);
    const signerListHash = modeWithQuorumDistinctUnl(supporting, (o) => o.signerListHash, quorum);
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

        const points = normalizeObservationCheckpoints(msg);
        if (!points)
            continue;

        const submittedTx = Array.isArray(msg.submittedTx) ? msg.submittedTx : [];
        const indexSeen = new Set<number>();
        for (const cp of points) {
            if (indexSeen.has(cp.validatedIndex))
                continue;
            indexSeen.add(cp.validatedIndex);
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
        const prev = operationData.anchorLedger !== undefined ? operationData.anchorLedger : 0;
        if (result.anchorLedger > prev) {
            operationData.anchorLedger = result.anchorLedger;
            operationData.agreedLedgerHash = result.ledgerHash;
            operationData.agreedSignerListHash = result.signerListHash;
        }
        const curTs = operationData.agreedTenantSequence;
        if (curTs === undefined || result.tenantSequence > curTs)
            operationData.agreedTenantSequence = result.tenantSequence;
    }

    const extendMerged = mergeAgreedExtendResults(accepted, quorum, operationData);
    if (Object.keys(extendMerged).length > 0) {
        operationData.agreedExtendResults = {
            ...(operationData.agreedExtendResults || {}),
            ...extendMerged,
        };
    }

    applyAgreedExtendAttemptIncrements(operationData, accepted, quorum, currentLcl);

    return accepted;
}

/** Attempt/backoff counters advance only from quorum-agreed submittedTx reports (never local submit). */
export function applyAgreedExtendAttemptIncrements(
    operationData: OperationData,
    accepted: ParsedObservation[],
    quorum: number,
    currentLcl: number,
): void {
    const merged = mergeAgreedExtendResults(accepted, quorum, operationData);
    for (const [ref, agreed] of Object.entries(merged)) {
        if (agreed.resultCode !== 'tesSUCCESS')
            continue;
        const op = operationData.operations.find((o) => o.ref === ref && o.type === OperationType.EXTEND_NODE);
        if (!op)
            continue;
        const submitKey = `${agreed.hash}|${agreed.lastLedgerSequence}|${agreed.resultCode}`;
        if (op.quorumCountedSubmitKey === submitKey)
            continue;
        op.quorumCountedSubmitKey = submitKey;
        const attempt = operationAttempt(op) + 1;
        op.attempt = attempt;
        op.nextAttemptLcl = currentLcl + backoffLcl(attempt);
        delete op.retryCount;
        delete op.nextRetryLcl;
    }
}
