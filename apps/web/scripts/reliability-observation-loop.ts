// TRACK 1, item 1 — the actual long-running scheduler for
// reliability-observation.ts. Fly's native "scheduled machine" feature
// only supports hourly/daily/monthly presets, not a 15-minute cadence
// (see docs/reliability-observation-window.md for why 15 minutes was
// chosen), so this runs as a small persistent process — same pattern
// fly.worker.toml already uses for src/worker.ts — instead of relying
// on Fly's cron-like scheduling.
//
// Run via `npx tsx scripts/reliability-observation-loop.ts`; packaged
// by Dockerfile.reliability-observer and fly.reliability-observer.toml.
// This file only starts running once that image is actually deployed
// (`fly deploy -c fly.reliability-observer.toml`) — a step this sandbox
// cannot perform. See this track's report for the explicit statement
// that the 30-day clock is not yet ticking until that deploy happens.
import { OBSERVATION_INTERVAL_MS } from "@/lib/reliability-window";

async function tick() {
  try {
    // Re-import per tick so a transient module-level failure in one run
    // can't wedge the whole long-running process.
    const { computeObservation, computeObservationHash } = await import("@/lib/reliability-window");
    const { prisma } = await import("@/lib/prisma");
    const capturedAt = new Date();
    const result = await computeObservation();
    const row = { capturedAt, components: result.components as unknown as object, status: result.status, failReasons: result.failReasons, notes: null as string | null, remediation: null as string | null };
    const observationHash = computeObservationHash(row);
    const created = await prisma.reliabilityWindowObservation.create({ data: { ...row, observationHash } });
    console.log(`[reliability-observation-loop] ${created.id}: ${result.status}`);
  } catch (err) {
    console.error("[reliability-observation-loop] tick failed", err);
  }
}

async function main() {
  console.log(`[reliability-observation-loop] starting, interval=${OBSERVATION_INTERVAL_MS}ms`);
  await tick();
  setInterval(tick, OBSERVATION_INTERVAL_MS);
}

main();
