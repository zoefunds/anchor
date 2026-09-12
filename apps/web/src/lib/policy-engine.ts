import { prisma } from "@/lib/prisma";
import { withDbRetry } from "@/lib/db-retry";
import type { Prisma, RiskAction } from "@prisma/client";

// Phase 4, item 1 — configurable, versioned policy engine.
//
// A Policy is an organization-scoped named slot; PolicyVersion is the
// actual immutable, published configuration. "Editing a policy" always
// means publishing a NEW PolicyVersion row — publishPolicyVersion never
// mutates an existing version's own fields, it only ever flips `active`
// on the prior version to false and inserts a new row with version+1.
// A Case binds to one PolicyVersion's id at creation time
// (Case.policyVersionRecordId) and that binding is never re-resolved —
// see resolveActivePolicyVersion (used ONLY at case-creation time) vs.
// every other read path in this codebase, which must instead follow a
// case's own policyVersionRecordId.

export interface VelocityLimits {
  maxDisputesPerPartyPerWindow: number;
  maxDisputesPerOrgPerWindow: number;
  rollingWindowDays: number;
  maxVolumeUsdPerPartyPerWindow: number;
}

export interface HumanReviewTriggers {
  highValueUsdThreshold: number;
  dualApprovalUsdThreshold: number;
}

export const DEFAULT_VELOCITY_LIMITS: VelocityLimits = {
  maxDisputesPerPartyPerWindow: 5,
  maxDisputesPerOrgPerWindow: 200,
  rollingWindowDays: 30,
  maxVolumeUsdPerPartyPerWindow: 50_000,
};

export const DEFAULT_HUMAN_REVIEW_TRIGGERS: HumanReviewTriggers = {
  highValueUsdThreshold: 10_000,
  dualApprovalUsdThreshold: 25_000,
};

export interface PublishPolicyVersionInput {
  evidenceDeadlineHours: number;
  appealWindowHours: number;
  allowedOutcomes: string[];
  autoSettlementCapNative: number | null;
  allowedAssets: string[];
  allowedChains: string[];
  kycRequired: boolean;
  velocityLimits: VelocityLimits;
  humanReviewTriggers: HumanReviewTriggers;
  publishedByMemberId?: string;
}

export class PolicyEngineError extends Error {}

/** Creates the named Policy slot for an org (idempotent on organizationId+key). Does NOT publish a version — call publishPolicyVersion next, a Policy with zero versions has nothing bindable. */
export async function createPolicy(organizationId: string, key: string, name: string) {
  return withDbRetry(() =>
    prisma.policy.upsert({
      where: { organizationId_key: { organizationId, key } },
      update: {},
      create: { organizationId, key, name },
    })
  );
}

function validateVelocityLimits(v: VelocityLimits): void {
  if (v.maxDisputesPerPartyPerWindow <= 0 || v.maxDisputesPerOrgPerWindow <= 0 || v.rollingWindowDays <= 0 || v.maxVolumeUsdPerPartyPerWindow <= 0) {
    throw new PolicyEngineError("velocityLimits fields must all be positive");
  }
}

function validateHumanReviewTriggers(t: HumanReviewTriggers): void {
  if (t.highValueUsdThreshold <= 0 || t.dualApprovalUsdThreshold <= 0) {
    throw new PolicyEngineError("humanReviewTriggers thresholds must be positive");
  }
}

/**
 * Publishes a new immutable PolicyVersion under an existing Policy — the
 * only way this engine's configuration ever changes. Deactivates the
 * previously-active version (so resolveActivePolicyVersion picks up the
 * new one for future case creation) but never touches any Case row that
 * already bound to the old version's id — that's what makes this
 * non-retroactive by construction, not by a runtime check.
 */
export async function publishPolicyVersion(policyId: string, input: PublishPolicyVersionInput) {
  if (input.evidenceDeadlineHours <= 0 || input.appealWindowHours <= 0) {
    throw new PolicyEngineError("evidenceDeadlineHours and appealWindowHours must be positive");
  }
  if (input.allowedOutcomes.length === 0) {
    throw new PolicyEngineError("allowedOutcomes must be non-empty");
  }
  if (input.autoSettlementCapNative !== null && input.autoSettlementCapNative <= 0) {
    throw new PolicyEngineError("autoSettlementCapNative must be positive when set");
  }
  validateVelocityLimits(input.velocityLimits);
  validateHumanReviewTriggers(input.humanReviewTriggers);

  return withDbRetry(() =>
    prisma.$transaction(async (tx) => {
      const latest = await tx.policyVersion.findFirst({
        where: { policyId },
        orderBy: { version: "desc" },
      });
      const nextVersion = (latest?.version ?? 0) + 1;
      if (latest) {
        await tx.policyVersion.update({ where: { id: latest.id }, data: { active: false } });
      }
      return tx.policyVersion.create({
        data: {
          policyId,
          version: nextVersion,
          active: true,
          publishedByMemberId: input.publishedByMemberId ?? null,
          evidenceDeadlineHours: input.evidenceDeadlineHours,
          appealWindowHours: input.appealWindowHours,
          allowedOutcomes: input.allowedOutcomes,
          autoSettlementCapNative: input.autoSettlementCapNative,
          allowedAssets: input.allowedAssets,
          allowedChains: input.allowedChains,
          kycRequired: input.kycRequired,
          velocityLimits: input.velocityLimits as unknown as Prisma.InputJsonValue,
          humanReviewTriggers: input.humanReviewTriggers as unknown as Prisma.InputJsonValue,
        },
      });
    })
  );
}

/** The org's currently-active PolicyVersion for a given policy key — used ONLY at case-creation time to decide what to bind a brand-new case to. Never call this to answer "what policy governs case X"; read case.policyVersionRecord instead. */
export async function resolveActivePolicyVersion(organizationId: string, policyKey: string) {
  const policy = await prisma.policy.findUnique({
    where: { organizationId_key: { organizationId, key: policyKey } },
    include: { versions: { where: { active: true }, take: 1 } },
  });
  return policy?.versions[0] ?? null;
}

export function parseVelocityLimits(json: unknown): VelocityLimits {
  const v = json as Partial<VelocityLimits> | null;
  return {
    maxDisputesPerPartyPerWindow: v?.maxDisputesPerPartyPerWindow ?? DEFAULT_VELOCITY_LIMITS.maxDisputesPerPartyPerWindow,
    maxDisputesPerOrgPerWindow: v?.maxDisputesPerOrgPerWindow ?? DEFAULT_VELOCITY_LIMITS.maxDisputesPerOrgPerWindow,
    rollingWindowDays: v?.rollingWindowDays ?? DEFAULT_VELOCITY_LIMITS.rollingWindowDays,
    maxVolumeUsdPerPartyPerWindow: v?.maxVolumeUsdPerPartyPerWindow ?? DEFAULT_VELOCITY_LIMITS.maxVolumeUsdPerPartyPerWindow,
  };
}

export function parseHumanReviewTriggers(json: unknown): HumanReviewTriggers {
  const t = json as Partial<HumanReviewTriggers> | null;
  return {
    highValueUsdThreshold: t?.highValueUsdThreshold ?? DEFAULT_HUMAN_REVIEW_TRIGGERS.highValueUsdThreshold,
    dualApprovalUsdThreshold: t?.dualApprovalUsdThreshold ?? DEFAULT_HUMAN_REVIEW_TRIGGERS.dualApprovalUsdThreshold,
  };
}

export type { RiskAction };
