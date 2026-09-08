# Runbook: testnet redeploy

**Symptom / trigger:** Redeploying `DecisionRelay`/`Escrow` contracts to
Sepolia or the Solana testnet program, or a new deployment address for
either. Also covers the `ESCROW_VERSION_MISMATCH` finding, which fires
when a live escrow contract's ABI shape no longer matches the
`escrowVersion` recorded for it — the real threat model this catches is
a redeploy at the same address (proxy upgrade or
selfdestruct+recreate), not a benign event.

## Procedure

1. Deploy the new contract(s) per the normal chain-specific deploy
   scripts under `chains/evm/` or `chains/solana/`.
2. Regenerate the committed manifest against the NEW address:
   `npx tsx apps/web/scripts/generate-deployment-manifest.ts` (EVM) —
   update the `DECISION_RELAY`/`SAFE` constants at the top of that
   script first if the address changed, then commit the regenerated
   `deployment-manifest.json`. Do the equivalent for
   `deployment-manifest.solana.json`.
3. Register/update `SettlementIntegration` rows pointing at the new
   escrow contract address(es) via the normal
   `/api/settlement-integrations` flow — do not silently reuse an old
   integration row with a new address, since `checkSettlementTargets`
   diffs live vs. `escrowContractAddress` and will raise
   `TARGET_INTEGRATION_MISMATCH` immediately if the two disagree.
4. Update `CANARY_SEPOLIA_SETTLEMENT_CONTRACT` /
   `CANARY_SOLANA_ESCROW_PROGRAM` (and related `CANARY_*` env vars) so
   the periodic canary exercises the new deployment, not a stale one.
5. Restart every process that reads the manifest at boot (worker,
   both attestor pollers) — `lib/startup-checks.ts` only reads the
   COMMITTED file, not a live source, so a stale in-memory manifest
   from before the redeploy will not self-correct without a restart.
6. Verify: `/settings/ops` should show a fresh, matching
   `settlementFunnel` once a real or canary decision runs through the
   new contract, with no `ESCROW_VERSION_MISMATCH` or
   `TARGET_INTEGRATION_MISMATCH` findings.

## Escalation

If `ESCROW_VERSION_MISMATCH` fires on a contract nobody intentionally
redeployed, treat it as a potential compromise (unexpected
selfdestruct+recreate or unauthorized proxy upgrade) — escalate before
assuming it's a benign redeploy that just wasn't communicated.
