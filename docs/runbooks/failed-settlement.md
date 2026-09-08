# Runbook: failed testnet settlement (diagnose without DB-shell access)

This is the walkthrough acceptance criterion 3 ("operators can diagnose
a failed testnet settlement without database-shell access") is built
against — everything below uses `/settings/ops`,
`/settings/reconciliation-findings`, or public block explorers, never
`psql`/Prisma Studio.

## Step 1 — find the case on the ops console

Open `/settings/ops`. Check, in order:

1. **"Decisions awaiting dispatch"** — if the decision is listed here,
   dispatch hasn't succeeded yet. Note `relayAttempts` and `relayError`.
2. **"Pending signatures"** — if listed here instead, it's stuck on
   attestor co-signing, not dispatch itself — go to
   [signer-failure.md](signer-failure.md).
3. **"Settlement funnel"** — shows the latest `SignerLifecycleEvent`
   state per chain (`SIGNING` / `QUORUM_REACHED` / `DISPATCHED` /
   `DELIVERED` / `SETTLED` / `FAILED` / `ESCALATED`). A decision stuck
   at `DISPATCHED` (never `DELIVERED`) points at
   [relayer-failure.md](relayer-failure.md); stuck at `FAILED` or
   `ESCALATED` means the dispatch itself errored — its `relayError` is
   the next thing to read.
4. **"Open findings"** — check for `DISPATCHED_BUT_DB_STALE` (chain
   says settled, DB doesn't — self-heals automatically, see
   `lib/reconciliation.ts`'s `checkDispatchedButStale`),
   `AUDIT_ANCHOR_STALE` (a separate, unrelated audit-log job stalled —
   doesn't block settlement itself), or `CANARY_SLA_BREACH` (the
   automated probe itself failed, a strong signal the whole path is
   broken, not just this one case).

## Step 2 — confirm the real on-chain state

Never trust the DB status alone — this console deliberately exposes
what it read live wherever possible.

- EVM: `cast call <DecisionRelay> "processedDecisions(bytes32)(bool)" <decisionHash> --rpc-url $HYPERLANE_RELAY_RPC_URL`
- Escrow deposit state: `cast call <Escrow> "deposits(bytes32)" <escrowId> --rpc-url ...` (see `lib/escrow-version.ts` for the ABI shape per version).
- Solana: check the decision-relay program's Case PDA directly via
  `solana account <pda> --url $SOLANA_RPC_URL`, or the transaction by
  its `relayTxHash` on a Solana testnet explorer.

## Step 3 — classify and route

| What you see | Runbook |
|---|---|
| No attestor signatures collected at all | [signer-failure.md](signer-failure.md) |
| Dispatched but never delivered | [relayer-failure.md](relayer-failure.md) |
| Delivered but validator/ISM signatures missing | [validator-lag.md](validator-lag.md) |
| `relayError` is an RPC/network error | [rpc-outage.md](rpc-outage.md) |
| Settlement target wrong/zero, deposit overdue, or retries exhausted | [stuck-escrow.md](stuck-escrow.md) |
| On-chain governance (owner/threshold) doesn't match the manifest | [safe-governance-config-change.md](safe-governance-config-change.md) |

## Escalation

If none of the above explains it — the decision looks fine on-chain but
the DB genuinely disagrees in a way `checkDispatchedButStale` didn't
catch — that's a real reconciliation-logic gap, not an ops incident;
escalate to engineering with the decision id, case id, and the exact
on-chain reads from Step 2.
