/**
 * Evernode runs on the Xahau ledger. In evernode-js-client, `Defaults.useNetwork("mainnet")`
 * resolves to wss://xahau.network with networkID 21337 — not XRPL mainnet.
 * All pinned-index reads in the op queue use this Xahau ledger via XrplContext.
 */
export const XAHAU_NETWORK_ID = 21337;

/** Evernode network key that selects the Xahau rippled endpoint from public definitions. */
export const EVERNODE_XAHAU_NETWORK_KEY = 'mainnet';
