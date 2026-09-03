# Incident: settlement-availability, decision cmtlhlb1a00016e1rbm77s8gq

**Classification (per external audit review): settlement-availability incident, NOT unauthorized-settlement.**
Funds are not at risk of theft. They are at risk of indefinite lockup — the current `Escrow` contract has no timeout, cancellation, or refund path. `SETTLEMENT_PAUSED` remains correctly enabled and must stay enabled.

## Known state (verified)
- Dispatch tx: `0xa5f78db9d2e0e7ed8f63606d3c91c05efb581cb8fa1c200c26c10de341ae702d` — confirmed on-chain, status success.
- Message ID: `0xf8923e064e5eed132ecb05fdb5de08eac060cb69b0ad22345d7ba398a41d3692`
- Message nonce: `873170`
- Escrow contract: `0x5314725C32b58d0e1CACa510d491c8492D0BE997` (Sepolia)
- Escrow ID: `0x4d0659d574bf2fc71ab4cdab58307df787007a45d084282e267b8475cf44ed17`
- Deposit: `1000000000000000` wei (0.001 ETH), status `DEPOSITED` (1), unchanged since the real deposit tx.
- Attestation: real 2-of-2 (backend key + offline attestor key `0x229d46B4C22B5AA42fE7cDAae37cf611e726f732`), verified recovering correctly on submission.
- Both validator machines entered a backward consistency sweep after redeploys (validator2: config chunk-size change; validator1: RPC endpoint swap). Sweep appears to be turning around and climbing forward as of the last check (see log below).

## Not yet done, per the audit's own instruction
No further redeploys/restarts/RPC changes/dispatches until this incident's Phase A/B evidence gathering is complete.

## ROOT CAUSE FOUND — 2026-09-03T15:28 UTC (verified, not inferred)

**The message delivered successfully.** Verified directly on-chain:
- `Mailbox.delivered(0xf8923e06...) = true`
- `DecisionRelay.processedDecisions(0x7d1e5e63...) = true`
- Real delivery tx: `0xa7fbcd0c16bd892b0d32412af1e744860fb5a50e264f9d3cf148ed3faefacab2`, block `11627209`, status success — three log entries: `ProcessId`, a Mailbox process event, and a `DecisionRelay` event recording the decision (case ID, decision hash, outcome string `REFUND_FULL`). **No `Escrow`-contract event of any kind appears in this transaction.**

**Why**: `DecisionRelay.settlementTarget(11155111)` reads as `0x0000000000000000000000000000000000000000` — the zero address. Confirmed directly against `DecisionRelay.sol`'s own `handle()`:
```solidity
address target = settlementTarget[_origin];
if (target != address(0)) {
    ISettlementTarget(target).settle(caseId, escrowId, claimantAmount, respondentAmount, proofHash);
}
```
No target configured → settle() is never called → notification-only, by design (same pattern as the Solana ReplayGuard). This is **not a bug in the deployed contract** — it's an administrative gap: nobody ever called `setSettlementTarget(11155111, <Escrow address>)` after deploying `Escrow.sol` earlier this session.

**Escrow status, confirmed unaffected**: deposit still `DEPOSITED` (1), unchanged, 0.001 ETH intact, claimant/respondent balances unchanged. No funds moved, none at risk of misdirection.

**The validator/RPC/relayer investigation this session was real and found real, separate problems** (validator1 Infura quota exhaustion, a too-restrictive Alchemy free-tier key, relayer connection instability, an unconfigured index chunk size) — but **none of those turned out to be what ultimately blocked this specific message**; delivery succeeded independently once conditions allowed. That investigation was not wasted — those are real infra issues worth fixing regardless — but they were not the terminal blocker here.

**The actual, precise way out**: a governance transaction on the 2-of-2 Safe (`0xc200534F7DEbF2816C085C5A156aBd686fA19f4C`, owner of `DecisionRelay`) calling:
```
setSettlementTarget(11155111, 0x5314725C32b58d0e1CACa510d491c8492D0BE997)
```
This requires both Safe owner signatures per `docs/multisig-attestor-setup.md`'s own governance-change procedure. **Not executed. Awaiting explicit operator authorization**, consistent with `SETTLEMENT_PAUSED` remaining enabled and no unilateral action being taken on production governance.

**Important scope note for future settlements**: even once this target is wired, the *current* `Escrow` contract does not store `caseId` in its `Deposit` struct (only emits it in the `Deposited` event) — settlement is keyed solely by `escrowId`. This means the contract itself cannot prove a given settlement's `caseId` matches the original deposit's `caseId`; that binding currently exists only in application-layer records (`CaseSettlement`), not on-chain. Flagged, not yet fixed — a real follow-up for any future `Escrow` deployment, not blocking recovery of *this* specific incident.

## RESOLVED — 2026-09-03 (all times UTC, verified on-chain)

**Governance fix**: Safe tx `0x708011f5c2de12686604114211877163767d6381a10232bc01c9c17331fc7136` (nonce 3, both real 2-of-2 owner signatures verified via `cast wallet verify` before submission) called `setSettlementTarget(11155111, 0x5314725C32b58d0e1CACa510d491c8492D0BE997)`. Verified post-tx: `settlementTarget(11155111)` reads the correct `Escrow` address.

**Recovery**: the original message (decision `cmtlhlb1a00016e1rbm77s8gq`, decisionHash `0x7d1e5e63...`) could not be replayed — `DecisionRelay.processedDecisions` was already `true` for that hash, and `handle()`'s guard (`require(!processedDecisions[proofHash])`) makes that permanent; there is no owner override and `Escrow.settle()` is `onlyDecisionRelay`-gated, so no direct bypass existed either.

