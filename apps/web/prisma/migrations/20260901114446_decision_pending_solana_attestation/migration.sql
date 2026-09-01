-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "pendingSolanaAttestationMessage" TEXT,
ADD COLUMN     "pendingSolanaAttestations" JSONB DEFAULT '[]';
