-- CreateEnum
CREATE TYPE "EscrowVersion" AS ENUM ('V1', 'V2');

-- AlterEnum
ALTER TYPE "ReconciliationFindingType" ADD VALUE 'ESCROW_VERSION_MISMATCH';

-- AlterTable
ALTER TABLE "SettlementIntegration" ADD COLUMN     "escrowVersion" "EscrowVersion" NOT NULL DEFAULT 'V1';
