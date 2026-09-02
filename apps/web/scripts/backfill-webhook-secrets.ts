#!/usr/bin/env npx tsx
// One-time backfill for the webhook-secret-encryption migration
// (prisma/migrations/20260902190000_encrypt_webhook_secrets). Reads
// every Webhook row whose new encrypted columns are still NULL, encrypts
// its existing plaintext "secret" column (which the current
// schema.prisma no longer models — read here via raw SQL, since Prisma
// Client only sees columns declared in the schema), and fills in
// secretCiphertext/secretIv/secretAuthTag/secretPreview.
//
// Run once, after applying the migration, before applying any follow-up
// migration that makes those columns NOT NULL / drops the plaintext
// "secret" column. Requires WEBHOOK_SECRET_ENCRYPTION_KEY to be set —
// the same key the running app uses (see apps/web/.env.example).
//
// Usage: npx tsx apps/web/scripts/backfill-webhook-secrets.ts

import { PrismaClient } from "@prisma/client";
import { encryptWebhookSecret, webhookSecretPreview } from "../src/lib/webhooks";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.$queryRaw<{ id: string; secret: string }[]>`
    SELECT id, secret FROM "Webhook"
    WHERE "secretCiphertext" IS NULL AND secret IS NOT NULL
  `;

  if (rows.length === 0) {
    console.log("nothing to backfill — every webhook already has an encrypted secret (or the table is empty)");
    return;
  }

  console.log(`backfilling ${rows.length} webhook(s)...`);
  for (const row of rows) {
    const encrypted = encryptWebhookSecret(row.secret);
    await prisma.webhook.update({
      where: { id: row.id },
      data: {
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        secretPreview: webhookSecretPreview(row.secret),
      },
    });
    console.log(`  ${row.id}: backfilled`);
  }
  console.log("done. Verify every row has a non-NULL secretCiphertext before applying the follow-up NOT-NULL/drop-column migration.");
}

main()
  .catch((err) => {
    console.error("backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
