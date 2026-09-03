-- CreateEnum
CREATE TYPE "PartyVerificationStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'APPROVED', 'DECLINED', 'IN_REVIEW', 'ABANDONED', 'EXPIRED');

-- CreateTable
CREATE TABLE "PartyVerification" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "role" "PartyRole" NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" "PartyVerificationStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "decision" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartyVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartyVerification_sessionId_key" ON "PartyVerification"("sessionId");

-- CreateIndex
CREATE INDEX "PartyVerification_caseId_idx" ON "PartyVerification"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "PartyVerification_caseId_role_key" ON "PartyVerification"("caseId", "role");

-- AddForeignKey
ALTER TABLE "PartyVerification" ADD CONSTRAINT "PartyVerification_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
