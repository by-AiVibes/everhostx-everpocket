/**
 * Evernode runs on the Xahau ledger. In evernode-js-client, `Defaults.useNetwork("mainnet")`
 * resolves to the Xahau rippled endpoint — not XRPL mainnet.
 */
export const XAHAU_NETWORK_ID = 21337;

/** Evernode network key that selects the Xahau rippled endpoint from public definitions. */
export const EVERNODE_XAHAU_NETWORK_KEY = 'mainnet';
