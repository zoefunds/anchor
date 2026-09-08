import { prisma } from "@/lib/prisma";
import { withDbRetry } from "@/lib/db-retry";
import type { ReviewTrigger, RiskAction } from "@prisma/client";
import type { HumanReviewTriggers } from "@/lib/policy-engine";

// Phase 4, item 3 — human escalation.
//
// Real constraint that shaped this file (see report): GenLayer's
// adjudicator.py never populates Decision.confidence — grep across this
// entire repo turns up zero writers of that column, only the schema
// field and its doc comment. There is therefore no real ambiguity/
// low-confidence signal to route on today. Rather than inventing one
// (e.g. treating a missing value as "always low confidence", or reusing
// `consensus` as a confidence proxy it was never designed to represent),
// this implements only the two routes that DO have a real input:
//   - HIGH_VALUE: case amount vs. the bound policy version's
//     humanReviewTriggers.highValueUsdThreshold
//     (also folded into maybeEscalateCase for FRAUD_RISK, decided by the
//     already-real RiskAssessment.action)
// The low-confidence/ambiguous route is explicitly out of scope for
// this pass — see maybeEscalateCase's early-return comment — pending a
// GenLayer contract change to actually emit a confidence score.

export class EscalationError extends Error {}

export interface EscalationCheckInput {
  caseId: string;
  amountUsd: number;
  riskAction: RiskAction;
  humanReviewTriggers: HumanReviewTriggers;
}

/**
 * Creates a CaseReview if this case's amount or risk assessment trips a
 * real trigger from its bound policy version. No-ops (returns null) if
 * neither trigger fires. Idempotent per case: CaseReview.caseId is
 * unique, so calling this twice for the same case is safe (the second
 * call sees the existing row via the unique constraint and this
 * function's own pre-check).
 *
 * NOTE on low confidence: not implemented here — see this file's header
 * comment. GenLayer emits no confidence/ambiguity score today, so there
 * is no real signal to gate on without fabricating one.
 */
export async function maybeEscalateCase(input: EscalationCheckInput) {
  const existing = await prisma.caseReview.findUnique({ where: { caseId: input.caseId } });
  if (existing) return existing;

  let trigger: ReviewTrigger | null = null;
  if (input.riskAction === "REQUIRE_REVIEW") {
    trigger = "FRAUD_RISK";
  } else if (input.amountUsd >= input.humanReviewTriggers.highValueUsdThreshold) {
    trigger = "HIGH_VALUE";
  }
  if (!trigger) return null;

  const requiresDualApproval = input.amountUsd >= input.humanReviewTriggers.dualApprovalUsdThreshold;

  return withDbRetry(() =>
    prisma.caseReview.create({
      data: { caseId: input.caseId, trigger, requiresDualApproval },
    })
  );
}

/** Manually opens a review outside any automatic trigger (dashboard-initiated). */
export async function openManualReview(caseId: string, requiresDualApproval: boolean) {
  const existing = await prisma.caseReview.findUnique({ where: { caseId } });
  if (existing) throw new EscalationError(`case ${caseId} already has a review (status ${existing.status})`);
  return withDbRetry(() => prisma.caseReview.create({ data: { caseId, trigger: "MANUAL", requiresDualApproval } }));
}

/**
 * Records one reviewer's approve/reject vote and, once enough distinct
 * reviewers have approved (2 if requiresDualApproval, else 1), marks the
 * review APPROVED. A single REJECT immediately marks it REJECTED —
 * dual approval means two independent yeses are required to move
 * forward, not that two independent noes are required to stop it.
 */
export async function castReviewApproval(reviewId: string, memberId: string, decision: "APPROVE" | "REJECT", reason?: string) {
  return withDbRetry(() =>
    prisma.$transaction(async (tx) => {
      const review = await tx.caseReview.findUniqueOrThrow({ where: { id: reviewId } });
      if (review.status !== "PENDING") {
        throw new EscalationError(`review ${reviewId} is already ${review.status}, cannot record another vote`);
      }

      await tx.caseReviewApproval.upsert({
        where: { reviewId_memberId: { reviewId, memberId } },
        update: { decision, reason },
        create: { reviewId, memberId, decision, reason },
      });

      if (decision === "REJECT") {
        return tx.caseReview.update({ where: { id: reviewId }, data: { status: "REJECTED", resolvedAt: new Date() } });
      }

      const approvals = await tx.caseReviewApproval.count({ where: { reviewId, decision: "APPROVE" } });
      const required = review.requiresDualApproval ? 2 : 1;
      if (approvals >= required) {
        return tx.caseReview.update({ where: { id: reviewId }, data: { status: "APPROVED", resolvedAt: new Date() } });
      }
      return review;
    })
  );
}

/** Append-only — there is no updateReviewNote/deleteReviewNote anywhere in this codebase, by design. */
export async function addReviewNote(reviewId: string, memberId: string, note: string) {
  return withDbRetry(() => prisma.caseReviewNote.create({ data: { reviewId, memberId, note } }));
}

/** Party-visible status projection — safe to expose on the public case-status endpoint (no internal reviewer identities or notes). */
export function toPartyVisibleReviewStatus(review: { trigger: ReviewTrigger; status: string; createdAt: Date; resolvedAt: Date | null } | null) {
  if (!review) return null;
  return {
    underReview: review.status === "PENDING",
    status: review.status,
    reason: review.trigger === "HIGH_VALUE" ? "high_value_review" : review.trigger === "FRAUD_RISK" ? "risk_review" : "manual_review",
    openedAt: review.createdAt,
    resolvedAt: review.resolvedAt,
  };
}

/** Blocks settlement dispatch fail-closed while a review is open — mirrors checkAutoSignEligibility's fail-closed style. */
export async function assertNoPendingReviewBlocksSettlement(caseId: string): Promise<void> {
  const review = await prisma.caseReview.findUnique({ where: { caseId } });
  if (!review) return;
  if (review.status !== "APPROVED") {
    throw new EscalationError(`case ${caseId} has an unresolved human review (status ${review.status}) — settlement blocked until approved`);
  }
}
