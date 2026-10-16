const { applyObservationInputs } = require('../../dist/cluster/AnchorObservation');
const { buildAnchorObservationPayload } = require('../../dist/observation/ObservationSubmitter');
const { unlPubkey } = require('./consensus-input-helpers');

function quorumExtendObservationMessages({
    unlSize = 5,
    anchorLedger,
    tenantSequence,
    opRef,
    txHash,
    lastLedgerSequence,
    observedLcl = 100,
    nonce = 1,
}) {
    const messages = [];
    for (let i = 0; i < unlSize; i++) {
        const pk = unlPubkey(i);
        messages.push({
            userPublicKey: pk,
            payload: Buffer.from(JSON.stringify(buildAnchorObservationPayload({
                observedLcl,
                observedLclHash: 'lcl',
                nonce,
                validatedIndex: anchorLedger,
                ledgerHash: `ledger-${anchorLedger}`,
                tenantSequence,
                signerListHash: 'sig',
                submittedTx: [{
                    ref: opRef,
                    hash: txHash,
                    lastLedgerSequence,
                    resultCode: 'tesSUCCESS',
                }],
            }))),
        });
    }
    return messages;
}

function applyQuorumExtendToOperationData(operationData, contractUnl, params) {
    const messages = quorumExtendObservationMessages(params);
    applyObservationInputs({
        operationData,
        contractUnl,
        currentLcl: params.observedLcl ?? 100,
        maxInputLedgerOffset: 32,
        messages,
    });
}

module.exports = {
    quorumExtendObservationMessages,
    applyQuorumExtendToOperationData,
};
