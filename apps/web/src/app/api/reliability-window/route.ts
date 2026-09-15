import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeWindowState } from "@/lib/reliability-window";
import { STALE_HEARTBEAT_MS } from "@/lib/reliability-observer-watchdog";

export const dynamic = "force-dynamic";

// TRACK 1, item 1: PUBLIC, unauthenticated — "an external reviewer can
// ... evaluate known risks without relying on chat history" requires
// this to be reachable with no auth, same reasoning as /api/status.
// Only aggregate day/status/fail-reason data is returned — no
// connection strings, hostnames, or raw check detail (see
// ReliabilityWindowObservation.components for that, which stays
// internal via a platform-admin route if one is added later).
export async function GET() {
  try {
    const rows = await prisma.reliabilityWindowObservation.findMany({
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, status: true, failReasons: true },
    });
    const state = computeWindowState(rows);
    // Read-only view of the watchdog's own verdict rule (worker.ts runs
    // the actual check + alert on its own schedule, see
    // reliability-observer-watchdog.ts) — this route never re-triggers
    // an alert on a page load, it only reports the same staleness
    // math against the observation this route already fetched.
    const lastObservationAt = state.lastObservationAt;
    const heartbeatAgeMs = lastObservationAt ? Date.now() - new Date(lastObservationAt).getTime() : null;
    return NextResponse.json({
      environment: "TESTNET — no real value",
      generatedAt: new Date().toISOString(),
      ...state,
      observerWatchdog: {
        lastObservationAt,
        ageMs: heartbeatAgeMs,
        staleThresholdMs: STALE_HEARTBEAT_MS,
        stale: heartbeatAgeMs === null || heartbeatAgeMs > STALE_HEARTBEAT_MS,
      },
    });
  } catch {
    return NextResponse.json(
      { environment: "TESTNET — no real value", generatedAt: new Date().toISOString(), error: "reliability window temporarily unavailable" },
      { status: 503 }
    );
  }
}
