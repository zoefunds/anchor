// TRACK 1, item 1 — runs one 15-minute reliability observation tick and
// writes a ReliabilityWindowObservation row. See
// docs/reliability-observation-window.md for the pass/fail rule and
// apps/web/src/lib/reliability-window.ts for the implementation.
//
// NOT scheduled by this script itself — see
// apps/web/scripts/reliability-observation-loop.ts for the long-running
// process meant to invoke this on a fixed interval, and
// fly.reliability-observer.toml for the Fly app config that runs that
// loop. Deploying that app is a manual `fly deploy` step the operator
// still needs to perform; see this track's report for the explicit,
// honest statement on what is and isn't running right now.
import { prisma } from "@/lib/prisma";
import { computeObservation, computeObservationHash } from "@/lib/reliability-window";

async function main() {
  const startedAt = new Date();
  let result;
  try {
    result = await computeObservation();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const row = { capturedAt: startedAt, components: { crashed: true }, status: "FAIL", failReasons: ["observation_crashed"], notes: detail, remediation: null };
    const observationHash = computeObservationHash(row);
    await prisma.reliabilityWindowObservation.create({ data: { ...row, observationHash } });
    console.error(`[reliability-observation] crashed: ${detail}`);
    process.exitCode = 1;
    return;
  }

  const row = {
    capturedAt: startedAt,
    components: result.components as unknown as object,
    status: result.status,
    failReasons: result.failReasons,
    notes: null as string | null,
    remediation: null as string | null,
  };
  const observationHash = computeObservationHash(row);
  const created = await prisma.reliabilityWindowObservation.create({ data: { ...row, observationHash } });

  console.log(`[reliability-observation] ${created.id}: ${result.status}${result.failReasons.length ? ` (${result.failReasons.join(", ")})` : ""} — hash ${observationHash}`);
}

main()
  .catch((err) => {
    console.error("[reliability-observation] fatal error outside computeObservation", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
