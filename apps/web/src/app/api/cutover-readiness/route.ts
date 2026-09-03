import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { runCutoverReadinessCheck } from "@/lib/cutover-readiness";

// Event-log scanning from a fixed historical start block can take a
// while — this project's own deposit volume is tiny today, but give
// this route real headroom rather than the default serverless timeout.
export const maxDuration = 60;

// GET /api/cutover-readiness — Item D UI: the same real checks
// scripts/cutover-readiness-check.sh performs (unsettled V1 deposits,
// Safe threshold, live settlementTarget vs. each integration), surfaced
// to the dashboard instead of CLI+SSH only. Platform-admin-only, NOT
// org-OWNER-only: runCutoverReadinessCheck queries every Sepolia
// SettlementIntegration across every organization (a V1->V2 cutover is
// a platform-wide DecisionRelay concern, not a per-org one) — an
// org's own OWNER is the wrong authority to see other orgs' escrow
// addresses and integration ids. Read-only regardless — makes zero
// writes, on-chain or in the database.
export async function GET() {
  const member = await requirePlatformAdmin();
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
