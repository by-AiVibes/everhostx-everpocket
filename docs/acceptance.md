# everpocket queue: acceptance invariants

Status: locked by reviewer ruling (Nox). Any change set touching the operation queue, the
observation/anchor path, or the deterministic transaction path must satisfy every invariant
below and pass `npm run test:gate` unmodified. `test/gate/**` and this file are checksummed in
`test/gate/MANIFEST.sha256` (enforced by `test/gate/manifest.test.js`) and owned via
`.github/CODEOWNERS`. Gate failures are fail-closed: a red gate is a FAIL, never "flaky".

Run against any build: `GATE_DIST=<checkout>/dist GATE_SRC=<checkout>/src npm run test:gate`.

## A. Secrets and source hygiene
| # | Invariant | Gate |
|---|-----------|------|
| A1 | No derived secrets. No private key, seed, IV, nonce or signer secret is derived from anything (hashes, `lclHash`, `opRef`, ledger/state data). Secrets come only from a CSPRNG and are never recomputable from public data. | static.test.js |
| A2 | No placeholders (`local_*`, dummy values, placeholder hosts/indexes) and no `??` literal/`DEFAULT_*` fallbacks in src. Missing required config fails closed. | static.test.js |
| A3 | Fakes (ledger, submitter, harness) live only in `test/`. | static.test.js |
| A4 | No test-only src branches (`process.env`, `VITEST`, `NODE_ENV`, `EVP_*` switches). | static.test.js |
| A5 | Behavioural tests only; no tautological tests that recompute expected values from the same src constant. | review |

## B. Deterministic transaction inputs
| # | Invariant | Gate |
|---|-----------|------|
| B1 | Every tx input is derived only from the frozen round snapshot (agreed state) plus `lclSeqNo`/`lclHash`. No votes, no node-local reads. | sim (votesUsed == 0) |
| B2 | Fixed fee from agreed config (`feeCeiling`); never a local fee query. | review / mutation |
| B3 | `LastLedgerSequence = anchorLedger + constant`. | review / mutation |
| B4 | Host = `hash(lclHash || opRef)` over the agreed host list. | review / mutation |
| B5 | `anchorLedger == 0` / unset aborts before any tx is built. | review |

## C. Queue processing
| # | Invariant | Gate |
|---|-----------|------|
| C1 | Backoff cap: max 8 attempts; attempts count only on an actual submit. | review / mutation |
| C2 | `catch` only logs; it never mutates agreed state or decides completion. | reader-split, double-pay |
| C3 | Dequeue only on quorum completion (agreed data); never on a node-local result. | reader-split, real-hash |
| C4 | No local read writes state and no local read aborts the round. Local reads may only gate a side effect (e.g. skip a submit). Lag must not abort rounds. | reader-split, lag |
| C5 | `maxOpsPerRound = 1`. | review / mutation |
| C6 | ADD/REMOVE are held: skipped, logged, and non-blocking for later ops. | review |

## D. Observations and anchor
| # | Invariant | Gate |
|---|-----------|------|
| D1 | Observations are out-of-band HotPocket user inputs signed by UNL-registered keys; submission never blocks or throws inside the round and never writes the state dir. | sim, review |
| D2 | Quorum counts distinct UNL nodes, threshold `ceil(2n/3)`; one node counts once regardless of user keys, duplicate messages or duplicate checkpoints. | liars, quorum-noop |
| D3 | Stale observations (beyond `max_input_ledger_offset`), non-UNL submitters and forged registrations are rejected. | quorum-noop |
| D4 | Below-quorum / empty input sets are exact no-ops on agreed state. | quorum-noop |
| D5 | Anchor rule: the anchor advances only to a checkpoint index where a quorum agrees on the same ledger hash (median-of-agreeing indexes, hash must match). Liars (1 of 5) and 2 of 5 colluders cannot move anchor, sequence or extend results. | liars, collusion |
| D6 | Bootstrap (`anchorLedger`, `tenantSequence`, checkpoint params) comes from agreed contract config only. | review |

## E. EXTEND pinning and completion
| # | Invariant | Gate |
|---|-----------|------|
| E1 | Each EXTEND pins `(account, Sequence, LastLedgerSequence)` in agreed state on first submit; resubmits reuse the pin. | double-pay, restart |
| E2 | Completion only when the quorum shows the pinned Sequence consumed by a matching `tesSUCCESS` tx (hash = real signed-tx hash, never a canonical-JSON hash). | real-hash |
| E3 | Single in-flight EXTEND: no other op gets a Sequence while a pin is unresolved; unblock uses agreed data only. | double-pay |
| E4 | Conflict (pinned Sequence consumed by a different tx) means the op is held, never blindly resubmitted. | review / mutation |
| E5 | Landed tx per op == 1 under partial failure, restart, overlap and partial delivery; every op completes. | double-pay, restart, sim-seeds |

## F. Simulation acceptance
10 seeds x 100 rounds, 5 real-process nodes, 20% input drop, mixed local validated views,
extfail/throwafter/crash/seqfail mix, 1/5 hash liar on even seeds, real-format hashes:
0 divergent rounds, every op completes, landed == 1 per op (`sim-seeds.test.js`).

## Known upstream debt (origin/main 06ba9f5)
Allowlisted in `static.test.js` by exact line, outside the queue path:
- `context/ClusterContext.ts`: `DUMMY_OWNER_PUBKEY = "dummy_owner_pubkey"`.
- `context/VoteContext.ts`: `return votes ?? [];`.

Not allowlisted (violates A1, so the static gate fails until it's fixed): `context/EvernodeContext.ts`
`const seed = Buffer.from(this.hpContext.lclHash, "hex")`. The acquire-path seed is derived from public `lclHash`.
