-- Phase 5, item B: API-key scopes/rotation + per-org rate-limit tiers.
-- Phase 5, item C: minimal manually-appended incident history for the
-- public status page. See prisma/schema.prisma's comments on ApiKey,
-- Organization.apiRateLimitPerMinute, and Incident for the semantics.

ALTER TABLE "ApiKey" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "ApiKey" ADD COLUMN "rotatedFromKeyId" TEXT;

ALTER TABLE "Organization" ADD COLUMN "apiRateLimitPerMinute" INTEGER NOT NULL DEFAULT 120;

CREATE TYPE "IncidentStatus" AS ENUM ('INVESTIGATING', 'MONITORING', 'RESOLVED');

CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'INVESTIGATING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Incident_startedAt_idx" ON "Incident"("startedAt");

ALTER TABLE "Incident" ADD CONSTRAINT "Incident_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
