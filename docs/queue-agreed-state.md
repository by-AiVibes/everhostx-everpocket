# Queue agreed state (Phase 1)

Phase 1 does **not** use votes for queue tx fields. Agreed inputs come from HotPocket consensus state plus **pinned Xahau reads** at a shared ledger index.

## `anchorLedger`

- **Source of truth:** `operations.json` → `anchorLedger`, initially bootstrapped from the contract config field `evernode.anchorLedger` (same on all nodes via agreed HotPocket contract config).
- **Advance rule (no vote, no local submit metadata):** when an EXTEND op is dequeued because the **deterministic** extend tx hash is `tesSUCCESS` on-ledger at the pinned anchor, all nodes set `operations.json.anchorLedger` to `anchorLedger + LLS_LEDGER_WINDOW` (30). Every node computes the same next anchor from the frozen round snapshot.
- **Lag:** if a node’s validated Xahau index is `< anchorLedger`, the round aborts without persisting.

## `tenantSequence` (Sequence field)

- **Not stored in `operations.json`.**
- **Source:** pinned `account_info` (or ledger backend equivalent) for the tenant address at `ledger_index = anchorLedger`. All nodes reading the same index see the same sequence.

## Tx hash / completion

- Extend tx hash is **recomputed** each round from the snapshot (`computeExtendTxHash`); it is **never** taken from a node’s submit response or written from perform/deinit.
- Completion = hash present with `tesSUCCESS` at pinned `getTxAt(hash, lastLedgerSequence)` where `lastLedgerSequence = anchorLedger + 30` from the round snapshot (not from any node submit response).

## Host

- Extend submit uses `pickHostForOpRef(snapshot, op.ref)` = `sha256(lclHash || opRef)` over the sorted agreed host list (not cluster node host fields).
