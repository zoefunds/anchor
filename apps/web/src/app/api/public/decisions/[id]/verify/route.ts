import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeDecisionHash } from "@/lib/adjudication-service";

// GET /api/public/decisions/:id/verify — no auth, deliberately. This is
// a transparency mitigation, not a settlement-security fix: Anchor's
// current trust model is "GenLayer decides -> Anchor's backend chooses
// the relay payload -> a trusted relay settles it" (see
// hyperlane.ts/DecisionRelay.sol) — the destination contract does not
// itself verify a GenLayer proof, so a compromised backend/relay key
// could in principle relay a different outcome than what GenLayer
// actually decided. Full prevention would need a GenLayer consensus
// light-client on the destination chain, which is out of scope here.
//
// What this DOES provide: every field that feeds decisionHash (see
// lib/adjudication-service.ts's computeDecisionHash) published in one
// place, plus that hash recomputed fresh right here from those exact
// fields. A verifier — the other party, an auditor, anyone — doesn't
// have to trust that Anchor's stored decisionHash matches its own
// preimage; they can redo the computation themselves (or with any
// sha256+JSON.stringify tool, the algorithm is fully documented in
// computeDecisionHash's own comment) and compare it against what the
// destination contract's processedDecisions[decisionHash] mapping
// actually recorded as settled (relayTxHash/relayMessageId below point
// at exactly that transaction). A mismatch is detectable after the
// fact — this is detection, not prevention.
//
// Deliberately excludes evidence content, party refs, and org identity
// — only the decision's own metadata, the same fields already implied
// by the public on-chain settlement event this is meant to be checked
// against.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const decision = await prisma.decision.findUnique({
    where: { id: (await params).id },
    include: { case: { select: { id: true, settlementChain: true, settlementContract: true } } },
  });
  if (!decision) {
    return NextResponse.json({ error: "decision not found" }, { status: 404 });
  }

  const preimage = {
    caseId: decision.caseId,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    outcome: decision.outcome,
    claimantShareBps: decision.claimantShareBps,
    respondentShareBps: decision.respondentShareBps,
    reasonCodes: decision.reasonCodes,
    proofHash: decision.proofHash,
    contractCodeHash: decision.contractCodeHash,
  };

  const recomputedDecisionHash =
    decision.contractCodeHash != null
      ? computeDecisionHash({ ...preimage, contractCodeHash: decision.contractCodeHash })
      : null;

  return NextResponse.json({
    decisionId: decision.id,
    preimage,
    storedDecisionHash: decision.decisionHash,
    recomputedDecisionHash,
    // The whole point: if this is false, either Anchor's own storage is
    // internally inconsistent, or these preimage fields were altered
    // after the fact — either way, something a trusting verifier
    // should not accept at face value.
    internallyConsistent: recomputedDecisionHash !== null && recomputedDecisionHash === decision.decisionHash,
    settlement: {
      chain: decision.case.settlementChain,
      contract: decision.case.settlementContract,
      relayTxHash: decision.relayTxHash,
      relayMessageId: decision.relayMessageId,
      relayNotificationTxHash: decision.relayNotificationTxHash,
      note:
        decision.case.settlementChain === "sepolia" && decision.case.settlementContract
          ? `Cross-check storedDecisionHash against ${decision.case.settlementContract}'s processedDecisions(bytes32) mapping on Sepolia — it should be true iff this decision genuinely settled, and the settlement's own on-chain proofHash argument should equal storedDecisionHash.`
          : null,
    },
  });
}
