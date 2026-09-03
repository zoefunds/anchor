# V1 → V2 Escrow cutover plan (Item D)

## Why this exists

`Escrow` V2 source (`chains/evm/contracts/Escrow.sol`, already committed — adds `caseId` to the `Deposit` struct and enforces it in `settle()`) has existed since earlier this session but has never been deployed. The re-audit's own instruction was explicit: **do not deploy it or repoint `DecisionRelay.settlementTarget` without a real migration plan first.** This is that plan.

## The structural constraint that shapes every option below

`DecisionRelay.settlementTarget(uint32 domain)` is a single global mapping, keyed only by Hyperlane domain (e.g. `11155111` for Sepolia) — **not** by case, integration, or escrow contract. There is exactly one live settlement target per domain at any moment. Repointing it to V2 redirects *every* case's dispatch on that domain simultaneously, including any case whose deposit still sits, unsettled, in V1.

This is the one fact that rules out "just deploy V2 and flip the target" as a safe default: if any V1 deposit is `DEPOSITED` (not yet `SETTLED`) at the moment of the flip, `DecisionRelay` calling into V2 for its dispatch means `settle()` is never reachable for that V1 deposit again through the normal path — it would need the same kind of manual recovery this project's own settlement-availability incident required (see `incidents/2026-09-03-settlement-availability.md`), and unlike that incident, there would be no way to construct a valid recovery dispatch, because `settle()` would be calling the *wrong contract entirely*, not just a wrong-but-callable target.

## Two options considered

### Option A — drain before cutover (recommended)

Settle or refund every V1 deposit first, confirm zero remain (via `scripts/cutover-readiness-check.sh`), *then* deploy V2 and repoint `settlementTarget`. Simple, no new contract complexity, matches how this project already operates (one active integration at a time — see `SettlementIntegration.active`).

**Cost**: cases can't be *newly bound* to a settlement integration during the drain window without deliberately choosing which version they'll settle against (see the freeze step below) — a short, planned pause in new escrow bindings, not in adjudication itself.

### Option B — a versioned settlement router

Insert a small router contract as `DecisionRelay`'s single `settlementTarget`, which itself dispatches to either V1 or V2 based on which escrow a given `escrowId`/`caseId` was actually deposited into. Lets V1 and V2 deposits coexist indefinitely.

**Cost**: a new contract, a new trust boundary, and — per this session's own hard-won lesson from the original incident — another piece of "is this wired correctly" state that can silently be misconfigured. Given this project has had **exactly one V1 deposit, ever** (per the Phase 0 inventory), building permanent dual-version routing to solve a coexistence problem that doesn't currently exist is speculative infrastructure for a case count of one.

**Decision: Option A.** Revisit Option B only if V1 deposit volume becomes large enough that a full drain before every future contract upgrade becomes impractical — not a decision to make in advance of that being true.

## The cutover procedure

Every step here is designed to be forced into the right order by the tooling, not just by discipline:

1. **Freeze new bindings.** Set every `active: true` `SettlementIntegration` pointing at the V1 escrow to `active: false` via `PATCH /api/settlement-integrations/:id` (see Item C). `POST /api/cases/:id/settlement` already refuses to bind to an inactive integration — this is an existing, enforced check, not a new one.
2. **Drain.** For every `CaseSettlement` still `DEPOSITED` against V1: let it settle normally (adjudication runs its course, `dispatchSettlementForDecision` fires as usual — nothing about the drain changes normal case handling), or, for a case that will never adjudicate, refund it (see Item E — a governed refund path is a prerequisite for this step being reliably completable, not optional).
3. **Confirm.** Run `scripts/cutover-readiness-check.sh` and require its exit code `0` (`READY`). It scans **every** `Deposited` event V1 has ever emitted (not just what `CaseSettlement` rows the DB happens to have — the DB record for this project's one real deposit was itself found stale once already this session) and independently re-derives each one's live status. Re-run it immediately before step 5 — state can change between confirmation and execution.
4. **Deploy V2 and update the app's ABI in the same release.** `lib/escrow.ts` and `lib/case-settlement.ts` currently call V1's `deposits()` ABI (4 return fields: `status, claimant, respondent, amount`). V2 adds a 5th (`caseId`) and `settle()` gains a `caseId` check. If the app's ABI changes before `settlementTarget` is repointed, every read against the still-live V1 contract mis-decodes (see the real bug this exact plan's own readiness script hit while being built — a 5-output ABI call against V1's 4-output `deposits()` returned an undecodable error, not a wrong-but-plausible value). If `settlementTarget` is repointed before the ABI changes, the same mis-decode happens against V2 instead. **These two changes ship as one deploy, one commit, one release — never separately.**
5. **Repoint governance.** The 2-of-2 Safe calls `DecisionRelay.setSettlementTarget(11155111, <V2 address>)` — same real governance procedure already used once this session (`docs/multisig-attestor-setup.md`), with `cast wallet verify` checked against both signatures before submission, same as before. `SETTLEMENT_PAUSED` stays exactly as it currently is throughout — this plan does not change that gate's own discipline (lift only for an explicitly authorized single action, re-arm immediately).
6. **Re-verify.** `cast call <DecisionRelay> "settlementTarget(uint32)(address)" 11155111` reads back V2. Bind one real (or rehearsal — see below) case to a fresh V2 `SettlementIntegration` and confirm the full path end to end before considering the cutover complete.

## Rehearsal (not yet performed — requires explicit authorization)

A "no customer funds" rehearsal means: deploy a *second*, throwaway `Escrow` V2 instance to Sepolia, register it as its own `SettlementIntegration`, bind a synthetic case created solely for this purpose (never a real org's case), deposit a trivial test amount, run it through `confirm-deposit` (Item C), and dispatch a real settlement — proving `settle()`'s new `caseId` enforcement actually works end to end — all without touching the live V1 contract, its one settled deposit, or `DecisionRelay`'s real `settlementTarget`. This is a genuine contract deployment and needs the same private-key handling discipline as every other deployment this session: **not attempted here — requires the user to run the deploy themselves, on explicit go-ahead**, exactly as `Escrow` V1's own deployment worked.

## Rollback

If step 5 (governance repoint) needs to be reversed before step 6 completes: the Safe can call `setSettlementTarget` again, pointing back at V1 — V1 itself is untouched by any of this and remains fully functional as long as it isn't drained of its ability to `settle()` (it never loses that ability; `onlyDecisionRelay` just means *some* `DecisionRelay` call reaches it, not that V1 is disabled). No contract-level rollback exists once step 5 executes and further V1 deposits are made after the repoint — which is exactly why step 1 (freeze new bindings) and step 3 (confirm zero unsettled) come first.

## What this plan deliberately does not cover

- **Item E** (a governed refund mechanism) is a real prerequisite for step 2 being reliably completable for a case that will never adjudicate — flagged, not built here.
- **Item F** (reconciliation/alerting) would be what actually notices a V1 deposit made *after* the freeze in step 1 — flagged, not built here.
- This plan does not itself authorize deploying V2, running the rehearsal, or repointing governance. Each remains a separate, explicit go/no-go decision, same discipline as every contract-affecting action this session.
