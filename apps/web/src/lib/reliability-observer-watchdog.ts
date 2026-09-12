import { prisma } from "@/lib/prisma";
import { sendOpsAlert } from "@/lib/alerts";
import { OBSERVATION_INTERVAL_MS } from "@/lib/reliability-window";

// Watches the watcher: the anc-hor-reliability-observer Fly app
// (scripts/reliability-observation-loop.ts) ticks every
// OBSERVATION_INTERVAL_MS (15 min) and writes one
// ReliabilityWindowObservation row per tick. If that process crashes,
// gets OOM-killed, or loses its DATABASE_URL, it stops writing rows
// silently — nobody reading the 30-day window would notice a gap until
// they went looking. This check must run in a DIFFERENT process (the
// main worker, see worker.ts) so a dead observer can't also suppress
// the alert about itself being dead.
//
// STALE_HEARTBEAT_MS = 40 minutes: tolerates exactly one fully-missed
// 15-minute tick (30 min) plus real-world jitter (this watchdog's own
// 10-minute polling interval landing awkwardly relative to the
// observer's tick, plus GC/DB-latency slop) without false-alarming on
// a single delayed write, while still catching a genuine outage inside
// under 3 missed ticks — fast enough to matter, loose enough to be
// quiet in the common case.
export const STALE_HEARTBEAT_MS = 40 * 60 * 1000;

export interface ReliabilityObserverHeartbeatStatus {
  checkedAt: string;
  lastObservationAt: string | null;
  ageMs: number | null;
  stale: boolean;
  error: string | null;
}

/**
 * Reads the most recent ReliabilityWindowObservation.capturedAt and
 * compares it against STALE_HEARTBEAT_MS. Never throws: a DB failure
 * while checking is itself alert-worthy (arguably more urgent than a
 * stale observer), so it is turned into a critical sendOpsAlert with
 * its own distinct message rather than being allowed to propagate and
 * potentially wedge the caller's periodic-job loop.
 */
export async function checkReliabilityObserverHeartbeat(): Promise<ReliabilityObserverHeartbeatStatus> {
  const checkedAt = new Date();

  let latest: { capturedAt: Date } | null;
  try {
    latest = await prisma.reliabilityWindowObservation.findFirst({
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deliverAlert({
      severity: "critical",
      title: "Reliability-observer watchdog could not query the database",
      detail:
        `The watchdog (worker.ts) failed to query ReliabilityWindowObservation while checking whether ` +
        `anc-hor-reliability-observer is still alive: ${message}\n` +
        `This is a DB-availability problem, distinct from (and more urgent than) the observer itself ` +
        `going stale — the reliability window cannot be evaluated at all right now. ` +
        `See docs/runbooks/rpc-outage.md and docs/runbooks/worker-crash.md for DB-connectivity diagnosis steps.`,
    });
    return { checkedAt: checkedAt.toISOString(), lastObservationAt: null, ageMs: null, stale: true, error: message };
  }

  if (!latest) {
    await deliverAlert({
      severity: "critical",
      title: "No ReliabilityWindowObservation rows exist yet",
      detail:
        `The watchdog found zero rows in ReliabilityWindowObservation. Either ` +
        `anc-hor-reliability-observer has never successfully ticked, or the table was cleared. ` +
        `See docs/reliability-observation-window.md and confirm the observer app is actually deployed and running.`,
    });
    return { checkedAt: checkedAt.toISOString(), lastObservationAt: null, ageMs: null, stale: true, error: null };
  }

  const ageMs = checkedAt.getTime() - latest.capturedAt.getTime();
  const stale = ageMs > STALE_HEARTBEAT_MS;

  if (stale) {
    const ageMinutes = Math.round(ageMs / 60_000);
    await deliverAlert({
      severity: "critical",
      title: "anc-hor-reliability-observer heartbeat is stale",
      detail:
        `Last ReliabilityWindowObservation was captured at ${latest.capturedAt.toISOString()}, ` +
        `${ageMinutes} minutes ago — past the ${STALE_HEARTBEAT_MS / 60_000}-minute staleness threshold ` +
        `(the observer ticks every ${OBSERVATION_INTERVAL_MS / 60_000} minutes, so this means at least one, ` +
        `likely more, missed ticks). The reliability window's whole purpose is to catch real problems; a ` +
        `silent gap here means it currently cannot. Check anc-hor-reliability-observer's Fly status/logs ` +
        `(fly status -a anc-hor-reliability-observer, fly logs -a anc-hor-reliability-observer) — see ` +
        `docs/runbooks/worker-crash.md for the general crashed-process diagnosis pattern (same failure modes: ` +
        `StartupCheckError, missing DATABASE_URL/REDIS_URL, OOM).`,
    });
  }

  return {
    checkedAt: checkedAt.toISOString(),
    lastObservationAt: latest.capturedAt.toISOString(),
    ageMs,
    stale,
    error: null,
  };
}

async function deliverAlert(params: { severity: "critical"; title: string; detail: string }): Promise<void> {
  try {
    await sendOpsAlert(params);
  } catch (alertErr) {
    // sendOpsAlert already throws OpsAlertDeliveryError on a real
    // delivery failure (vs. resolving false when simply unconfigured)
    // — that failure must not crash the watchdog's own caller, but it
    // must not vanish either.
    console.error("reliability-observer-watchdog: failed to deliver ops alert", alertErr);
  }
}
