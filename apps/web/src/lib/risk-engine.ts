import { prisma } from "@/lib/prisma";
import { withDbRetry } from "@/lib/db-retry";
import { parseVelocityLimits } from "@/lib/policy-engine";
import type { RiskAction } from "@prisma/client";

// Phase 4, item 2 — risk and anti-abuse controls.
//
// computeRiskAssessment runs once at case-creation time (fail-closed:
// callers must not create a Case if this throws) and is re-run at
// settlement-dispatch time by recheckRiskAssessment to catch velocity
// that accumulated AFTER the case was created but before it settled —
// the same class of gap checkAutoSignEligibility's amount cap already
// closes for amount, generalized here to dispute frequency/volume.
//
// The action this computes (ALLOW / REQUIRE_KYC / REQUIRE_REVIEW /
// BLOCK) is advisory data on its own — it only actually gates anything
// because case-creation and dispatchSettlementForDecision both check it
// explicitly (see api/cases/route.ts and adjudication-service.ts).

export interface RiskComputationInput {
  organizationId: string;
  claimantRef: string;
  respondentRef: string;
  amountUsd: number;
  velocityLimits: ReturnType<typeof parseVelocityLimits>;
  excludeCaseId?: string;
}

export interface RiskComputationResult {
  action: RiskAction;
  reasons: string[];
  claimantRecentDisputeCount: number;
  respondentRecentDisputeCount: number;
  repeatPairDisputeCount: number;
  orgRollingDisputeCount: number;
  orgRollingVolumeUsd: number;
}

/**
 * Pure computation (no DB writes) over the org's own dispute history —
 * repeat-dispute detection for the (claimant, respondent) pair, rolling
 * per-party/per-org dispute counts, and rolling per-party volume. Never
 * looks outside `organizationId` — cross-tenant risk correlation is
 * explicitly out of scope for this pass (see report).
 */
export async function computeRiskAssessment(input: RiskComputationInput): Promise<RiskComputationResult> {
  const windowStart = new Date(Date.now() - input.velocityLimits.rollingWindowDays * 24 * 60 * 60 * 1000);
  const baseWhere = {
    organizationId: input.organizationId,
    createdAt: { gte: windowStart },
    ...(input.excludeCaseId ? { id: { not: input.excludeCaseId } } : {}),
  };

  const [claimantCases, respondentCases, orgCases] = await Promise.all([
    prisma.case.findMany({ where: { ...baseWhere, claimantRef: input.claimantRef }, select: { amount: true, respondentRef: true } }),
    prisma.case.findMany({ where: { ...baseWhere, respondentRef: input.respondentRef }, select: { amount: true } }),
    prisma.case.findMany({ where: baseWhere, select: { amount: true } }),
  ]);

  const claimantRecentDisputeCount = claimantCases.length;
  const respondentRecentDisputeCount = respondentCases.length;
  const repeatPairDisputeCount = claimantCases.filter((c) => c.respondentRef === input.respondentRef).length;
  const orgRollingDisputeCount = orgCases.length;
  const claimantVolumeUsd = claimantCases.reduce((sum, c) => sum + Number(c.amount), 0) + input.amountUsd;
  const orgRollingVolumeUsd = orgCases.reduce((sum, c) => sum + Number(c.amount), 0) + input.amountUsd;

  const reasons: string[] = [];
  let action: RiskAction = "ALLOW";

  const escalate = (next: RiskAction, reason: string) => {
    const rank: Record<RiskAction, number> = { ALLOW: 0, REQUIRE_KYC: 1, REQUIRE_REVIEW: 2, BLOCK: 3 };
    reasons.push(reason);
    if (rank[next] > rank[action]) action = next;
  };

  if (repeatPairDisputeCount >= 2) {
    escalate("REQUIRE_REVIEW", `same claimant/respondent pair has ${repeatPairDisputeCount} prior dispute(s) in the last ${input.velocityLimits.rollingWindowDays} days — repeat dispute pattern`);
  }
  if (claimantRecentDisputeCount + 1 > input.velocityLimits.maxDisputesPerPartyPerWindow) {
    escalate("REQUIRE_REVIEW", `claimant has filed ${claimantRecentDisputeCount} dispute(s) in the last ${input.velocityLimits.rollingWindowDays} days, exceeding the configured limit of ${input.velocityLimits.maxDisputesPerPartyPerWindow}`);
  }
  if (claimantVolumeUsd > input.velocityLimits.maxVolumeUsdPerPartyPerWindow) {
    escalate("REQUIRE_KYC", `claimant's rolling dispute volume ($${claimantVolumeUsd.toFixed(2)}) exceeds the configured limit ($${input.velocityLimits.maxVolumeUsdPerPartyPerWindow})`);
  }
  if (orgRollingDisputeCount + 1 > input.velocityLimits.maxDisputesPerOrgPerWindow) {
    escalate("BLOCK", `organization has exceeded its configured rolling dispute-volume limit (${input.velocityLimits.maxDisputesPerOrgPerWindow} per ${input.velocityLimits.rollingWindowDays} days)`);
  }
  if (reasons.length === 0) {
    reasons.push("no risk signals detected");
  }

  return {
    action,
    reasons,
    claimantRecentDisputeCount,
    respondentRecentDisputeCount,
    repeatPairDisputeCount,
    orgRollingDisputeCount,
    orgRollingVolumeUsd,
  };
}

