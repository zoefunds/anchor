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

### 2026-09-03T15:28:07Z
- validator1 latest_index: 871811 | validator2 latest_index: 871811
- checkpoint_873170_with_id.json: validator1=404 validator2=404
- Escrow deposit status (1=DEPOSITED,2=SETTLED): 1
- Mailbox.delivered(messageId): true
- DecisionRelay.processedDecisions(decisionHash): true
