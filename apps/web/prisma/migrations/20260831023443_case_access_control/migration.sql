-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "restricted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CaseAccess" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseAccess_caseId_idx" ON "CaseAccess"("caseId");

-- CreateIndex
CREATE INDEX "CaseAccess_memberId_idx" ON "CaseAccess"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "CaseAccess_caseId_memberId_key" ON "CaseAccess"("caseId", "memberId");

-- AddForeignKey
ALTER TABLE "CaseAccess" ADD CONSTRAINT "CaseAccess_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseAccess" ADD CONSTRAINT "CaseAccess_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
