# 24-hour validator reliability observation log

Gate item 3 of the six-point `SETTLEMENT_PAUSED` unpause gate:
"Validators run for at least 24 hours with checkpoint currency
confirmed, not only heartbeat freshness." Started once dedicated RPC
(gate item 5) was confirmed live on all three apps, per explicit
sequencing instruction — this window is now measuring real validator
stability against a real dedicated RPC, not the previously
rate-limited shared public one.

**Start time**: 2026-09-02 09:20 UTC (approximate — first snapshot below)
**Target end time**: 2026-09-03 09:20 UTC (24h from start)
**Status**: IN PROGRESS

Each snapshot below is captured by directly querying `flyctl status`,
`flyctl logs`, and re-running `verify-deployment.ts` against a
dedicated RPC — not assumed or estimated between checks.

---

## Snapshot 1 — 2026-09-02 09:20 UTC (start)

| App | Machine state | Last restart | OOM count (log buffer) | AccessDenied count (log buffer) |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (RPC redeploy) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (RPC redeploy) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (RPC redeploy) | 0 | 0 |

Baseline. All three machines healthy immediately after the dedicated-RPC redeploy. Log-buffer counts reset with each restart (Fly's log retention is a rolling window, not a persistent counter) — this is why each snapshot's "count" is only meaningful for what's happened since the machine's last restart, not a running total. A restart between snapshots will be visible via a changed "Last restart" timestamp, which is the real signal to watch for.
