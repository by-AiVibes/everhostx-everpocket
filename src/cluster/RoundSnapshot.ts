import { AcquireData } from '../models/evernode';
import { ClusterData, Operation, OperationData } from '../models/cluster';
import { SignerListInfo as XrplSignerListInfo } from '../models';

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

export function computeAnchorLedger(operationData: OperationData, validatedLedger: number): number {
    let cap = operationData.anchorLedger || 0;
    for (const op of operationData.operations) {
        const data = op.data as any;
        if (data.acquireLedgerCap) cap = Math.max(cap, data.acquireLedgerCap);
        if (data.signerTxCap) cap = Math.max(cap, data.signerTxCap);
        if (data.extendLedgerCap) cap = Math.max(cap, data.extendLedgerCap);
    }
    if (cap <= 0 && validatedLedger > 0)
        cap = validatedLedger;
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
        validatedLedger: number;
    }): FrozenRoundSnapshot {
        const anchorLedger = computeAnchorLedger(params.operationData, params.validatedLedger);
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
        };
        return deepFreeze(snap);
    }
}