Recovery required a **new** dispatch referencing the same `escrowId` with a fresh, explicitly-labeled proof hash (`sha256("recovery-of:0x7d1e5e63...")` = `0xee415b89804f7ea1b68df902df35380316790e02617db5ed3be294837b034720`), reusing the real, unchanged outcome/shares/evidence. A fresh 2-of-2 attestation was collected (both signatures verified via `cast wallet verify` before use) and `SETTLEMENT_PAUSED` was lifted for this one dispatch only, per explicit operator authorization, then re-enabled immediately after dispatch.

**Recovery dispatch tx**: `0x9e3c288b2cf95de7a0dd6a27744697d5c4b4994696c5e12e6216561943c258a4` — status success, both signatures embedded and correct.

**Settlement, verified independently on-chain, not inferred**:
- `Escrow.deposits(escrowId).status` → `2` (SETTLED)
- Claimant balance: `38796879670500` → `1038796879670500` wei — an increase of exactly `1000000000000000` wei (0.001 ETH), matching the deposit and the `REFUND_FULL` (100% claimant / 0% respondent) decision exactly.
- `DecisionRelay.processedDecisions(recovery hash)` → `true`

**Final state**: `SETTLEMENT_PAUSED = true` on `anc-hor-worker`. No funds remain locked. No unauthorized movement occurred at any point — the entire incident was availability (a missing governance wiring step, not a security or custody failure).

**Open follow-ups, not part of this incident's resolution**:
1. `Escrow` doesn't store `caseId` on-chain (only emits it) — real hardening gap for future deployments.
2. Case creation can still fall back to a zero `escrowId` when no `CaseSettlement` exists — should require a real `CaseSettlement` for any real-money settlement path.
3. Validator1's Infura quota exhaustion and the relayer's earlier connection instability are real, separate infra issues worth fixing on their own merits — not re-tested after this incident's resolution since they were not the terminal blocker.
4. No governed expiry/refund/human-review escape hatch exists for a stuck escrow generally — this incident's recovery worked because a new dispatch was possible; a future incident where the settlement target itself is somehow wrong would need a different mechanism.

## Re-audit response — follow-up items 1 and 2, and the re-audit's own findings

**Correction to an earlier overclaim**: a prior message in this session said "both fixes are fully live." That was imprecise for the `caseId` fix — it existed only in source, not deployed. Corrected here.

**Verified, not just claimed**:
- Deployed worker source (commit `c33108f`+) contains the zero-escrow-fallback fix — confirmed via direct `grep` against the running container's own files, not just a version number.
- The rejection was proven through the **real worker dispatch path**, not only the mocked unit test — a live call to `dispatchDecisionForCase` on the running `anc-hor-worker` process, with a synthetic caseId that has no `CaseSettlement`, correctly threw `"case ... has no CaseSettlement — refusing to dispatch..."`.
- **V1 escrow inventory**: exactly one `CaseSettlement` record exists in the entire database, pointing at V1 (`0x5314725C32b58d0e1CACa510d491c8492D0BE997`). Its on-chain deposit status is `SETTLED` (verified directly via `cast call`) — the DB record's `status` field was stale (`DEPOSITED`) until this pass; corrected to `SETTLED` with the real `settledTxHash`. **Zero unsettled V1 deposits exist.** This means a future V1→V2 migration has nothing to strand — the audit's stated precondition ("all V1 deposits settled/refunded... before repointing") is already met today, for whatever that's worth if new V1 deposits are made before a migration happens.

**Item A implemented and tested, NOT deployed**: `DecisionRelay.sol` now has an explicit per-origin `SettlementMode` (`UNCONFIGURED`/`SETTLEMENT`/`NOTIFICATION_ONLY`), defaulting to `UNCONFIGURED`. `handle()` reverts for an unconfigured origin *before* `processedDecisions` is written — directly closing the exact failure mode that made the original incident unrecoverable. 5 new Foundry tests, including one that reproduces the incident scenario end-to-end (revert → still-false → configure → same message retried successfully) and one proving `NOTIFICATION_ONLY` never calls `settle()` even with a target configured. Full suite: 66 tests passing. This requires redeploying `DecisionRelay` itself (a bigger, riskier action than swapping `Escrow` — it holds the live attestor set and trustedSender wiring) and is explicitly **not deployed**, per the audit's own instruction not to touch `DecisionRelay`'s live configuration yet.

**Items B, C, D, E, F — explicitly not attempted this pass**, real, larger scopes each:
- B (bind app/relay/escrow to the same contract via a pre-dispatch invariant check) — real, scoped enough to be tractable next.
- C (a real `CaseSettlement`/`SettlementIntegration` creation UI, party-authorized deposit confirmation, integration tests against a real local EVM chain) — a genuinely large feature, not a same-session fix.
- D (a versioned settlement router or full V1 drain-before-cutover plan) — a real design decision needing operator input, not something to build speculatively.
- E (governed, time-bounded refund/escalation with multi-party approval) — a real, large feature.
- F (reconciliation job + real alert wiring) — already tracked as open in every prior addendum this session; still not built.

`SETTLEMENT_PAUSED` remains `true`. No production dispatch, no `DecisionRelay` redeploy, no `Escrow` V2 deployment, no governance change was made in this pass beyond the DB record correction (a status-field fix, not a chain mutation).

### 2026-09-03T15:28:07Z
- validator1 latest_index: 871811 | validator2 latest_index: 871811
- checkpoint_873170_with_id.json: validator1=404 validator2=404
- Escrow deposit status (1=DEPOSITED,2=SETTLED): 1
- Mailbox.delivered(messageId): true
- DecisionRelay.processedDecisions(decisionHash): true
