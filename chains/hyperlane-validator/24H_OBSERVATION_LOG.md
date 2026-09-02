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

## Snapshot 3 — 2026-09-02 15:12 UTC (~5h52m elapsed, ~41% through the window)

| App | Machine state | Last restart | OOM | AccessDenied |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (unchanged) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (unchanged) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (the `12:25:56Z` "Last Updated" display artifact from Snapshot 2 is still shown by `flyctl status`, still with no boot-sequence log lines behind it — treated as the same non-event, not a new restart) | 0 | 0 |

**Checkpoint publication**: validator1 signed index `871653` (validator2 `871654`), live Mailbox nonce `873024`. Lag: validator1 `1371` leaves, validator2 `1370` leaves — against Snapshot 2's `871646`/nonce `873016`/lag `1370`, the signed index and the nonce both advanced by essentially the same amount (~7-8) in the ~78 minutes between snapshots. **This means contiguous backfill is not closing the gap at all — it is only barely keeping pace with new dispatches, not catching up.** This is the concerning version of "no real progress," not the initial ambiguous one: two consecutive snapshots now show the same ~1370-leaf lag persisting through real elapsed time and real new dispatch activity.

**Specific-message checkpoint coverage**: neither validator has yet published a checkpoint for the most recent production dispatch's leaf (nonce `872850`, unchanged since Snapshot 2 — no new production/rehearsal dispatch has occurred since then, only the earlier replay-test dispatch).

**Read-only verifier full run this snapshot**: 21 checks — the two `checkpoint-currency` checks are the only fails (both are this same backfill-lag finding); everything else pass/warn as expected, including the new destination-side ReplayGuard check (still confirms real presence on Solana Testnet) and the corrected checkpoint-coverage selection (still correctly targets nonce 872850, not the replay test).

**No production action taken.** `SETTLEMENT_PAUSED` untouched. Window remains IN PROGRESS — ~18h8m remaining to target end (2026-09-03 09:20 UTC). The flat backfill lag across two consecutive real-time-separated snapshots is now the dominant open question for this gate; if it is still flat at the deadline, per this file's own stated pass/fail criteria, this gate item should be marked FAILED and root-caused, not passed on a clean restart/OOM count alone.

## Snapshot 4 — 2026-09-02 16:16 UTC (~6h56m elapsed, ~29% remaining)

| App | Machine state | Last restart | OOM | AccessDenied |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (unchanged) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (unchanged) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (still showing the same `12:25:56Z` display-only artifact, no new boot-sequence lines) | 0 | 0 |

**Checkpoint publication**: both validators' signed index `871662`, live Mailbox nonce `873032`. Lag: `1370` leaves — index advanced +9, nonce advanced +8 since Snapshot 3 (64 minutes apart). **Third consecutive snapshot confirming the lag is not closing**: 1370 (Snapshot 2) → 1371/1370 (Snapshot 3) → 1370 (Snapshot 4). Validators are processing new checkpoints at essentially the same rate new messages arrive, never gaining ground on the backlog itself.

**Specific-message checkpoint coverage**: still no checkpoint published for nonce `872850` (unchanged — no new production/rehearsal dispatch since Snapshot 2).

**Read-only verifier**: 21 checks, 12 pass, 7 warn, 2 fail — same two checkpoint-currency fails, nothing else changed.

**No production action taken.** `SETTLEMENT_PAUSED` untouched. ~17h4m remaining to target end. With three consecutive snapshots now showing this lag genuinely static rather than trending down, the working assumption should shift from "still catching up" to "not going to close on its own before the window ends" — worth planning a root-cause pass (S3 backfill throughput? indexing bottleneck unrelated to RPC?) rather than waiting passively for the remaining ~17 hours to resolve it.

## Root-cause investigation — 2026-09-02 17:15-17:16 UTC (live log capture, read-only)

Captured live `flyctl logs` streams (not just the log buffer snapshot) for
30-45 second windows on both validators to directly observe what each is
actually doing in real time, rather than inferring from restart/OOM counts
alone.

**Confirmed, real, reproducible root cause on validator1**: its "dedicated"
Infura RPC endpoint is being rate-limited constantly. In a 30-second live
capture: **67 occurrences** of Infura's `-32005 Too Many Requests` error,
against a request pattern of 54× `eth_blockNumber`, 15× `eth_getBlockByNumber`,
6× `eth_call` — all bunched into sub-3-second bursts (`TipCheckpointSubmitter`,
`MetricsUpdater`, and the backfill `cursor_indexer_task` all firing on
overlapping ticks). `No Quorum reached` (an actually-failed, not just
retried, RPC call) appeared once in the same window. **Zero `eth_getLogs`
calls succeeded** in this window — the exact call the historical backfill
indexer needs to pull ranges of past Dispatch events and advance the
sequential checkpoint index. This is a genuinely different rate limit than
the one already fixed earlier this pass (that one was Infura's free-tier
`eth_getLogs` block-range cap, ~10000 blocks; this one is a requests-per-second
burst limit, tripped by concurrent polling from multiple validator subtasks
sharing one RPC endpoint) — the earlier "dedicated RPC" fix addressed
rate-limiting from the shared PUBLIC endpoint, but did not anticipate this
project's own multiple concurrent internal request sources exceeding a
still-constrained Infura plan's per-second burst allowance.

**Validator2 does NOT show this same signal** — a parallel 45-second live
capture showed zero rate-limit errors, zero `eth_getLogs` calls, and zero
`cursor_indexer_task` log lines at all (only steady `TipCheckpointSubmitter`
"Ingested leaves"/"reached correctness checkpoint" lines with an unchanging
merkle root and `checkpoint_queue_len: 0` throughout — consistent with the
TIP-tracking task being idle because no very-recent dispatch is pending, not
evidence about the separate historical backfill task). **This means
validator1's confirmed RPC rate-limiting is not, by itself, a complete
explanation for the lag** — validator2 (Alchemy-backed, not observed to be
rate-limited) shows an almost identical ~1370-leaf lag with no visible
backfill-indexer activity at all in over a minute of live capture. Root
cause is therefore **partially, not fully, established**:

- **Validator1**: real, measured, reproducible RPC-quota exhaustion
  starving the backfill indexer of the `eth_getLogs` calls it needs.
- **Validator2**: still genuinely unexplained by evidence gathered so far
  — its backfill task produced no visible log activity in ~75 seconds of
  combined capture across two windows, which is itself worth investigating
  further (possible causes not yet checked: log verbosity/level suppressing
  cursor-task progress after its first attempts, an internal
  interval/backoff separate from RPC health, or a genuine stall for a
  different reason). Do not assume the same Infura rate-limit explanation
  applies to validator2 just because the symptom (flat lag) matches —
  that would be exactly the kind of unverified inference this project has
  been correcting away from all session.

**No production action taken during this investigation** — read-only log
capture only, no secrets touched, no config or deploy changes, no plan
upgrades. `SETTLEMENT_PAUSED` untouched.

**Quick re-check — 2026-09-02 17:19 UTC** (~4 minutes after the root-cause
capture above, too soon for a new checkpoint-lag reading to carry any
signal): all three machines still `started` with unchanged `Last
Updated` timestamps — no restarts since the window began. Skipping a
full checkpoint-currency re-run this cycle; the next scheduled snapshot
(with real elapsed time behind it) will carry the next meaningful lag
data point.
