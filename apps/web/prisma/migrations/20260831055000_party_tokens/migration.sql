-- Per-party capability tokens for real party-specific standing on
-- evidence submission and appeal, independent of org session/API-key
-- auth. NULL-safe unique constraints (Postgres allows multiple NULLs
-- under UNIQUE) since existing cases have neither token yet.
ALTER TABLE "Case" ADD COLUMN "claimantTokenHash" TEXT;
ALTER TABLE "Case" ADD COLUMN "respondentTokenHash" TEXT;
CREATE UNIQUE INDEX "Case_claimantTokenHash_key" ON "Case"("claimantTokenHash");
CREATE UNIQUE INDEX "Case_respondentTokenHash_key" ON "Case"("respondentTokenHash");
