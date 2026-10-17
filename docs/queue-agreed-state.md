# Queue agreed state (Phase 1)

Phase 1 does **not** use NPL votes for anchor or queue tx fields. Agreed inputs come from HotPocket **consensus user inputs** plus **pinned Xahau reads** at the agreed anchor index.

## Identity (client-input observations)

- Each UNL node submits observations **out-of-band** via `hotpocket-js-client` `submitContractInput`, using **`HotPocketContext.submitContractInputRaw`** / **`ObservationSubmitter`** (same keys as the contract node — the HotPocket user public key matches the UNL key; see `HotPocketContext.#initClient`).
- Fallback: a one-time `node_user_register` input signed by the UNL key maps a CSPRNG user public key to that UNL member (`nodeUserRegistrations` in `operations.json`). Keys are never derived from secrets.
- Only inputs whose user public key resolves to a current UNL member are counted.

## `anchorLedger`

- **Bootstrap:** `operations.json` → `anchorLedger`, initially from `evernode.anchorLedger` in agreed contract config.
- **Advance rule:** deterministic quorum over the byte-identical consensus input set each round:
  - Quorum = `ceil(2/3 × |UNL|)`.
  - Among UNL observations passing dedupe and `max_input_ledger_offset`, pick anchor index via median / hash-quorum rule (`aggregateAnchorFromObservations` in `src/cluster/AnchorObservation.ts`).
  - If quorum is missing, **do not advance**; EXTEND and the queue continue on the last agreed anchor.
- **Lag:** validated Xahau behind the agreed anchor does **not** abort the round.

## `tenantSequence` / signer-list hash

- When anchor advances via quorum, `agreedTenantSequence` and `agreedSignerListHash` are stored in `operations.json` from quorum-agreed observation fields at that anchor.
- Round snapshot uses those values when present; otherwise pinned ledger reads at `anchorLedger`.

## Tx hash / completion

- On first extend attempt, agreed `pinnedExtendTxs[opRef]` stores tenant account, **sequence**, LLS, fee, host, and op fields (node pubkey, moments, token id). No pre-sign hash — the multisig tx hash is unknown until submit.
- Retries reuse the pin. At most one extend is in flight (pinned LLS ≥ agreed anchor).
- **Completion** = quorum `agreedExtendResults[opRef]` with `tesSUCCESS`, matching pinned LLS and op fields (observations report the signed tx that consumed the pinned sequence). Local `getTxAt` is never used for agreed state.
- Pinned sequence consumed on ledger without a matching quorum result for this op → `extendHoldReason` (no blind resubmit).

## Host

- Extend submit uses `pickHostForOpRef(snapshot, op.ref)` = `sha256(lclHash || opRef)` over the sorted agreed host list.
