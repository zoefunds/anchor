-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "adjudicateTxHash" TEXT,
ADD COLUMN     "contractCodeHash" TEXT,
ADD COLUMN     "decisionHash" TEXT,
ADD COLUMN     "evidenceManifestHash" TEXT;
