-- Real P1 fix (external audit finding, raised twice): Webhook.secret was
-- stored in plaintext and returned in full on every GET. New columns
-- hold an AES-256-GCM-encrypted secret instead (see
-- src/lib/webhooks.ts's encryptWebhookSecret/decryptWebhookSecret).
--
-- Added NULLABLE, on purpose: this migration does not (and structurally
-- cannot, from raw SQL alone) encrypt existing plaintext secrets — that
-- requires the app-level encryption key. The old plaintext "secret"
-- column is intentionally NOT dropped here either, so nothing is lost.
--
-- Required rollout order for existing rows with data (unnecessary if
-- this table has no rows yet):
--   1. Apply this migration.
--   2. Run scripts/backfill-webhook-secrets.ts once, with
--      WEBHOOK_SECRET_ENCRYPTION_KEY set — it reads every webhook whose
--      new columns are still NULL, encrypts its existing plaintext
--      "secret", and fills them in.
--   3. Only after every row has non-NULL secretCiphertext/secretIv/
--      secretAuthTag/secretPreview, apply a follow-up migration that
--      sets those columns NOT NULL and drops the plaintext "secret"
--      column. That follow-up is intentionally not included in this
--      migration — applying it before the backfill has actually run
--      would either fail (NOT NULL on rows with NULL data) or silently
--      leave the plaintext secret exposed a while longer.
ALTER TABLE "Webhook" ADD COLUMN "secretCiphertext" TEXT;
ALTER TABLE "Webhook" ADD COLUMN "secretIv" TEXT;
ALTER TABLE "Webhook" ADD COLUMN "secretAuthTag" TEXT;
ALTER TABLE "Webhook" ADD COLUMN "secretPreview" TEXT;
