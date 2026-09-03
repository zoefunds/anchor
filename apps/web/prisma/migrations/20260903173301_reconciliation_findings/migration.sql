-- CreateEnum
CREATE TYPE "ReconciliationFindingType" AS ENUM ('ZERO_SETTLEMENT_TARGET', 'TARGET_INTEGRATION_MISMATCH', 'OVERDUE_DEPOSIT', 'DISPATCHED_BUT_DB_STALE', 'AUDIT_ANCHOR_STALE');

-- CreateTable
CREATE TABLE "ReconciliationFinding" (
    "id" TEXT NOT NULL,
    "type" "ReconciliationFindingType" NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),

    CONSTRAINT "ReconciliationFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationFinding_resolvedAt_idx" ON "ReconciliationFinding"("resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationFinding_type_targetId_key" ON "ReconciliationFinding"("type", "targetId");
