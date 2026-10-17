# STOP report: UNL node contract inputs for anchor quorum

**Reviewer ruling:** advance `anchorLedger` / tenant sequence from HotPocket **consensus on the agreed user-input set**, not NPL votes.

**Task:** Verify this SDK exposes a way for a **UNL node** to submit observations that enter the **consensus-ordered input set**, then implement quorum aggregation.

## Verdict: **STOP — no in-SDK node submit API**

The consensus-ordered input set is real (HotPocket **user inputs**), and contracts **read** it via `contractCtx.users`. This repo’s in-round **`hotpocket-nodejs-contract`** `ContractContext` does **not** expose any method for a UNL node to **submit** those inputs. Submission is only available through the separate **hotpocket-js-client** user/WebSocket protocol (`submitContractInput`), outside the contract context API.

Building anchor quorum on “each node submits a signed observation as a contract input” requires that submit path to be wired for UNL nodes each round. That wiring is **not** present in this SDK today.

---

## Evidence (this repo + dependencies)

### 1. `ContractContext` has no submit-input API

From `hotpocket-nodejs-contract` (dependency `hotpocket-nodejs-contract@0.7.4`), the object passed into every contract round is `ContractContext` with only:

| Member | Role |
|--------|------|
| `users` | Read **already-consensed** user inputs for this round |
| `unl` | NPL peer messaging (not consensus inputs) |
| `getConfig` / `updateConfig` | Patch config |
| `updatePeers` | Control channel peer changeset |
| `lclSeqNo`, `lclHash`, `publicKey`, … | Round metadata |

There is **no** `submitInput`, `submitContractInput`, or equivalent on `ContractContext`.

```153:190:node_modules/hotpocket-nodejs-contract/index.js
class ContractContext {
    constructor(hpargs, users, unl, controlChannel) {
        ...
        this.users = users;
        this.unl = unl; // Not available in readonly mode.
        this.lclSeqNo = hpargs.lcl_seq_no;
        this.lclHash = hpargs.lcl_hash;
    }
    getConfig() { ... }
    updateConfig(config) { ... }
    updatePeers(toAdd, toRemove) { ... }
}
```

Inputs are loaded from `hpargs.user_in_fd` / `hpargs.users` into `UsersCollection` — a **read** path only at contract start.

### 2. This library only **reads** user inputs in the sample contract

The bundled test contract iterates `contractCtx.users.list()` and `contractCtx.users.read(input)` — the consensus-delivered input set. It does not submit observations from inside the contract.

```74:79:test/contract/src/contract.js
    for (const user of contractCtx.users.list()) {
        userHandlers.push(new Promise(async (resolve) => {
            for (const input of user.inputs) {
                const buf = await contractCtx.users.read(input);
                ...
```

`ClusterContext.feedUserMessage` is the analogous path for cluster user messages, not ledger observations.

### 3. Submit exists only on **hotpocket-js-client** (external user connection)

`HotPocketContext.sendMessage` in this repo uses `hotpocket-js-client` to open a **WebSocket client** and call `submitContractInput` — i.e. the [client (user) protocol](https://docs.evernode.org/en/latest/sdk/hotpocket/reference/client-protocol.html), not an in-contract UNL API:

```151:152:src/context/HotPocketContext.ts
                    const input = await this.hpClient.submitContractInput(message);
```

Evernode’s instance-sync tutorial describes the same pattern: a **separate client** (or the new node) calls `client.submitContractInput(...)`; the contract then sees it under `ctx.users` on a later round. That is not integrated into `ClusterContext.init()` / `EvernodeContext` for per-round Xahau observations.

### 4. NPL is explicitly not consensus inputs

`contractCtx.unl` is documented in Evernode as real-time NPL messaging between UNL instances — the same channel `VoteContext` uses. Reviewer ruling excludes NPL for anchor advancement.

---

## What would be needed to proceed (out of scope until SDK/runtime path is defined)

1. **Submit path:** Each UNL node signs and submits an observation payload via `hotpocket-js-client` `submitContractInput` (or a future first-class API on `ContractContext`) **before** the round that will execute it — timing must match HotPocket’s input ledger rules (`max_input_ledger_offset`, etc.).
2. **Read + aggregate path:** At round start, parse all consensus user inputs tagged as observations (filter by UNL membership), apply quorum rule (≥ ceil(2/3 × |UNL|)), median `validatedIndex` with hash agreement, set `anchorLedger` / `tenantSequence` / signer-list hash, then run existing pinned Xahau reader + queue core.
3. **Tests:** Multi-process sim feeding **byte-identical synthetic input sets** per round (not NPL), plus quorum-miss and lying-minority cases.

Until (1) is specified and exposed for UNL nodes running this library **without** ad-hoc external client processes, implementing (2–3) in `src/` would be speculative.

---

## Current branch state (unchanged by this STOP)

Phase 1 queue core on PR #3 (`e0881f9`) still uses agreed `operations.json` + pinned ledger reads documented in `docs/queue-agreed-state.md`. That remains **interim** until consensus-input anchor advancement is unblocked.
