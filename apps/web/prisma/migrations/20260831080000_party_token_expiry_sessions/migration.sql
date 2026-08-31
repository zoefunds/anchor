-- Bounds how long a party bearer token stays valid, and adds a
-- short-lived session-exchange table so the raw token doesn't need to
-- be resent (and therefore leak into URLs/logs/history) on every
-- request. See lib/party-auth.ts.
ALTER TABLE "Case" ADD COLUMN "claimantTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "Case" ADD COLUMN "respondentTokenExpiresAt" TIMESTAMP(3);

CREATE TABLE "PartySession" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartySession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PartySession_tokenHash_key" ON "PartySession"("tokenHash");
CREATE INDEX "PartySession_caseId_idx" ON "PartySession"("caseId");

ALTER TABLE "PartySession" ADD CONSTRAINT "PartySession_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
