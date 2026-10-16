# Client-input anchor design

## Out-of-band submit

`ObservationSubmitter` (or any sidecar) calls `HotPocketContext.submitContractInputRaw` **outside** contract round execution. Submit failures never mutate contract state.

## In-round ingest

`ClusterContext.processConsensusUserInputs` / `ingestUserInput` runs **before** `init()` snapshot capture (see `test/contract/src/contract.js`).

## Observation payload

```json
{
  "type": "anchor_observation",
  "observedLcl": 0,
  "observedLclHash": "",
  "nonce": 0,
  "validatedIndex": 0,
  "ledgerHash": "",
  "tenantSequence": 0,
  "signerListHash": "",
  "submittedTx": []
}
```

Dedupe: per UNL member, monotonic `nonce` and `observedLcl`. Stale if `observedLcl < lclSeqNo - max_input_ledger_offset`.

## UNL key as user key

`HotPocketContext` already opens the client with `contractContext.privateKey` / `publicKey` — the node **is** a HotPocket user with the UNL key. No separate evidence was found in `hotpocket-nodejs-contract` forbidding that identity for `submitContractInput`.
