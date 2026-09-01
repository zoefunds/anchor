-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "lastAnchorTxHash" TEXT,
ADD COLUMN     "lastAnchoredAt" TIMESTAMP(3),
ADD COLUMN     "lastAnchoredHash" TEXT;
