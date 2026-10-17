const crypto = require('crypto');
const { buildAnchorObservationPayload } = require('../../dist/observation/ObservationSubmitter');

function unlPubkey(i) {
    return `ed${(BigInt(i + 1)).toString(16).padStart(64, '0')}`;
}

function ledgerHashAt(index) {
    return crypto.createHash('sha256').update(`ledger-${index}`).digest('hex');
}

function buildConsensusMessages({
    unlSize = 5,
    validatedIndex,
    tenantSequence,
    signerListHash = 'sim_signer_hash',
    observedLcl,
    nonce = 1,
    liarNodeIndex = null,
    submittedTx = [],
}) {
    const messages = [];
    for (let i = 0; i < unlSize; i++) {
        const pk = unlPubkey(i);
        const hash = (liarNodeIndex === i) ? 'LIAR_HASH' : ledgerHashAt(validatedIndex);
        messages.push({
            userPublicKey: pk,
            payload: JSON.stringify(buildAnchorObservationPayload({
                observedLcl,
                observedLclHash: 'sim_lcl_hash',
                nonce,
                validatedIndex,
                ledgerHash: hash,
                tenantSequence,
                signerListHash,
                submittedTx,
            })),
        });
    }
    return messages;
}

function fakeUsersCollection(messages) {
    return {
        list: () => messages.map((m, idx) => ({
            publicKey: m.userPublicKey,
            inputs: [[idx, Buffer.byteLength(m.payload, 'utf8')]],
        })),
        read: async ([idx]) => Buffer.from(messages[idx].payload, 'utf8'),
    };
}

module.exports = {
    unlPubkey,
    ledgerHashAt,
    buildConsensusMessages,
    fakeUsersCollection,
};
