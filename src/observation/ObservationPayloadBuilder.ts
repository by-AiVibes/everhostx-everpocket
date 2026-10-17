import {
    AnchorObservationPayload,
    ANCHOR_OBSERVATION_MESSAGE_TYPE,
    SubmittedTxObservation,
} from '../cluster/AnchorObservation';
import { computeCheckpointIndexes, hashSignerList } from './ObservationLedgerReads';
import { SignerListInfo } from '../models';

export type ObservationLedgerReader = {
    getValidatedLedgerIndex(): number;
    getLedgerHashAt(ledgerIndex: number): Promise<string | null>;
    getSignerListAt(ledgerIndex: number): Promise<SignerListInfo | null>;
    getAccountSequenceAt(account: string, ledgerIndex: number): Promise<number>;
};

export type ObservationReaderBuildParams = {
    observedLcl: number;
    observedLclHash: string;
    nonce: number;
    tenantAddress: string;
    submittedTx: SubmittedTxObservation[];
    checkpointInterval: number;
    checkpointWindow: number;
};

export async function buildAnchorObservationFromReader(
    reader: ObservationLedgerReader,
    params: ObservationReaderBuildParams,
): Promise<AnchorObservationPayload | null> {
    const interval = params.checkpointInterval;
    const window = params.checkpointWindow;
    if (!interval || !window)
        throw new Error('Missing checkpointInterval or checkpointWindow');
    const latest = reader.getValidatedLedgerIndex();
    const indexes = computeCheckpointIndexes(latest, interval, window);
    const checkpoints: AnchorObservationPayload['checkpoints'] = [];

    for (const validatedIndex of indexes) {
        if (latest < validatedIndex)
            continue;
        let ledgerHash: string | null = null;
        let signerList: SignerListInfo | null = null;
        let tenantSequence: number | null = null;
        try {
            ledgerHash = await reader.getLedgerHashAt(validatedIndex);
            if (!ledgerHash)
                continue;
            signerList = await reader.getSignerListAt(validatedIndex);
            const signerListHash = hashSignerList(signerList);
            if (!signerListHash)
                continue;
            tenantSequence = await reader.getAccountSequenceAt(params.tenantAddress, validatedIndex);
            checkpoints.push({
                validatedIndex,
                ledgerHash,
                tenantSequence,
                signerListHash,
            });
        } catch {
            continue;
        }
    }

    if (!checkpoints.length)
        return null;

    const primary = checkpoints[0];
    return {
        type: ANCHOR_OBSERVATION_MESSAGE_TYPE,
        observedLcl: params.observedLcl,
        observedLclHash: params.observedLclHash,
        nonce: params.nonce,
        validatedIndex: primary.validatedIndex,
        ledgerHash: primary.ledgerHash,
        tenantSequence: primary.tenantSequence,
        signerListHash: primary.signerListHash,
        submittedTx: params.submittedTx,
        checkpoints,
    };
}
