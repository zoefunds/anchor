-- CreateEnum
CREATE TYPE "CaseSettlementStatus" AS ENUM ('PENDING_DEPOSIT', 'DEPOSITED', 'SETTLED', 'MISMATCH_BLOCKED');

-- CreateTable
CREATE TABLE "SettlementIntegration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "escrowContractAddress" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "assetDecimals" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseSettlement" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "claimantAddress" TEXT NOT NULL,
    "respondentAddress" TEXT NOT NULL,
    "expectedAmountAtto" TEXT NOT NULL,
    "status" "CaseSettlementStatus" NOT NULL DEFAULT 'PENDING_DEPOSIT',
    "depositTxHash" TEXT,
    "depositConfirmedAt" TIMESTAMP(3),
    "settledTxHash" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementIntegration_organizationId_idx" ON "SettlementIntegration"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseSettlement_caseId_key" ON "CaseSettlement"("caseId");

-- CreateIndex
CREATE INDEX "CaseSettlement_integrationId_idx" ON "CaseSettlement"("integrationId");

-- AddForeignKey
ALTER TABLE "SettlementIntegration" ADD CONSTRAINT "SettlementIntegration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSettlement" ADD CONSTRAINT "CaseSettlement_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseSettlement" ADD CONSTRAINT "CaseSettlement_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "SettlementIntegration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
