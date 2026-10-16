import { AcquireData } from '../models/evernode';
import { ClusterData, ExtendNodeOperation, Operation, OperationData } from '../models/cluster';
import { SignerListInfo as XrplSignerListInfo } from '../models';
import { TransactionInfo } from '../models/xrpl';

export type FrozenRoundSnapshot = {
    lclSeqNo: number;
    lclHash: string;
    anchorLedger: number;
    unl: string[];
    cluster: ClusterData;
    operations: Operation[];
    acquireData: AcquireData;
    signerList: XrplSignerListInfo | null;
    tenantSequence: number;
    tenantAddress: string;
    feeCeiling: string;
    hostList: string[];
    /** Pinned extend tx lookups captured once at round start (agreed ledger view). */
    extendLedgerChecks: ExtendLedgerCheck[];
};

export type ExtendLedgerCheck = {
    ref: string;
    hash: string;
    lastLedgerSequence: number;
    tx: TransactionInfo | null;
};

function deepFreeze<T>(obj: T): T {
    if (obj && typeof obj === 'object') {
        Object.freeze(obj);
        for (const v of Object.values(obj as object)) {
            deepFreeze(v);
        }
    }
    return obj;
}

export function computeAnchorLedger(operationData: OperationData): number {
    let cap = operationData.anchorLedger ?? 0;
    for (const op of operationData.operations) {
        const data = op.data as ExtendNodeOperation & { acquireLedgerCap?: number; signerTxCap?: number };
        if (typeof data.acquireLedgerCap === 'number')
            cap = Math.max(cap, data.acquireLedgerCap);
        if (typeof data.signerTxCap === 'number')
            cap = Math.max(cap, data.signerTxCap);
        if (typeof data.extendLedgerCap === 'number')
            cap = Math.max(cap, data.extendLedgerCap);
    }
    return cap;
}

export class RoundSnapshot {
    static capture(params: {
        lclSeqNo: number;
        lclHash: string;
        operationData: OperationData;
        clusterData: ClusterData;
        acquireData: AcquireData;
        contractUnl: string[];
        signerListInfo: XrplSignerListInfo | null;
        tenantSequence: number;
        tenantAddress: string;
        feeCeiling: string;
        hostList: string[];
        extendLedgerChecks: ExtendLedgerCheck[];
    }): FrozenRoundSnapshot {
        const anchorLedger = computeAnchorLedger(params.operationData);
        const snap: FrozenRoundSnapshot = {
            lclSeqNo: params.lclSeqNo,
            lclHash: params.lclHash,
            anchorLedger,
            unl: [...params.contractUnl],
            tenantSequence: params.tenantSequence,
            tenantAddress: params.tenantAddress,
            feeCeiling: params.feeCeiling,
            hostList: [...params.hostList],
            cluster: JSON.parse(JSON.stringify(params.clusterData)),
            operations: JSON.parse(JSON.stringify(params.operationData.operations)),
            acquireData: JSON.parse(JSON.stringify(params.acquireData)),
            signerList: params.signerListInfo
                ? {
                    signerQuorum: params.signerListInfo.signerQuorum,
                    signerList: params.signerListInfo.signerList.map((s) => ({ ...s })),
                }
                : null,
            extendLedgerChecks: params.extendLedgerChecks.map((c) => ({ ...c })),
        };
        return deepFreeze(snap);
    }
}
