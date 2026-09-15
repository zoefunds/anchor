import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkDb, checkRedis, checkSepoliaRpc, checkSolanaRpc } from "@/lib/system-health";
import { computeWindowState } from "@/lib/reliability-window";

// Phase 5, last item: a PUBLIC, unauthenticated status page/route. No
// auth gate at all — unlike ops-console (platform-admin-only), this is
// meant to be linked from marketing/docs. That means the response
// shape below is deliberately much smaller than ops-console's: no
// connection strings, no hostnames, no case/decision ids, no signer
// addresses, no tx hashes, no stack traces. Every field is either a
// boolean/enum or a value already safe to publish (a title, a
// timestamp, a canary outcome string). Build the payload defensively —
// each section computed from `ok`/`status`/small enum fields, never by
// spreading a raw health-check or Prisma row into the response.

// Without this, Next.js treats a route with no request-dependent input
// as static and caches the response indefinitely at build time — this
// route reads live DB state (canary runs, incidents, RPC health) on
// every request, so it must never be statically cached.
export const dynamic = "force-dynamic";

type ComponentStatus = "up" | "degraded" | "down";

function componentStatus(ok: boolean): ComponentStatus {
  return ok ? "up" : "down";
}

export async function GET() {
  try {
    const [db, redis, sepoliaRpc, solanaRpc] = await Promise.all([
      checkDb(),
      checkRedis(),
      checkSepoliaRpc(),
      checkSolanaRpc(),
    ]);

    // "worker/relayer" has no independent health probe of its own (see
    // ops-console's own note: this process can't attest to the
    // standalone worker being alive) — its public status is derived
    // from whether canary runs are still landing, which is exactly what
    // a canary is for.
    const latestCanary = await prisma.canaryRun.findFirst({
      orderBy: { createdAt: "desc" },
      select: { outcome: true, createdAt: true },
    });
    const CANARY_STALE_MS = 2 * 60 * 60 * 1000;
    const canaryFresh = !!latestCanary && Date.now() - latestCanary.createdAt.getTime() < CANARY_STALE_MS;
    const canaryConfigured = Boolean(process.env.CANARY_ORGANIZATION_ID);
    const workerRelayerStatus: ComponentStatus = !latestCanary
      ? "degraded"
      : canaryFresh && latestCanary.outcome === "settled"
        ? "up"
        : canaryFresh || !canaryConfigured
          ? "degraded"
          : "down";

    const incidentRows = await prisma.incident.findMany({
      where: {
        organizationId: null,
        OR: [{ status: { not: "RESOLVED" } }, { resolvedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }],
      },
      orderBy: { startedAt: "desc" },
      take: 50,
      select: { title: true, description: true, status: true, startedAt: true, resolvedAt: true },
    });

    const incidents = incidentRows.map((i) => ({
      title: i.title,
      description: i.description,
      status: i.status,
      startedAt: i.startedAt.toISOString(),
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
    }));

    // TRACK 1, item 3: reliability-window summary for the public trust
    // page. Aggregate-only (day/status/fail count) — the same reasoning
    // as the rest of this route's payload: no raw check detail here,
    // see GET /api/reliability-window for that.
    const windowRows = await prisma.reliabilityWindowObservation.findMany({
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true, status: true, failReasons: true },
    });
    const windowState = computeWindowState(windowRows);

    return NextResponse.json({
      environment: "TESTNET — no real value",
      generatedAt: new Date().toISOString(),
      components: {
        database: componentStatus(db.ok),
        redis: componentStatus(redis.ok),
        evmRpc: componentStatus(sepoliaRpc.ok),
        solanaRpc: componentStatus(solanaRpc.ok),
        workerRelayer: workerRelayerStatus,
      },
      canary: latestCanary
        ? { configured: canaryConfigured, lastRunAt: latestCanary.createdAt.toISOString(), outcome: latestCanary.outcome }
        : null,
      incidents,
      reliabilityWindow: {
        status: windowState.status,
        dayOfWindow: windowState.dayOfWindow,
        targetDays: windowState.targetDays,
        totalObservations: windowState.totalObservations,
        lastObservationAt: windowState.lastObservationAt,
        failTickCount: windowState.failTicks.length,
      },
      auditPackageUrl: "/docs/audit-package/README.md",
      knownLimitations: [
        "Testnet only — no real funds are ever custodied or moved by this system.",
        "Attestor signer independence is partial: see docs/multisig-attestor-setup.md and docs/mainnet-custody-design.md for exactly which signer roles are and are not run by fully independent operators today.",
        "RPC providers used for Sepolia/Hyperlane reads are currently free public endpoints with no SLA — see reliability-monitor.ts's rpc-provider-risk check.",
        "The 30-day reliability window reported above only reflects ticks that a deployed, scheduled observation job has actually recorded — see the audit package for whether that job is currently running.",
      ],
    });
  } catch {
    // Deliberately no error detail in the body — an unhandled exception
    // here (DB down mid-query, etc.) must not leak a stack trace or
    // connection error string to an unauthenticated caller. Any real
    // outage is already visible via the down/degraded component
    // statuses in the success path; this branch only guards against
    // something unexpected blowing up before that payload is built.
    return NextResponse.json(
      { environment: "TESTNET — no real value", generatedAt: new Date().toISOString(), error: "status temporarily unavailable" },
      { status: 503 }
    );
  }
}
