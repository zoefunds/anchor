-- Tamper-evidence hash chain for AuditLog (see lib/audit.ts).
--
-- Existing rows predate this chain and were never hashed at write time,
-- so they cannot honestly be backfilled with a real chain hash — doing
-- that would fabricate the appearance of tamper-evidence for history
-- that was never actually protected. Instead, each existing row gets a
-- unique, clearly-labeled sentinel value ("legacy-unchained:<id>") for
-- both columns, so it's structurally obvious on inspection that these
-- rows sit outside the verifiable chain. Every row created after this
-- migration gets a real chain hash from application code (lib/audit.ts).

ALTER TABLE "AuditLog" ADD COLUMN "prevHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "hash" TEXT;

UPDATE "AuditLog" SET
  "prevHash" = 'legacy-unchained:' || "id",
  "hash" = 'legacy-unchained:' || "id"
WHERE "hash" IS NULL;

ALTER TABLE "AuditLog" ALTER COLUMN "prevHash" SET NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "hash" SET NOT NULL;

CREATE UNIQUE INDEX "AuditLog_hash_key" ON "AuditLog"("hash");
