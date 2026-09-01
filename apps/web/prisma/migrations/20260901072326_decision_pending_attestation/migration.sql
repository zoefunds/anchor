-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "pendingAttestationHash" TEXT,
ADD COLUMN     "pendingAttestationSignatures" TEXT[] DEFAULT ARRAY[]::TEXT[];
