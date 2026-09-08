# Runbook: RPC outage

**Symptom:** `/settings/ops`'s health section shows `sepoliaRpc.ok:
false` or `solanaRpc.ok: false`. Downstream effects: dispatch attempts
fail with a generic network error (not a real on-chain revert),
`checkGovernanceDrift`/`checkSettlementTargets` log
`"failed to read..."` and skip that tick rather than raising a false
finding (both are deliberately fail-soft on RPC errors — see
`lib/reconciliation.ts`), and the canary may report `outcome: "error"`.

## Diagnosis

1. Confirm it's the RPC endpoint, not the whole chain: try a second
   provider directly, e.g.
   `curl -s -X POST https://ethereum-sepolia.publicnode.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`
2. Check which env var is pointed at the failing endpoint:
   `HYPERLANE_RELAY_RPC_URL` (EVM) or `SOLANA_RPC_URL` (Solana) — see
   `apps/web/.env.example`.
3. Free public RPC endpoints (this is a testnet deployment with no paid
   RPC budget — see `docs/mainnet-readiness-runbook.md` section 3) have
   no SLA; rate-limiting/temporary unavailability is expected
   occasionally, not necessarily an incident.

## Resolution

1. Swap to a known-good alternate public endpoint for the affected
   chain and redeploy the affected process(es) (web, worker, attestor
   pollers all read the same env var).
2. If the outage is provider-wide, wait it out — reconciliation and the
   canary are designed to fail soft and re-check on their own next
   tick, not to require manual recovery once the RPC comes back.
3. After recovery, manually trigger a reconciliation sweep tick (or
   wait up to 15 min) and confirm `/settings/ops`'s health section
   turns green again before considering this resolved.

## Escalation

An RPC outage lasting long enough that attestor pollers can't dispatch
at all risks compounding into [signer-failure.md](signer-failure.md)'s
stale-pending-signature state — if the outage exceeds
`RECONCILIATION_STALE_SIGNATURE_MS` (24h default), treat it as a
combined incident.
