-- Phase 3 ops console: persist canary run outcomes so "latest
-- successful canary" is a real queryable fact, independent of the
-- synthetic Case/Decision rows testnet-canary.ts always deletes.
CREATE TABLE "CanaryRun" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "relayTxHash" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanaryRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CanaryRun_runId_key" ON "CanaryRun"("runId");
CREATE INDEX "CanaryRun_chain_createdAt_idx" ON "CanaryRun"("chain", "createdAt");
