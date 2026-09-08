import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/audit";
import type { PartyRole } from "@/lib/party-auth";
import type { PartyVerificationStatus } from "@prisma/client";

// Track 3's real enforcement of PolicyVersion.kycRequired — the flag
// existed (see prisma/schema.prisma) and was surfaced read-only in
// receipts.ts, but nothing before this checked it before letting a case
// settle. This is a SEPARATE, additive gate from lib/settlement-kyc.ts's
// assertKycRequirementMet, which enforces a DIFFERENT, older opt-in
// (SettlementIntegration.requireKycApproval, chosen per settlement
// integration). Both gates run in dispatchDecisionForCase — see
// lib/hyperlane.ts — because they answer different questions ("did this
// specific integration opt into requiring KYC" vs "does the case's own
// bound policy require it") and either one blocking is enough to stop
// settlement.

export class KycPolicyRequirementNotMetError extends Error {
  constructor(public readonly missingRoles: PartyRole[]) {
    super(`case's policy requires KYC approval, but not yet approved for: ${missingRoles.join(", ")}`);
  }
}

/**
 * Throws KycPolicyRequirementNotMetError if the case's bound
 * PolicyVersion has kycRequired=true and either party lacks an
 * APPROVED, unexpired PartyVerification bound to that SAME
 * PolicyVersion. No-ops for a case with no bound PolicyVersion at all,
 * or one with kycRequired=false — call this unconditionally from
 * dispatchDecisionForCase; it is inert until an operator publishes a
 * policy version with kycRequired=true.
 */
export async function assertKycPolicyRequirementMet(caseId: string): Promise<void> {
  const kase = await prisma.case.findUnique({
    where: { id: caseId },
    select: { policyVersionRecordId: true, policyVersionRecord: { select: { id: true, kycRequired: true } } },
  });
  if (!kase?.policyVersionRecord?.kycRequired) return;

  const policyVersionId = kase.policyVersionRecord.id;
  const now = new Date();
  const verifications = await prisma.partyVerification.findMany({
    where: { caseId, role: { in: ["claimant", "respondent"] }, policyVersionId },
  });
  const approvedRoles = new Set(
    verifications
      .filter((v) => v.status === "APPROVED" && (!v.expiresAt || v.expiresAt > now))
      .map((v) => v.role as PartyRole)
  );

  const missingRoles = (["claimant", "respondent"] as const).filter((role) => !approvedRoles.has(role));
  if (missingRoles.length > 0) {
    throw new KycPolicyRequirementNotMetError(missingRoles);
  }
}

const OVERRIDE_REASONS = [
  "PROVIDER_OUTAGE",
  "PROVIDER_DATA_ERROR",
  "DOCUMENTED_EXCEPTION_APPROVED_BY_COMPLIANCE",
] as const;
export type ManualOverrideReason = (typeof OVERRIDE_REASONS)[number];
export function isManualOverrideReason(value: string): value is ManualOverrideReason {
  return (OVERRIDE_REASONS as readonly string[]).includes(value);
}

/**
 * Operator override for settings/kyc/page.tsx — the only writer of a
 * "manual_override" PartyVerificationEvent, and the only way a
 * PartyVerification can reach APPROVED without a real provider webhook.
 * Requires a reason FROM THE FIXED VOCABULARY above (not free text
 * alone — a dropdown, enforced here too since a UI check alone is not a
 * real boundary) plus a required note, and always writes both a
 * PartyVerificationEvent and an AuditLog row (reusing lib/audit.ts's
 * hash-chained log, not a parallel audit mechanism).
 */
export async function recordManualOverride(params: {
  partyVerificationId: string;
  organizationId: string;
  actingMemberId: string;
  reason: ManualOverrideReason;
  note: string;
  toStatus: Extract<PartyVerificationStatus, "APPROVED" | "DECLINED">;
}): Promise<void> {
  if (!params.note.trim()) {
    throw new Error("a manual override requires a non-empty note in addition to its reason code");
  }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.partyVerification.findUniqueOrThrow({ where: { id: params.partyVerificationId } });

    await tx.partyVerification.update({
      where: { id: params.partyVerificationId },
      data: { status: params.toStatus },
    });

    await tx.partyVerificationEvent.create({
      data: {
        partyVerificationId: params.partyVerificationId,
        fromStatus: existing.status,
        toStatus: params.toStatus,
        source: "manual_override",
        reason: `${params.reason}: ${params.note}`,
        actingMemberId: params.actingMemberId,
      },
    });

    await logAction(
      {
        organizationId: params.organizationId,
        memberId: params.actingMemberId,
        action: "party_verification.manual_override",
        targetType: "partyVerification",
        targetId: params.partyVerificationId,
        metadata: { fromStatus: existing.status, toStatus: params.toStatus, reason: params.reason, note: params.note },
      },
      tx
    );
  });
}
