import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { runCutoverReadinessCheck } from "@/lib/cutover-readiness";

// Event-log scanning from a fixed historical start block can take a
// while — this project's own deposit volume is tiny today, but give
// this route real headroom rather than the default serverless timeout.
export const maxDuration = 60;

// GET /api/cutover-readiness — Item D UI: the same real checks
// scripts/cutover-readiness-check.sh performs (unsettled V1 deposits,
// Safe threshold, live settlementTarget vs. each integration), surfaced
// to the dashboard instead of CLI+SSH only. OWNER-only and read-only —
// makes zero writes, on-chain or in the database. Can be slow (scans
// real event logs from a fixed start block), so this is an on-demand
// check, not something polled automatically.
export async function GET() {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  try {
    const report = await runCutoverReadinessCheck();
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json({ error: `cutover readiness check failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 502 });
  }
}
