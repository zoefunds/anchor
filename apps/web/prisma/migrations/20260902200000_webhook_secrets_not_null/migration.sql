-- Follow-up to 20260902190000_encrypt_webhook_secrets, applied only
-- after confirming (both on staging and on the real production
-- database) that every Webhook row has a non-NULL secretCiphertext/
-- secretIv/secretAuthTag/secretPreview — production had zero Webhook
-- rows at the time this was written, so there was nothing to backfill
-- and this is unconditionally safe there. If this is ever run against
-- a database with existing Webhook rows, run
-- scripts/backfill-webhook-secrets.ts first and confirm every row is
-- backfilled (see that migration's own comment) — this migration will
-- fail loudly (a real Postgres error) rather than silently drop data
-- if any row still has a NULL encrypted column, since SET NOT NULL
-- itself enforces that.
ALTER TABLE "Webhook" ALTER COLUMN "secretCiphertext" SET NOT NULL;
ALTER TABLE "Webhook" ALTER COLUMN "secretIv" SET NOT NULL;
ALTER TABLE "Webhook" ALTER COLUMN "secretAuthTag" SET NOT NULL;
ALTER TABLE "Webhook" ALTER COLUMN "secretPreview" SET NOT NULL;

-- The plaintext secret this whole migration pair exists to stop
-- storing. Safe to drop now that every row has an encrypted
-- replacement (enforced by the NOT NULL constraints just added above —
-- this statement would never be reached if any row lacked one).
ALTER TABLE "Webhook" DROP COLUMN "secret";
