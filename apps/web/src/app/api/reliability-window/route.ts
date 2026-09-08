import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeWindowState } from "@/lib/reliability-window";

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
    return NextResponse.json({
      environment: "TESTNET — no real value",
      generatedAt: new Date().toISOString(),
      ...state,
    });
  } catch {
    return NextResponse.json(
      { environment: "TESTNET — no real value", generatedAt: new Date().toISOString(), error: "reliability window temporarily unavailable" },
      { status: 503 }
    );
  }
}
