-- TRACK 1, item 1: whole-system 30-day reliability observation window.
-- See prisma/schema.prisma's ReliabilityWindowObservation comment and
-- docs/reliability-observation-window.md for the pass/fail rule this
-- table's rows are scored against.

CREATE TABLE "ReliabilityWindowObservation" (
    "id" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "components" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "failReasons" TEXT[] NOT NULL,
    "notes" TEXT,
    "remediation" TEXT,
    "observationHash" TEXT NOT NULL,

    CONSTRAINT "ReliabilityWindowObservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReliabilityWindowObservation_capturedAt_idx" ON "ReliabilityWindowObservation"("capturedAt");
