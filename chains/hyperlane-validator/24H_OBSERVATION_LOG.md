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

**Pass/fail criteria for this gate item, stated explicitly up front**:
this window fails if, by the target end time, there is any unexplained
machine restart, any OOM kill, any `AccessDenied` recurrence, or the
contiguous backfill lag has made no real progress at all (currently
`1370` leaves and not shrinking — tracked every snapshot below, not
just restart/OOM counts). A clean restart/OOM/AccessDenied count alone
is necessary but not sufficient — a validator that never crashes but
also never catches up on backfill has not actually demonstrated the
"checkpoint currency confirmed" half of this gate's own wording.

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

## Snapshot 2 — 2026-09-02 14:04 UTC (~4h44m elapsed)

| App | Machine state | Last restart | OOM | AccessDenied |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (unchanged) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (unchanged) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (unchanged — a `12:25:56Z` "Last Updated" seen at one intermediate check was confirmed a Fly status-display artifact, not a real restart: same machine version, no boot-sequence log lines) | 0 | 0 |

**Checkpoint publication** (per `verify-deployment.ts`'s `checkpoint-currency` check, run against a dedicated RPC): both validators' signed checkpoint index is `871646`, live Mailbox nonce is `873016` — contiguous backfill lag `1370` leaves, unchanged in magnitude since this pass's earlier checks (the lag isn't closing over real elapsed time, which is itself worth watching, not just the absolute restart/OOM counts). Per the audit's own note, this lag alone does not prove delivery is broken — see next.

**Specific-message checkpoint coverage** (`message-checkpoint-coverage` check): neither validator has yet published a checkpoint covering the most recent real dispatch's leaf (nonce `872991`) — informational, not a failure by itself; this is what determines whether *that specific* message can be delivered, independent of the contiguous lag above.

No restarts, no OOM, no AccessDenied across all three since the window started. The unclosing backfill lag is the one real open question this window should keep tracking — if it's still `~1370` at the 24h mark with zero progress, that's a different, more concerning finding than "validators are merely behind."
