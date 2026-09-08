# Runbook: worker crash

**Symptom:** `apps/web/src/lib/worker.ts`'s BullMQ worker process
(`npm run worker`, see `src/worker.ts`) is not running or has exited.
Surfaces as: jobs (finalize/retry/audit-anchor/reconciliation sweeps)
stop appearing in logs; `/settings/ops` "Worker process" row stays
informational only (the API route runs in the web process, not the
worker); `SignerLifecycleEvent` and `ReconciliationFinding` rows stop
being created even though real cases keep reaching FINALIZED.

## Diagnosis

1. Check the process supervisor: `fly status -a <worker-app>` (Fly) or
   `pm2 status` / `systemctl status anchor-worker` depending on
   deployment. A crashed worker shows as stopped/restarting.
2. Pull recent logs: `fly logs -a <worker-app>` and grep for the last
   line before it stopped. Two known fatal-at-boot causes:
   - `StartupCheckError` from `lib/startup-checks.ts` (see
     [signer-failure.md](signer-failure.md) — as of this ops-console
     phase, this now also fires a critical `sendOpsAlert` before the
     process exits, so check Slack/ntfy for that alert's title).
   - `REDIS_URL is not set` / `assertDatabaseMatchesAppEnv` mismatch
     (`lib/app-env.ts`) — wrong environment's DB pointed at from the
     wrong app.
3. Confirm no *other* worker instance silently took over — this
   codebase's schedulers (`ensureFinalizeSweepScheduled`, etc.) use
   BullMQ's `upsertJobScheduler`, which is idempotent across replicas,
   so a second healthy worker masks a crashed one. Check
   `SignerLifecycleEvent`/`ReconciliationFinding.createdAt` recency via
   `/settings/ops` before assuming total outage.

## Resolution

1. Fix the root cause found above (rotate a bad env var, correct
   `DATABASE_URL`/`APP_ENV`, resolve a flagged deployment manifest).
2. Restart: `fly machine restart <machine-id>` or the supervisor's
   restart command.
3. Confirm recovery: `/settings/ops` should show fresh
   `settlementFunnel` counts and no growing `dispatchQueue` backlog
   within one `FINALIZE_SWEEP_INTERVAL_MS` (5 min).

## Escalation

If the worker restarts but immediately crashes again on the same
`StartupCheckError`, do not loop-restart it — that means the deployed
manifest/attestor configuration is genuinely wrong (see
[signer-failure.md](signer-failure.md)). Escalate to whoever holds
attestor-key custody before touching `deployment-manifest.json`.
