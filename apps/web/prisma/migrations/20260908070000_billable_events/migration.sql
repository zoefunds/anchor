-- CreateEnum
CREATE TYPE "BillableEventType" AS ENUM ('CASE_OPENED', 'ADJUDICATION_RUN', 'EVIDENCE_STORAGE_MB', 'API_CALL', 'SETTLEMENT_COMPLETED');

-- CreateTable
CREATE TABLE "BillableEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventType" "BillableEventType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillableEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillableEvent_organizationId_eventType_createdAt_idx" ON "BillableEvent"("organizationId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "BillableEvent_subjectId_idx" ON "BillableEvent"("subjectId");
