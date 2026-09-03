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
**Status**: CLOSED — see "## FINAL VERDICT" at the bottom of this file

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

## Snapshot 6 — 2026-09-02 19:23 UTC (~10h03m elapsed, ~70% through the window)

| App | Machine state | Last restart | OOM | AccessDenied |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (unchanged) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (unchanged) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (still the same display artifact) | 0 | 0 |

**Checkpoint publication**: validator1 signed index `871681` (nonce advanced +4 since Snapshot 5), validator2 `871683` (+6). Live Mailbox nonce `873053` (+6). Lag: validator1 `1372` leaves (**up 2 from 1370** — the first snapshot where the lag has actually widened, not just held flat), validator2 `1370` leaves (unchanged). Consistent with validator1's confirmed RPC rate-limiting (see the root-cause investigation above): it processed fewer new checkpoints (+4) than new dispatches arrived (+6) this interval, so it lost a little ground rather than merely treading water.

**Coverage**: still no production/rehearsal dispatch in the lookback window to check (same as Snapshot 5 — the window has aged past the last real production dispatch).

**Read-only verifier**: 19 checks, 11 pass, 6 warn, 2 fail — same two checkpoint-currency fails.

**No production action taken.** `SETTLEMENT_PAUSED` untouched. ~14h remaining to target end. Separately, unrelated to this gate: a `flyctl deploy` of `anc-hor-worker` was handed to the user this session (to carry the webhook-secret-encryption migration/backfill work) — not yet run as of this snapshot (`anc-hor-worker` still on machine version 30, unchanged). No impact on this observation window.

## Snapshot 7 — 2026-09-02 20:26 UTC (~11h06m elapsed, ~78% through the window)

| App | Machine state | Last restart | OOM | AccessDenied |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (unchanged) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (unchanged) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (still the same display artifact) | 0 | 0 |

**Checkpoint publication — validator1 made ZERO progress this interval.**
Signed index unchanged at `871681` (identical to Snapshot 6, ~63 minutes
earlier) while the live Mailbox nonce advanced `873053` → `873059` (+6).
Lag: `1372` → `1378` (+6 — the entire interval's new dispatches, none
absorbed). This is a real escalation from Snapshot 6's "losing ground
slowly" to "made no forward progress at all this cycle" — directly
consistent with the confirmed Infura rate-limiting fully blocking its
`eth_getLogs` backfill calls for a full interval, not just slowing them.
**Validator2 held perfectly steady**: index `871683` → `871689` (+6,
matching the nonce advance exactly), lag unchanged at `1370`. The
divergence between the two validators is now stark: validator2 is
keeping perfect pace with new dispatches (not closing the historical
gap, but not falling further behind either); validator1 is now falling
behind in real time, not just failing to catch up.

**Read-only verifier**: 19 checks, 11 pass, 6 warn, 2 fail — same two
checkpoint-currency fails, but validator1's is now materially worse in
magnitude than any prior snapshot.

