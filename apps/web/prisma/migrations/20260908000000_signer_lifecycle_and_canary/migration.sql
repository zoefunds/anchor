-- Phase 1 (signer/settlement/delivery reliability): explicit signer
-- lifecycle tracking, canary-record marking, and two new escalation
-- finding types. Purely additive.

-- AlterEnum
ALTER TYPE "ReconciliationFindingType" ADD VALUE 'RELAY_RETRIES_EXHAUSTED';
ALTER TYPE "ReconciliationFindingType" ADD VALUE 'CANARY_SLA_BREACH';

-- AlterTable
ALTER TABLE "Case" ADD COLUMN "isCanary" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum
CREATE TYPE "SignerLifecycleState" AS ENUM ('SIGNING', 'QUORUM_REACHED', 'DISPATCHED', 'DELIVERED', 'SETTLED', 'FAILED', 'ESCALATED');

-- CreateTable
CREATE TABLE "SignerLifecycleEvent" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "state" "SignerLifecycleState" NOT NULL,
    "signerAddress" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignerLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SignerLifecycleEvent_decisionId_idx" ON "SignerLifecycleEvent"("decisionId");

-- CreateIndex
CREATE INDEX "SignerLifecycleEvent_chain_state_idx" ON "SignerLifecycleEvent"("chain", "state");
