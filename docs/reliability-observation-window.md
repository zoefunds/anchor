# 30-day reliability observation window — pass/fail rule

This document is written and committed BEFORE the observation window
begins, per TRACK 1's requirement. `apps/web/scripts/reliability-observation.ts`
and `apps/web/src/lib/reliability-window.ts` implement exactly this rule —
if they ever diverge from this doc, this doc wins and the code is wrong.

Testnet only. Nothing in this document, or in any report generated from
it, is a claim about mainnet or real-money readiness.

## Cadence: every 15 minutes, not daily

TRACK 1's brief says "daily/15-minute." This implementation picks
**15 minutes**. Reasoning: the fail conditions below include signer-quorum
loss and unacknowledged critical findings, both of which can develop and
resolve inside a single day. A daily cadence would average those away —
a quorum outage from 2am-6am would simply not appear if the one daily
observation lands at noon. 15-minute sampling is what actually produces
"a missed canary, failed settlement, signer-quorum loss, ... must be
visible in the report," per the acceptance criteria; a coarser cadence
cannot make that promise.

## One observation tick

Each tick captures, independently:

1. **Database** — `system-health.ts`'s `checkDb()`.
2. **Redis** — `system-health.ts`'s `checkRedis()`.
3. **EVM RPC (Sepolia)** — `system-health.ts`'s `checkSepoliaRpc()`.
4. **Solana RPC** — `system-health.ts`'s `checkSolanaRpc()`.
5. **GenLayer** — reachability of the configured GenLayer Studio RPC
   endpoint (`GENLAYER_RPC_URL`), if configured; `unknown` if not
   configured for this environment (never scored as a silent pass).
6. **Signer quorum** — the most recent `SignerLifecycleEvent` per chain.
   A chain is in quorum loss if the newest event for it is `FAILED` or
   `ESCALATED`, or if it has been sitting in `SIGNING` (started but never
   reached `QUORUM_REACHED`) for longer than the stale-signature
   threshold `STALE_SIGNING_MINUTES` (default 30) already used elsewhere
   in this codebase for `STALE_PENDING_SIGNATURE` findings.
7. **Relayer / worker** — freshness of the latest `CanaryRun` row (same
   staleness window the public status route already uses, 2 hours):
   if the most recent canary run is older than that, the relayer/worker
   process is presumed not to be running.
8. **Settlement canary** — the outcome of the most recent `CanaryRun`
   (`settled` / `sla_breach` / `error`).
9. **Reconciliation** — any `ReconciliationFinding` rows that are open
   (`resolvedAt` null).

All of this is real, existing signal (`system-health.ts`, `CanaryRun`,
`SignerLifecycleEvent`, `ReconciliationFinding`) — this document defines
how it is scored, not new probes.

## Per-component PASS/FAIL

A component is `PASS` for a tick if its check reports healthy per the
existing checks above. A component is `FAIL` if:

- the check itself failed/errored (DB, Redis, EVM RPC, Solana RPC), or
- the signer-quorum check found a chain in quorum loss (see #6 above), or
- the relayer/worker canary is stale (see #7 above) — "no signal" is
  treated as failure, not as an absence of evidence, or
- the settlement canary's latest outcome is `sla_breach` or `error`, or
- there is at least one open `ReconciliationFinding` older than a
  **4-hour grace period** from `openedAt` (an OPEN-but-fresh finding is
  not itself a tick failure — the sweep that raised it may still resolve
  it — but one that has sat open past the grace period is), or
- there is at least one `ReconciliationFinding` that is unacknowledged
  (`acknowledgedAt` null) more than **1 hour** after being alerted
  (`alertedAt` set) — this mirrors the existing auto-escalation cadence
  already built for critical findings, scored here as a hard tick
  failure rather than only an ops-console badge.

GenLayer is scored `PASS`/`FAIL` the same way when configured, and does
not affect overall status when unconfigured for the current environment
(recorded as `unknown` in `components`, visible in every row, never
silently dropped).

## Overall tick verdict

The tick is `FAIL` if any component above is `FAIL`, or if the
observation itself could not run at all (crashed, or was never invoked —
see "missed observation" below). Otherwise `PASS`.

## Missed observations count as FAIL

The window is scored from the sequence of ticks that exist in
`ReliabilityWindowObservation`. If the scheduled job does not run (worker
down, deploy not yet done, crash before a row is written), there is a
gap in `capturedAt` timestamps longer than **20 minutes** (15-minute
cadence + a small margin). The query logic in `reliability-window.ts`
treats every such gap as one or more synthetic FAIL ticks — a missed
observation is not silently excluded from the window; it counts against
it exactly as harshly as an observed failure would. This is what "do not
rewrite history or exclude incidents" means concretely for a job that,
by construction, cannot self-report while it isn't running.

## Window extension vs. reset

The window is 30 consecutive calendar days of ticks with no un-extended
FAIL. The exact rule:

- **A single FAIL tick, of any kind other than signer-quorum loss,
  extends the window by 1 day, counted from the day that FAIL tick
  occurred** — it does not reset the window to zero. Rationale: a
  transient RPC blip, a stale canary during a redeploy, or an
  unacknowledged finding are recoverable operational events, not
  evidence the underlying system is untrustworthy from day zero. Losing
  a day of credit for the specific day something went wrong, without
  discarding everything already observed, is proportionate.
- **A signer-quorum-loss FAIL, or any tick where the underlying
  observation data is itself lost or corrupted (a written row that
  cannot be parsed back into `ReliabilityWindowObservation`'s schema),
  resets the window to zero, starting the next day.** Rationale: signer
  quorum is the one component this whole system's settlement safety
  actually depends on — a quorum loss is not "the reliability evidence
  has a gap," it's "the thing the evidence exists to demonstrate did not
  hold," so no amount of the window built up before it is admissible
  evidence that quorum failures don't happen. Lost/corrupted decision
  data gets the same treatment because a broken observation record is
  indistinguishable, from an external reviewer's standpoint, from a
  cover-up of a real failure — the honest response is to say so and
  start over, not to quietly patch the gap and keep the streak.
- A missed-observation FAIL (see above) is treated as a non-quorum FAIL
  (extends by 1 day) unless the gap is long enough that a quorum loss
  could plausibly have occurred and gone unrecorded — specifically, any
  gap longer than 4 hours is treated as a reset, on the same reasoning
  as a quorum-loss reset: an unmonitored gap that long cannot honestly
  be certified as "no quorum loss occurred."

Every FAIL tick, its reason, and whether it extended or reset the
window is retained forever in `ReliabilityWindowObservation` — the
window's current day/status is a computed view over that history, never
a mutation of it. "Restarting the window" means "day 1 of a new 30-day
count as computed from the reset point forward," not deleting or
editing any row.

## Querying the window

`GET /api/reliability-window` (see `apps/web/src/app/api/reliability-window/route.ts`)
returns the current day-of-30, PASS/FAIL/EXTENDED status, and the list of
FAIL ticks with reasons — this is what makes the clock "genuinely
queryable" rather than only inferable from raw rows.
