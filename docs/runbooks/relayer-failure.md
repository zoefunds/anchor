# Runbook: relayer failure (Hyperlane)

**Symptom:** A Decision reached `relayTxHash` (dispatch succeeded) but
never reaches the `DELIVERED` `SignerLifecycleEvent` state within SLA.
Surfaces as the `LATE_HYPERLANE_DELIVERY` reconciliation finding
(`lib/reconciliation.ts`'s `checkLateHyperlaneDelivery`, SLA controlled
by `RECONCILIATION_HYPERLANE_DELIVERY_SLA_MS`, default 1h) and in the
"Decisions awaiting dispatch"/settlement-funnel sections of
`/settings/ops`.

## Diagnosis

1. Confirm dispatch really happened on-chain: look up the recorded
   `relayTxHash` on Sepolia (`https://sepolia.etherscan.io/tx/<hash>`)
   — confirm the `Dispatch` event fired on the Mailbox contract.
2. Check the Hyperlane relayer process is running and processing
   messages for this route (see `docs/hyperlane-integration.md`) — a
   relayer that stopped polls will leave dispatched messages
   unprocessed indefinitely.
3. Check the message on the Hyperlane explorer
   (`https://explorer.hyperlane.xyz`, search by `relayMessageId`) —
   distinguishes "relayer hasn't picked it up yet" from "picked up but
   stuck waiting on ISM/validator signatures" (see
   [validator-lag.md](validator-lag.md) if the latter).
4. Check destination-side gas: the relayer's own destination-chain
   wallet balance — an empty relayer wallet can't submit `process()`
   even after building a valid message.

## Resolution

- Relayer process down: restart per its own deployment (this repo's
  relayer is not managed by `lib/worker.ts` — check
  `chains/hyperlane-validator/` / its own supervisor).
- Relayer wallet out of gas: fund it (testnet faucet or existing
  operator wallet) — do not send from any attestor/signer key used for
  custody.
- Stuck specifically on ISM/validator signatures: see
  [validator-lag.md](validator-lag.md).
- Once delivered, `checkLateHyperlaneDelivery` auto-resolves the
  finding on its next sweep tick (15 min) — no manual finding cleanup
  needed.

## Escalation

A relayer outage lasting past the testnet canary's own SLA
(`CANARY_SLA_MS`, default 15 min) will independently trip
`CANARY_SLA_BREACH` — treat a *simultaneous* canary breach and multiple
`LATE_HYPERLANE_DELIVERY` findings as one incident, not several, and
escalate as a full relay-path outage.
