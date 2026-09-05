-- AlterTable
ALTER TABLE "ReliabilityObservation" ADD COLUMN     "rpcStats" JSONB,
ADD COLUMN     "state" TEXT NOT NULL DEFAULT 'UNKNOWN';
