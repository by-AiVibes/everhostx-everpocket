import { Buffer } from 'buffer';
import { Peer } from '../models';
import HotPocketContext from '../context/HotPocketContext';
import {
    ANCHOR_OBSERVATION_MESSAGE_TYPE,
    AnchorObservationPayload,
    SubmittedTxObservation,
} from '../cluster/AnchorObservation';

export interface BuildObservationParams {
    observedLcl: number;
    observedLclHash: string;
    nonce: number;
    validatedIndex: number;
    ledgerHash: string;
    tenantSequence: number;
    signerListHash: string;
    submittedTx: SubmittedTxObservation[];
}

export function buildAnchorObservationPayload(params: BuildObservationParams): AnchorObservationPayload {
    return {
        type: ANCHOR_OBSERVATION_MESSAGE_TYPE,
        observedLcl: params.observedLcl,
        observedLclHash: params.observedLclHash,
        nonce: params.nonce,
        validatedIndex: params.validatedIndex,
        ledgerHash: params.ledgerHash,
        tenantSequence: params.tenantSequence,
        signerListHash: params.signerListHash,
        submittedTx: params.submittedTx,
    };
}

/**
 * Out-of-band observation submit (sidecar / loop). Failures do not touch contract state.
 */
export class ObservationSubmitter {
    private hpContext: HotPocketContext;
    private peers: Peer[];

    constructor(hpContext: HotPocketContext, peers: Peer[]) {
        this.hpContext = hpContext;
        this.peers = peers;
    }

    async submitObservation(payload: AnchorObservationPayload): Promise<void> {
        await this.hpContext.submitContractInputRaw(JSON.stringify(payload), this.peers);
    }
}