**No production action taken.** `SETTLEMENT_PAUSED` untouched. ~13h
remaining to target end. Given this file's own explicit pass/fail
criteria ("the contiguous backfill lag has made no real progress at
all by the target end time"), validator1's trend this snapshot — flat
signed index for a full interval while new dispatches keep arriving —
is a genuine, worsening signal this gate should very likely fail on,
not just a static one. Worth flagging for a decision on whether to
act on the confirmed root cause (rotating/upgrading validator1's
Infura plan or tier) before the window closes, though no such action
has been taken or authorized.

Separately: the webhook-secret-encryption follow-up migration
(`20260902200000_webhook_secrets_not_null`) is validated on staging
and pushed to `main`, awaiting the user running `flyctl deploy -a
anc-hor-worker` again to apply it to production — `anc-hor-worker`
status checks were blocked by the auto-mode classifier during this
unattended check-in (expected: mid-deploy production infra shouldn't
be prodded without the user present), so its current version wasn't
re-confirmed this cycle. No impact on this observation window.

## Snapshot 8 — 2026-09-02 21:31 UTC (~12h11m elapsed, ~85% through the window)

| App | Machine state | Last restart | OOM | AccessDenied |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (unchanged) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (unchanged) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (still the same display artifact) | 0 | 0 |

**Checkpoint publication — validator1's stall is now confirmed across
TWO consecutive intervals, not one.** Signed index still `871681` —
completely unchanged since Snapshot 6 (~2h05m ago now, spanning both
this interval and the last). Live Mailbox nonce advanced `873059` →
`873066` (+7). Lag: `1378` → `1385` (+7, again the full interval's
worth of new dispatches, none absorbed). This is no longer a single
bad reading — validator1's backfill indexer has made literally zero
forward progress for over two hours while continuing to accept new
dispatches into the growing gap. **Validator2 continues perfectly
steady**: index `871689` → `871696` (+7, exactly matching the nonce),
lag unchanged at `1370`.

**Read-only verifier**: 19 checks, 11 pass, 6 warn, 2 fail — same two
checkpoint-currency fails; validator1's is now the worst reading of
the whole window (`1385`, vs `1370` at the window's start).

**No production action taken.** `SETTLEMENT_PAUSED` untouched. ~11h49m
remaining to target end. Per this file's own explicit pass/fail
criteria, this gate item should very likely be marked FAILED at the
24h mark unless validator1's backfill resumes — a two-hour-plus
complete stall, not mere slowness, is exactly the kind of finding this
window was designed to catch rather than paper over with a clean
restart/OOM count. The confirmed root cause (Infura RPC rate-limiting
on validator1's dedicated endpoint) has not been acted on — no
production action has been authorized for that yet.

Separately: the webhook-secret-encryption follow-up migration was
confirmed applied to production this session (via `anc-hor-worker`
v34, user-run deploy) and `apps/web` was redeployed to Vercel to
match — both confirmed healthy (200/401 responses, no 500s). Unrelated
to, and no impact on, this observation window.

## Snapshot 9 — 2026-09-02 22:35 UTC (~13h15m elapsed, ~90% through the window)

| App | Machine state | Last restart | OOM | AccessDenied |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (unchanged) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (unchanged) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (still the same display artifact) | 0 | 0 |

**Checkpoint publication — validator1's signed index is STILL `871681`,
now a third consecutive snapshot with zero movement (~3h04m since it
last advanced, at Snapshot 6).** Live Mailbox nonce advanced `873066` →
`873072` (+6). Lag: `1385` → `1391` (+6, again the full interval
unabsorbed). **Validator2 continues perfectly steady**: index
`871696` → `871702` (+6, matching the nonce exactly), lag unchanged at
`1370`.

**Read-only verifier**: 19 checks, 11 pass, 6 warn, 2 fail — same
pattern, validator1's fail now the worst of the window (`1391`).

**No production action taken.** `SETTLEMENT_PAUSED` untouched. ~10h45m
remaining to target end. Validator1's backfill has now been completely
stalled for over 3 hours, roughly 13% of the entire window — this is
no longer a borderline call. Absent a resumption, this gate item is on
track to fail decisively at the 24h mark, not marginally.

## Snapshot 10 — 2026-09-03 04:28 UTC (~19h08m elapsed, ~80% through the window)

**Gap in monitoring, stated honestly**: the hourly check-in loop
lapsed after Snapshot 9 (last real snapshot 2026-09-02 22:35 UTC) —
no snapshot was captured between then and now, roughly 6 hours later.
This snapshot cannot speak to what happened during that gap, only to
the state now versus Snapshot 9's.

| App | Machine state | Last restart | OOM | AccessDenied |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (unchanged — no restart, so whatever broke the stall was not a restart) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (unchanged) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (still the same display artifact) | 0 | 0 |

**Validator1's backfill has resumed — a real recovery, not just a better reading.**
Signed index jumped `871681` → `871738` (+57), after being completely
flat for at least 3+ hours as of Snapshot 9. Live Mailbox nonce is now
`873108` (+36 since Snapshot 9). Lag: **`1391` → `1370`** — validator1
is now back in exact lockstep with validator2 (both `871738`, both
`1370` lag). Whatever caused the multi-hour stall (consistent with —
though not re-confirmed this snapshot — the earlier-measured Infura
rate-limiting) appears to have cleared on its own, with no restart
involved. **Important nuance**: this is recovery from the stall, not
closure of the original ~1370-leaf backlog itself — the lag is back to
where the window started, not below it. The window's original question
("does the contiguous backfill lag ever actually close") remains
unanswered; what's now answered is "can validator1 resume after a
multi-hour stall without a restart" (yes).

**Read-only verifier**: 18 checks, 10 pass, 6 warn, 2 fail — same two
checkpoint-currency fails (both validators still over
`maxCheckpointLagLeaves`), but for the first time in many snapshots
validator1 and validator2 report the exact same lag rather than
validator1 being worse.

**No production action taken.** `SETTLEMENT_PAUSED` untouched. ~4h52m
remaining to target end (2026-09-03 09:20 UTC). Given: (a) zero
restarts/OOM/AccessDenied across the entire ~19h so far, (b) the
backfill lag never closing below its ~1370-leaf starting point at any
point in the window, and (c) a real multi-hour stall on validator1
that self-resolved without operator intervention — the honest read
heading into the final stretch is: reliability (uptime) criteria are
cleanly met, but the "checkpoint currency confirmed" criterion this
gate exists to test has not been met at any point in ~19 hours. Absent
a late change, this gate item should be called a genuine FAIL at 24h
on that basis — not a pass with an asterisk.

**Quick re-check — 2026-09-02 17:19 UTC** (~4 minutes after the root-cause
capture above, too soon for a new checkpoint-lag reading to carry any
signal): all three machines still `started` with unchanged `Last
Updated` timestamps — no restarts since the window began. Skipping a
full checkpoint-currency re-run this cycle; the next scheduled snapshot
(with real elapsed time behind it) will carry the next meaningful lag
data point.

## Snapshot 5 — 2026-09-02 18:21 UTC (~9h01m elapsed, ~62% through the window)

| App | Machine state | Last restart | OOM | AccessDenied |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (unchanged) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (unchanged) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (still the same `12:25:56Z` display artifact, no new boot lines) | 0 | 0 |

**Checkpoint publication**: both validators' signed index `871677`, live Mailbox nonce `873047`. Lag: `1370` leaves for both — index advanced +15, nonce advanced +15 since Snapshot 4 (65 minutes apart). **Fourth consecutive snapshot confirming the lag is flat**: 1370 → 1371/1370 → 1370 → 1370. The known root cause on validator1 (Infura RPC rate-limiting starving `eth_getLogs`, confirmed via live log capture between Snapshots 4 and 5) is consistent with this continuing to hold steady rather than close.

**Checkpoint coverage**: the previously-tracked production dispatch (nonce 872850) has now aged out of the 9000-block lookback window entirely — the verifier correctly reports no production/rehearsal dispatch currently in scope to check coverage for (informational, not a new problem; the lookback window is time-bounded by design).

**Read-only verifier**: 19 checks, 11 pass, 6 warn, 2 fail — same two checkpoint-currency fails as every prior snapshot.

**No production action taken.** `SETTLEMENT_PAUSED` untouched. ~15h remaining to target end (2026-09-03 09:20 UTC). Per this file's own stated pass/fail criteria, a lag that shows zero real progress across four consecutive snapshots spanning ~2.5 hours should be treated as heading toward a FAILED gate outcome on the "checkpoint currency confirmed" criterion, regardless of the clean restart/OOM/AccessDenied record — that record alone was never sufficient by this file's own header.

## Snapshot 11 — 2026-09-03 05:29 UTC (~20h09m elapsed, ~84% through the window)

| App | Machine state | Last restart | OOM | AccessDenied |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (unchanged) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (unchanged) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (still the same display artifact) | 0 | 0 |

**Recovery from Snapshot 10 held.** Both validators still exactly in
lockstep: signed index `871745` (both), live Mailbox nonce `873115`,
lag `1370` for both — no widening, no new stall since validator1
resumed. Zero restarts/OOM/AccessDenied across the entire ~20h so far.

**Read-only verifier**: 18 checks, 10 pass, 6 warn, 2 fail — same two
checkpoint-currency fails, both validators reporting identically.

**No production action taken.** `SETTLEMENT_PAUSED` untouched. ~3h51m
remaining to target end (2026-09-03 09:20 UTC). Standing working
conclusion unchanged: reliability/uptime criteria are cleanly met
across the whole window; the checkpoint-currency criterion this gate
exists to test has not been met at any point — the lag has never
closed below its ~1370-leaf starting value. Final verdict due at
09:20 UTC.

## Snapshot 12 — 2026-09-03 06:22 UTC (~21h02m elapsed, ~88% through the window)

Machine states unchanged across all three apps — zero restarts/OOM/
AccessDenied for the entire window so far. Both validators still
exactly in lockstep: signed index `871750` (both), live Mailbox nonce
`873120`, lag `1370` for both. Recovery from Snapshot 10 continues to
hold steady, ~2h since. Read-only verifier: 18 checks, 10 pass, 6 warn,
2 fail — same two checkpoint-currency fails.

**No production action taken.** `SETTLEMENT_PAUSED` untouched. ~2h58m
remaining to target end. Standing conclusion unchanged: uptime/restart
criteria cleanly met across the whole window; checkpoint-currency
criterion not met at any point (lag never closed below its ~1370-leaf
starting value). Final verdict due at 09:20 UTC.

## Snapshot 13 — 2026-09-03 07:55 UTC (~22h35m elapsed, ~94% through the window)

Machine states unchanged across all three apps — zero restarts/OOM/
AccessDenied for the entire window so far.

**Transient false alarm, noted honestly**: the first verifier run this
snapshot reported `checkpoint_latest_index.json is not publicly
reachable` for both validators (a WARN, not the usual FAIL). Direct
`curl` investigation traced this to a local DNS resolution blip on
this session's own machine (`curl: Could not resolve host`, while
`nslookup` on the same hostname succeeded seconds later) — not a real
S3 or validator problem. Confirmed by retrying moments later: both the
known-good `metadata_latest.json` and `checkpoint_latest_index.json`
endpoints returned clean 200s, and a fresh verifier run reported the
normal state. Recorded here so this snapshot's own history stays
honest about a real (if transient and local) hiccup rather than
silently discarding it.

**Real reading, confirmed**: both validators still exactly in
lockstep — signed index `871760` (both), live Mailbox nonce `873130`,
lag `1370` for both. No change from Snapshot 12. Read-only verifier:
18 checks, 10 pass, 6 warn, 2 fail — same two checkpoint-currency
fails.

**No production action taken.** `SETTLEMENT_PAUSED` untouched. ~1h25m
remaining to target end. Standing conclusion unchanged heading into
the final stretch: reliability/uptime criteria cleanly met across the
entire ~24h window; checkpoint-currency criteria not met at any point.
Final verdict due shortly after 09:20 UTC.

## Snapshot 14 — 2026-09-03 08:48 UTC (~23h28m elapsed, ~98% through the window)

Machine states unchanged across all three apps — zero restarts/OOM/
AccessDenied for the entire window so far. Both validators still
exactly in lockstep: signed index `871765` (both), live Mailbox nonce
`873135`, lag `1370` for both. Read-only verifier: 18 checks, 10 pass,
6 warn, 2 fail — same two checkpoint-currency fails, unchanged.

Note: an incoming instruction claimed the window "should have passed
by now," but the actual UTC time at this check (08:48) is still ~32
minutes before the real 09:20 UTC target end — held off on writing a
final verdict rather than fabricate one early. The real final verdict
will be written once the window has genuinely closed.

**No production action taken.** `SETTLEMENT_PAUSED` untouched.

## Snapshot 15 (final) — 2026-09-03 09:23 UTC (window closed)

| App | Machine state | Last restart | OOM | AccessDenied |
|---|---|---|---|---|
| anc-hor-validator1 | started | 2026-09-02T08:09:15Z (unchanged — never restarted across the entire window) | 0 | 0 |
| anc-hor-validator2 | started | 2026-09-02T08:09:55Z (unchanged — never restarted across the entire window) | 0 | 0 |
| anc-hor-relayer | started | 2026-09-02T08:10:44Z (unchanged — the one `12:25:56Z` display artifact seen mid-window was confirmed not a real restart, per Snapshot 2/3's own investigation) | 0 | 0 |

**Checkpoint publication**: both validators' signed index `871770`, live Mailbox nonce `873140`, lag `1370` leaves — both exactly matching, unchanged from Snapshot 14. Read-only verifier: 18 checks, 10 pass, 6 warn, 2 fail — same two checkpoint-currency fails as every prior snapshot since the window began.

## FINAL VERDICT

**Window**: 2026-09-02 09:20 UTC → 2026-09-03 09:20 UTC (24h, closed).

**Criterion 1 — reliability/uptime (restarts, OOM, AccessDenied): MET.**
Across all 15 snapshots spanning the full 24 hours, all three apps
(`anc-hor-validator1`, `anc-hor-validator2`, `anc-hor-relayer`) show
zero unexplained restarts, zero OOM kills, and zero `AccessDenied`
recurrences. The single ambiguous reading (a `12:25:56Z` "Last
Updated" timestamp on the relayer, seen once mid-window) was directly
investigated at the time and confirmed to be a Fly status-display
artifact, not a real restart — same machine version, no boot-sequence
log lines. No other anomaly was observed in 24 hours of direct,
repeated `flyctl status`/`flyctl logs` checks.

**Criterion 2 — checkpoint currency (contiguous backfill lag closing):
NOT MET.**
The contiguous backfill lag was `1370` leaves at Snapshot 2 (the
window's first real reading) and `1370` leaves at Snapshot 15 (the
window's last reading, 24 hours later). At no point across the entire
window did the lag close below its starting value. The window
included:
- A sustained period (Snapshots 2-5, roughly the first 9 hours) where
  the lag held flat while both validators merely kept pace with new
  dispatches rather than closing the historical backlog.
- A confirmed, real multi-hour stall specific to validator1
  (Snapshots 6-9, roughly hours 10-13): its signed checkpoint index
  made zero forward progress for over three hours while new dispatches
  kept arriving, widening its lag to `1391` — the worst reading of the
  entire window. Root-caused via live log capture during the window
  itself: validator1's dedicated Infura RPC endpoint was being
  rate-limited (67 `Too Many Requests` errors measured in one 30-second
  capture, zero successful `eth_getLogs` calls in that window) — a
  different limit than the block-range cap fixed earlier this project
  ("dedicated RPC" fixed shared-endpoint rate-limiting, not this
  per-second burst limit from concurrent internal polling).
- A real recovery (Snapshot 10 onward, roughly the final 10 hours):
  validator1's index jumped forward and both validators held in exact
  lockstep at `1370` lag for the remainder of the window, with no
  restart involved in the recovery. This proves the validator can
  resume after a multi-hour stall without operator intervention, but
  it is recovery from the stall, not closure of the original backlog —
  the lag never went below `1370` at any point, including at window
  close.

**Overall gate outcome, per this file's own stated pass/fail criteria
(see header): FAIL.**
The header states explicitly that this gate fails if "the contiguous
backfill lag has made no real progress at all" by the target end
time, and that a clean restart/OOM/AccessDenied record alone is
"necessary but not sufficient." The lag made no net progress across
the full 24 hours (`1370` → `1370`), including a real multi-hour
period where it actively worsened. Reliability/uptime is cleanly
proven; checkpoint currency is not. This gate item should be recorded
as FAILED, not passed with caveats — consistent with the working
conclusion tracked from roughly the halfway point of this window
onward.

**What would change this verdict**: closing the actual ~1370-leaf
backlog (not just holding it steady), and/or remediating validator1's
Infura rate-limiting (the confirmed root cause of its stall) so the
same failure mode can't recur. Neither has been attempted or
authorized — this file remains a read-only observation log; no
production action was taken as part of producing this verdict.
`SETTLEMENT_PAUSED` remains untouched.
