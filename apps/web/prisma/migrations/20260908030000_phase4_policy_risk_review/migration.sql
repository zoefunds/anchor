-- Phase 4: configurable versioned policy engine, risk/anti-abuse
-- controls, and human escalation. See prisma/schema.prisma's own
-- comments on Policy/PolicyVersion/RiskAssessment/CaseReview for the
-- immutability and gating semantics these tables encode.

CREATE TYPE "RiskAction" AS ENUM ('ALLOW', 'REQUIRE_KYC', 'REQUIRE_REVIEW', 'BLOCK');
CREATE TYPE "ReviewTrigger" AS ENUM ('HIGH_VALUE', 'FRAUD_RISK', 'MANUAL');
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Policy_organizationId_key_key" ON "Policy"("organizationId", "key");
CREATE INDEX "Policy_organizationId_idx" ON "Policy"("organizationId");

ALTER TABLE "Policy" ADD CONSTRAINT "Policy_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByMemberId" TEXT,
    "evidenceDeadlineHours" INTEGER NOT NULL,
    "appealWindowHours" INTEGER NOT NULL,
    "allowedOutcomes" TEXT[],
    "autoSettlementCapUsd" DECIMAL(65,30),
    "allowedAssets" TEXT[],
    "allowedChains" TEXT[],
    "kycRequired" BOOLEAN NOT NULL DEFAULT false,
    "velocityLimits" JSONB NOT NULL,
    "humanReviewTriggers" JSONB NOT NULL,

    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PolicyVersion_policyId_version_key" ON "PolicyVersion"("policyId", "version");
CREATE INDEX "PolicyVersion_policyId_idx" ON "PolicyVersion"("policyId");

ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Case" ADD COLUMN "policyVersionRecordId" TEXT;
CREATE INDEX "Case_policyVersionRecordId_idx" ON "Case"("policyVersionRecordId");
ALTER TABLE "Case" ADD CONSTRAINT "Case_policyVersionRecordId_fkey"
    FOREIGN KEY ("policyVersionRecordId") REFERENCES "PolicyVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RiskAssessment" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "action" "RiskAction" NOT NULL,
    "reasons" TEXT[],
    "claimantRecentDisputeCount" INTEGER NOT NULL,
    "respondentRecentDisputeCount" INTEGER NOT NULL,
    "repeatPairDisputeCount" INTEGER NOT NULL,
    "orgRollingDisputeCount" INTEGER NOT NULL,
    "orgRollingVolumeUsd" DECIMAL(65,30) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recheckedAt" TIMESTAMP(3),
    "recheckAction" "RiskAction",
    "recheckReasons" TEXT[],

    CONSTRAINT "RiskAssessment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RiskAssessment_caseId_key" ON "RiskAssessment"("caseId");
CREATE INDEX "RiskAssessment_action_idx" ON "RiskAssessment"("action");

ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CaseReview" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "trigger" "ReviewTrigger" NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "requiresDualApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CaseReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CaseReview_caseId_key" ON "CaseReview"("caseId");
CREATE INDEX "CaseReview_status_idx" ON "CaseReview"("status");

ALTER TABLE "CaseReview" ADD CONSTRAINT "CaseReview_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CaseReviewApproval" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseReviewApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CaseReviewApproval_reviewId_memberId_key" ON "CaseReviewApproval"("reviewId", "memberId");
CREATE INDEX "CaseReviewApproval_reviewId_idx" ON "CaseReviewApproval"("reviewId");

ALTER TABLE "CaseReviewApproval" ADD CONSTRAINT "CaseReviewApproval_reviewId_fkey"
    FOREIGN KEY ("reviewId") REFERENCES "CaseReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CaseReviewNote" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseReviewNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CaseReviewNote_reviewId_idx" ON "CaseReviewNote"("reviewId");

ALTER TABLE "CaseReviewNote" ADD CONSTRAINT "CaseReviewNote_reviewId_fkey"
    FOREIGN KEY ("reviewId") REFERENCES "CaseReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
