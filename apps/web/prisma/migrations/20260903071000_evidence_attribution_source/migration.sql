-- Real P1 fixed here (external audit finding): Evidence.submittedBy was
-- the only attribution signal, and for organization-authenticated
-- routes it was a caller-supplied, unverified assertion. This adds a
-- server-derived attributionSource that every evidence route now sets
-- explicitly (see api/cases/:id/evidence*.ts,
-- api/public/cases/:id/evidence*.ts) — never taken from request input.
--
-- Safe for existing rows: DEFAULT 'organization_asserted' is the most
-- conservative possible value (never overstates trust for pre-existing
-- data), applied automatically to every row that already exists when
-- this column is added.
CREATE TYPE "EvidenceAttributionSource" AS ENUM ('organization_asserted', 'claimant_authenticated', 'respondent_authenticated');

ALTER TABLE "Evidence" ADD COLUMN "attributionSource" "EvidenceAttributionSource" NOT NULL DEFAULT 'organization_asserted';
