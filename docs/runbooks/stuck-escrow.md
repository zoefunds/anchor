# Runbook: stuck escrow

Covers `ZERO_SETTLEMENT_TARGET`, `TARGET_INTEGRATION_MISMATCH`,
`OVERDUE_DEPOSIT`, and `RELAY_RETRIES_EXHAUSTED` findings — all mean a
real case's funds are not moving when they should be.

## Diagnosis

1. Identify which of the four findings fired — each names the exact
   problem in `alertDetail` (visible on `/settings/reconciliation-findings`
   and linked from `/settings/ops`):
   - **`ZERO_SETTLEMENT_TARGET`** — `DecisionRelay.settlementTarget(domain)`
     reads the zero address for a domain with an active integration.
     Nobody configured (or it was reset) the on-chain target.
   - **`TARGET_INTEGRATION_MISMATCH`** — the live target doesn't match
     the `SettlementIntegration.escrowContractAddress` this case
     expects. Either the wrong integration is registered, or the
     on-chain target was pointed elsewhere.
   - **`OVERDUE_DEPOSIT`** — both parties set their settlement
     address over `RECONCILIATION_OVERDUE_DEPOSIT_MS` (24h default) ago
     but no on-chain deposit arrived.
   - **`RELAY_RETRIES_EXHAUSTED`** — `Decision.relayAttempts` hit
     `MAX_RELAY_ATTEMPTS` (10) without ever setting `relayTxHash`; read
     `Decision.relayError` for the last real dispatch failure.
2. For target-mismatch findings, read the contract directly:
   `cast call <DecisionRelay> "settlementTarget(uint32)(address)" <domain> --rpc-url $HYPERLANE_RELAY_RPC_URL`.
3. For overdue deposits, check whether the party actually sent funds to
   the wrong address (a support/comms issue) vs. genuinely hasn't paid.
4. For exhausted retries, `relayError`'s exact text usually points at
   one of: RPC failure (see [rpc-outage.md](rpc-outage.md)), an
   on-chain revert (wrong escrow state — read `deposits()` directly),
   or an attestor quorum problem (see
   [signer-failure.md](signer-failure.md)).

## Resolution

- `ZERO_SETTLEMENT_TARGET` / `TARGET_INTEGRATION_MISMATCH`: the
  DecisionRelay owner (the Safe) must call `setSettlementTarget(domain,
  address)` to point it at the correct `SettlementIntegration.escrowContractAddress`.
  This is a governance action — follow
  [safe-governance-config-change.md](safe-governance-config-change.md).
- `OVERDUE_DEPOSIT`: contact the party directly; if funds went to the
  wrong address entirely, that's outside this app's control (testnet —
  no recovery mechanism for misdirected funds is provided).
- `RELAY_RETRIES_EXHAUSTED`: fix the underlying `relayError` cause,
  then manually reset for one more attempt by clearing the decision's
  claim lease — do not hand-edit `relayAttempts`; instead re-run
  `retryFailedSettlements` in `lib/adjudication-service.ts` once the
  root cause is fixed (it's the same code path the periodic sweep uses,
  callable via a one-off script or by waiting for the next scheduled
  tick after root-causing).

## Escalation

`ZERO_SETTLEMENT_TARGET` and `TARGET_INTEGRATION_MISMATCH` are marked
critical because they mean settlement is *structurally* impossible for
every case on that domain, not just one — escalate immediately, don't
wait for the next case to also fail.
