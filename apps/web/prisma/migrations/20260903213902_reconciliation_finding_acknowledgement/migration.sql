-- CreateEnum
CREATE TYPE "ReconciliationFindingEventType" AS ENUM ('ACKNOWLEDGED', 'NOTE');

-- AlterTable
ALTER TABLE "ReconciliationFinding" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "acknowledgedByMemberId" TEXT;

-- CreateTable
CREATE TABLE "ReconciliationFindingEvent" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "type" "ReconciliationFindingEventType" NOT NULL,
    "memberId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationFindingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationFindingEvent_findingId_idx" ON "ReconciliationFindingEvent"("findingId");

-- AddForeignKey
ALTER TABLE "ReconciliationFindingEvent" ADD CONSTRAINT "ReconciliationFindingEvent_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "ReconciliationFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
