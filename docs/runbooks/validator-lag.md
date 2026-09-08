# Runbook: validator lag / checkpoint issue

**Symptom:** A Hyperlane message is dispatched and visible on the
Hyperlane explorer, but stuck waiting on ISM signature verification —
the self-hosted validator (see `docs/self-hosted-validator-setup.md`)
hasn't produced a recent checkpoint, or one validator in the ISM's set
is behind/offline. This looks identical to a plain relayer failure from
`/settings/ops` (both surface as `LATE_HYPERLANE_DELIVERY`) — this
runbook is for when [relayer-failure.md](relayer-failure.md)'s own
diagnosis step 3 (Hyperlane explorer) shows the message stuck
specifically on signatures, not on relayer pickup.

## Diagnosis

1. Check each validator's own checkpoint storage (S3/GCS bucket or
   local, per `docs/self-hosted-validator-setup.md`) for its latest
   signed checkpoint index and timestamp.
2. Compare checkpoint index across all validators in the ISM's set — a
   validator more than a few blocks behind the others is lagging; one
   producing no new checkpoints at all is down.
3. Check the lagging/down validator's own process logs
   (`fly logs -a <validator-app>` or equivalent) for RPC errors,
   disk/storage-write failures, or crashes.
4. Confirm the ISM's configured threshold (`interchainSecurityModule`
   in `deployment-manifest.json`) still requires only a subset of
   validators — a single validator down should not block delivery if
   the ISM threshold is below the full validator count; if it's
   blocking despite that, the threshold itself may be misconfigured.

## Resolution

1. Restart the lagging/down validator process.
2. If its checkpoint storage is corrupted or unreachable, redeploy from
   a clean checkpoint start per `docs/self-hosted-validator-setup.md`
   — validators reprocess from their own last-known checkpoint, so a
   fresh start is safe, only briefly slower to catch up.
3. Confirm recovery: the stuck message's checkpoint requirement is now
   met and it delivers; `LATE_HYPERLANE_DELIVERY` finding for that
   decision self-resolves on the next reconciliation sweep.

## Escalation

Validator independence (A/B/C operator/account separation) is a
tracked governance property — see
`docs/mainnet-readiness-runbook.md` section 0. Do not "temporarily"
run two validators from the same operator/account to work around a lag
incident; that silently degrades the independence property this repo
tracks explicitly. Escalate instead.
