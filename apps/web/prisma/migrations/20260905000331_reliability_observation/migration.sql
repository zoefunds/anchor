-- CreateTable
CREATE TABLE "ReliabilityObservation" (
    "id" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checks" JSONB NOT NULL,
    "passCount" INTEGER NOT NULL,
    "warnCount" INTEGER NOT NULL,
    "failCount" INTEGER NOT NULL,
    "maxCheckpointLagLeaves" INTEGER,
    "scriptCrashed" BOOLEAN NOT NULL DEFAULT false,
    "crashDetail" TEXT,

    CONSTRAINT "ReliabilityObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReliabilityObservation_capturedAt_idx" ON "ReliabilityObservation"("capturedAt");
