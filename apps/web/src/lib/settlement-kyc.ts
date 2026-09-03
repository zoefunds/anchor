import { prisma } from "@/lib/prisma";

// Real gate wired here (per an explicit operator decision this
// session): a case's settlement dispatch is blocked unless BOTH
// parties have an APPROVED PartyVerification, but only when the
// case's SettlementIntegration opts into it via requireKycApproval —
// see prisma/schema.prisma's own comment on that field for why this
// is a per-integration policy choice, not a global rule. A case with
// no CaseSettlement row at all (the common case today, since
// CaseSettlement isn't yet populated by any real flow) or an
// integration with requireKycApproval=false is never blocked by this
// check — this is additive, not a new universal requirement.

export class KycRequirementNotMetError extends Error {
  constructor(public readonly missingRoles: ("claimant" | "respondent")[]) {
    super(`settlement requires KYC approval, but not yet approved for: ${missingRoles.join(", ")}`);
  }
}

/**
 * Throws KycRequirementNotMetError if `caseId`'s settlement integration
 * requires KYC and either party isn't APPROVED. No-ops (returns
 * normally) if there's no CaseSettlement for this case, or its
 * integration doesn't require KYC — call this unconditionally from
 * dispatchDecisionForCase; it's a no-op until an operator actually
 * opts an integration into requireKycApproval.
 */
export async function assertKycRequirementMet(caseId: string): Promise<void> {
  const settlement = await prisma.caseSettlement.findUnique({
    where: { caseId },
    include: { integration: true },
  });
  if (!settlement || !settlement.integration.requireKycApproval) return;

  const verifications = await prisma.partyVerification.findMany({
    where: { caseId, role: { in: ["claimant", "respondent"] } },
  });
  const approvedRoles = new Set(verifications.filter((v) => v.status === "APPROVED").map((v) => v.role));

  const missingRoles = (["claimant", "respondent"] as const).filter((role) => !approvedRoles.has(role));
  if (missingRoles.length > 0) {
    throw new KycRequirementNotMetError(missingRoles);
  }
}
