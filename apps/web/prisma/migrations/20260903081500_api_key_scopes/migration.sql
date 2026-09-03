-- Real P0-adjacent gap fixed here (external audit finding): API keys
-- had no creator, no expiry, and no case restriction. Every new column
-- here is either nullable or has a safe default, so existing keys
-- (created before this migration, with genuinely unknown creator) are
-- unaffected -- they simply have creatorMemberId = NULL,
-- expiresAt = NULL (never expires, same as their current real
-- behavior), and restrictedToCaseIds = '{}' (unrestricted, same as
-- their current real behavior). No backfill ambiguity: nothing here
-- changes what an existing key can already do.
ALTER TABLE "ApiKey" ADD COLUMN "creatorMemberId" TEXT;
ALTER TABLE "ApiKey" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "ApiKey" ADD COLUMN "restrictedToCaseIds" TEXT[] NOT NULL DEFAULT '{}';
