# Runbook: Safe governance configuration change

Covers the `GOVERNANCE_DRIFT` finding (`lib/reconciliation.ts`'s
`checkGovernanceDrift`) and any intentional change to `DecisionRelay`'s
owner, `attestorThreshold`, or the Safe's own owners/threshold.

**Symptom:** `/settings/ops` or `/settings/reconciliation-findings`
shows `GOVERNANCE_DRIFT`: live `DecisionRelay.owner()` or
`attestorThreshold()` no longer matches the committed
`deployment-manifest.json`.

## Diagnosis

1. Determine whether this was an **authorized** change (a real Safe
   transaction the team executed) or **unexpected**.
2. For an authorized change: check the Safe transaction on
   `https://app.safe.global` (or Etherscan for the raw tx) — confirm it
   matches what was intended (correct new owner/threshold, correct
   number of confirmations for the Safe's own multisig threshold).
3. For an unexpected change: this is a potential governance compromise.
   Do not proceed past this step outside of a live incident response —
   escalate immediately per this file's Escalation section below.

## Resolution (authorized change only)

1. Regenerate the manifest to make the new state the new committed
   baseline: `npx tsx apps/web/scripts/generate-deployment-manifest.ts`
   — update `SAFE`/`DECISION_RELAY` constants at the top of that script
   first if either address itself changed. Review the printed
   `flags[]` array; a new flag (e.g. Safe threshold now below 2) means
   the change itself introduced a new tracked risk, not just a
   difference from the old manifest.
2. Commit the regenerated `deployment-manifest.json` /
   `deployment-manifest.solana.json`.
3. Restart every process that loads the manifest at boot (worker, both
   attestor pollers) — see [testnet-redeploy.md](testnet-redeploy.md)
   step 5, same reasoning.
4. Confirm `GOVERNANCE_DRIFT` resolves on the next reconciliation sweep
   (live state now matches the freshly committed manifest).

## Escalation — unexpected/unauthorized change

Treat as a live security incident, not a routine ops task:

1. Page whoever holds Safe-owner keys immediately — confirm all owner
   keys are still under expected custody.
2. Do NOT regenerate the manifest to match the drifted state — that
   would launder an unauthorized change into the trusted baseline.
   Leave `GOVERNANCE_DRIFT` open until the change is understood.
3. If attestor keys may be compromised, follow
   [key-exposure-response.md](key-exposure-response.md) in parallel —
   governance and custody compromise often go together.
4. See `docs/mainnet-readiness-runbook.md` for this repo's broader
   governance-independence tracking; a drift event should feed back
   into that document's own risk log.
