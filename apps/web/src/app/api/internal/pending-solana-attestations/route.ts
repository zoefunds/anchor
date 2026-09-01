import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkInternalSecret } from "@/lib/internal-auth";
import { getSolanaAttestorThreshold, type SolanaAttestationRecord } from "@/lib/solana-settle";

// GET /api/internal/pending-solana-attestations — the Solana equivalent
// of GET /api/internal/pending-attestations (EVM). Lists decisions
// currently blocked on an external Solana attestor co-signature — see
// InsufficientSolanaAttestationsError in lib/solana-settle.ts and
// docs/multisig-attestor-setup.md's Solana section. An external
// attestor holder polls this (or is told the decisionId/message out of
// band) to know what still needs their signature, then POSTs it to
// /api/internal/pending-solana-attestations/[decisionId]/sign.
export async function GET(req: NextRequest) {
  const authError = checkInternalSecret(req);
  if (authError) return authError;

  const pending = await prisma.decision.findMany({
    where: { pendingSolanaAttestationMessage: { not: null }, relayTxHash: null },
    select: {
      id: true,
      caseId: true,
      outcome: true,
      pendingSolanaAttestationMessage: true,
      pendingSolanaAttestations: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const threshold = getSolanaAttestorThreshold();
  const items = pending.map((d) => ({
    decisionId: d.id,
    caseId: d.caseId,
    outcome: d.outcome,
    messageHex: d.pendingSolanaAttestationMessage,
    collectedExternalSignatures: ((d.pendingSolanaAttestations as SolanaAttestationRecord[] | null) ?? []).length,
    attestorThreshold: threshold,
    createdAt: d.createdAt,
  }));

  return NextResponse.json({ pending: items });
}
