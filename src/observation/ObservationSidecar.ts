import { Peer } from '../models';
import HotPocketContext from '../context/HotPocketContext';
import { SubmittedTxObservation } from '../cluster/AnchorObservation';
import { AnchorObservationPayload } from '../cluster/AnchorObservation';
import { ObservationSubmitter } from './ObservationSubmitter';
import { error } from '../helpers/logger';
import XrplContext from '../context/XrplContext';
import { buildAnchorObservationFromReader } from './ObservationPayloadBuilder';
import { requireCheckpointInterval, requireCheckpointWindow, requireMaxInputLedgerOffset } from '../cluster/QueueConfig';

export type ObservationSidecarHooks = {
    submitPayload?: (payload: AnchorObservationPayload, peers: Peer[]) => Promise<void>;
};

const defaultHooks: ObservationSidecarHooks = {};

/**
 * Fire-and-forget observation submit (never awaited by contract round).
 */
export function scheduleObservationSubmit(
    hpContext: HotPocketContext,
    xrplContext: XrplContext,
    peers: Peer[],
    pendingSubmits: SubmittedTxObservation[],
    hooks: ObservationSidecarHooks = defaultHooks,
): void {
    void (async () => {
        try {
            const config = await hpContext.getContractConfig();
            requireMaxInputLedgerOffset(config);
            const tenantAddress = xrplContext.xrplAcc?.address;
            if (!tenantAddress)
                return;

            const checkpointInterval = requireCheckpointInterval(config);
            const checkpointWindow = requireCheckpointWindow(config);

            const reader = {
                getValidatedLedgerIndex: () => xrplContext.getValidatedLedgerIndex(),
                getLedgerHashAt: (idx: number) => xrplContext.getLedgerHashAt(idx),
                getSignerListAt: (idx: number) => xrplContext.getSignerListAtForObservation(idx),
                getAccountSequenceAt: (acc: string, idx: number) => xrplContext.getAccountSequenceAtForObservation(acc, idx)
                    .then((s) => { if (s === null) throw new Error('no sequence'); return s; }),
            };

            const payload = await buildAnchorObservationFromReader(reader, {
                observedLcl: hpContext.lclSeqNo,
                observedLclHash: hpContext.lclHash,
                nonce: hpContext.lclSeqNo,
                tenantAddress,
                submittedTx: [...pendingSubmits],
                checkpointInterval,
                checkpointWindow,
            });
            if (!payload)
                return;

            if (hooks.submitPayload)
                await hooks.submitPayload(payload, peers);
            else {
                const submitter = new ObservationSubmitter(hpContext, peers);
                await submitter.submitObservation(payload);
            }
            pendingSubmits.length = 0;
        } catch (e) {
            error(e);
        }
    })();
}
