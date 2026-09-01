import { NextRequest, NextResponse } from "next/server";
import type { Hex } from "viem";
import { prisma } from "@/lib/prisma";
import { checkInternalSecret } from "@/lib/internal-auth";
import { getAttestorThreshold, countValidDistinctSigners } from "@/lib/hyperlane";

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
      const relayAddress = d.case.settlementContract as `0x${string}` | undefined;
      const threshold = relayAddress ? await getAttestorThreshold(relayAddress).catch(() => null) : null;
      // Distinct VALID registered signers among the externally-collected
      // signatures, revalidated against the live isAttestor mapping —
      // never raw array length, which a re-audit correctly flagged as
      // countable-but-wrong (duplicate/re-encoded signatures from one
      // signer, or a stale signature from a since-removed attestor).
      const collectedExternalSignatures =
        relayAddress && d.pendingAttestationHash
          ? (await countValidDistinctSigners(relayAddress, d.pendingAttestationHash as Hex, d.pendingAttestationSignatures as Hex[]).catch(() => null))
              ?.validCount ?? d.pendingAttestationSignatures.length
          : d.pendingAttestationSignatures.length;
      return {
        decisionId: d.id,
        caseId: d.caseId,
        outcome: d.outcome,
        attestationHash: d.pendingAttestationHash,
        collectedExternalSignatures,
        attestorThreshold: threshold,
        createdAt: d.createdAt,
      };
    })
  );

  return NextResponse.json({ pending: items });
}
