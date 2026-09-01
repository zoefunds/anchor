import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkInternalSecret } from "@/lib/internal-auth";
import { getAttestorThreshold } from "@/lib/hyperlane";

// GET /api/internal/pending-attestations — lists decisions currently
// blocked on external attestor co-signatures (see
// InsufficientAttestorSignaturesError in lib/hyperlane.ts and
// docs/multisig-attestor-setup.md). An external attestor holder polls
// this (or is told the decisionId/hash out of band) to know what still
// needs their signature, then POSTs it to
// /api/internal/pending-attestations/[decisionId]/sign.
export async function GET(req: NextRequest) {
  const authError = checkInternalSecret(req);
  if (authError) return authError;

  const pending = await prisma.decision.findMany({
    where: { pendingAttestationHash: { not: null }, relayTxHash: null },
    select: {
      id: true,
      caseId: true,
      outcome: true,
      pendingAttestationHash: true,
      pendingAttestationSignatures: true,
      createdAt: true,
      case: { select: { settlementChain: true, settlementContract: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const items = await Promise.all(
    pending.map(async (d) => {
      const threshold = d.case.settlementContract
        ? await getAttestorThreshold(d.case.settlementContract as `0x${string}`).catch(() => null)
        : null;
      return {
        decisionId: d.id,
        caseId: d.caseId,
        outcome: d.outcome,
        attestationHash: d.pendingAttestationHash,
        collectedExternalSignatures: d.pendingAttestationSignatures.length,
        attestorThreshold: threshold,
        createdAt: d.createdAt,
      };
    })
  );

  return NextResponse.json({ pending: items });
}
