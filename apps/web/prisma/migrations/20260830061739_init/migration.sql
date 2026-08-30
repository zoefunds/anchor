-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'EVIDENCE_COLLECTION', 'SUBMITTED', 'ADJUDICATING', 'ACCEPTED', 'APPEAL_WINDOW', 'APPEALED', 'RE_ADJUDICATING', 'FINALIZED', 'UNDETERMINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('task_spec', 'delivery_payload', 'claimant_statement', 'respondent_statement', 'delivery_metadata');

-- CreateEnum
CREATE TYPE "PartyRole" AS ENUM ('claimant', 'respondent');

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "claim" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "policyId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "claimantRef" TEXT NOT NULL,
    "respondentRef" TEXT NOT NULL,
    "contractAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "type" "EvidenceType" NOT NULL,
    "contentHash" TEXT NOT NULL,
    "storageRef" TEXT NOT NULL,
    "submittedBy" "PartyRole",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "claimantShareBps" INTEGER,
    "respondentShareBps" INTEGER,
    "reasonCodes" TEXT[],
    "evidenceUsed" TEXT[],
    "consensus" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "proofHash" TEXT,
    "explanation" TEXT,
    "appealWindowClosesAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Case_status_idx" ON "Case"("status");

-- CreateIndex
CREATE INDEX "Evidence_caseId_idx" ON "Evidence"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_caseId_key" ON "Decision"("caseId");

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