/** Persists a fresh RiskAssessment for a just-created case. Call inside the same transaction as Case creation so a case never exists without one. */
export async function createRiskAssessment(caseId: string, result: RiskComputationResult) {
  return withDbRetry(() =>
    prisma.riskAssessment.create({
      data: {
        caseId,
        action: result.action,
        reasons: result.reasons,
        claimantRecentDisputeCount: result.claimantRecentDisputeCount,
        respondentRecentDisputeCount: result.respondentRecentDisputeCount,
        repeatPairDisputeCount: result.repeatPairDisputeCount,
        orgRollingDisputeCount: result.orgRollingDisputeCount,
        orgRollingVolumeUsd: result.orgRollingVolumeUsd,
      },
    })
  );
}

export class RiskGateBlockedError extends Error {
  constructor(public readonly action: RiskAction, public readonly reasons: string[]) {
    super(`settlement blocked by risk gate (${action}): ${reasons.join("; ")}`);
  }
}

/**
 * Re-checked at settlement-dispatch time (see
 * dispatchSettlementForDecision's Phase 4 gate) — recomputes risk using
 * the CURRENT dispute history (which may have grown since case
 * creation) and durably records the recheck outcome on the same
 * RiskAssessment row. Throws RiskGateBlockedError for BLOCK or
 * REQUIRE_REVIEW (an unresolved review must not let funds move); does
 * NOT throw for REQUIRE_KYC, since KYC is enforced separately by
 * lib/settlement-kyc.ts's assertKycRequirementMet — recorded here only
 * as an updated action/reasons pair for visibility.
 */
export async function recheckRiskAssessmentForSettlement(caseId: string, velocityLimits: ReturnType<typeof parseVelocityLimits>): Promise<void> {
  // No-ops for a case with no RiskAssessment row at all — every case
  // created through POST /api/cases (the only real creation path) gets
  // one at creation time, so this only fires for cases created directly
  // (test fixtures, cases predating this migration), matching this
  // codebase's existing "additive, no behavior change for what came
  // before" convention (see assertKycRequirementMet's own no-op case).
  const existing = await prisma.riskAssessment.findUnique({ where: { caseId } });
  if (!existing) return;

  const kase = await prisma.case.findUnique({ where: { id: caseId }, select: { organizationId: true, claimantRef: true, respondentRef: true, amount: true } });
  if (!kase) throw new Error(`recheckRiskAssessmentForSettlement: case ${caseId} not found`);

  const result = await computeRiskAssessment({
    organizationId: kase.organizationId,
    claimantRef: kase.claimantRef,
    respondentRef: kase.respondentRef,
    amountUsd: Number(kase.amount),
    velocityLimits,
    excludeCaseId: caseId,
  });

  await withDbRetry(() =>
    prisma.riskAssessment.update({
      where: { caseId },
      data: { recheckedAt: new Date(), recheckAction: result.action, recheckReasons: result.reasons },
    })
  );

  if (result.action === "BLOCK") {
    throw new RiskGateBlockedError(result.action, result.reasons);
  }

  // Real bug found live: REQUIRE_REVIEW used to throw unconditionally
  // here on every dispatch attempt, including retries after a human
  // reviewer had already approved the case's CaseReview (created for
  // this exact REQUIRE_REVIEW signal by maybeEscalateCase - see
  // ReviewTrigger.FRAUD_RISK's doc comment in schema.prisma). This
  // recomputes from the same historical dispute-count facts every
  // time, which never change retroactively, so an approved review could
  // never actually unblock dispatch - assertNoPendingReviewBlocksSettlement
  // (escalation.ts), the function that DOES check CaseReview.status, was
  // never even reached because this throw happens first. Checking for an
  // approved review here closes that gap; BLOCK above is unaffected and
  // always throws fail-closed, since nothing in escalation.ts resolves a
  // BLOCK-level review.
  if (result.action === "REQUIRE_REVIEW") {
    const review = await prisma.caseReview.findUnique({ where: { caseId } });
    if (review?.status !== "APPROVED") {
      throw new RiskGateBlockedError(result.action, result.reasons);
    }
  }
}
