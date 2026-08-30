-- AlterTable: convert Evidence.type from the EvidenceType enum to plain TEXT,
-- preserving existing values via a cast instead of drop+recreate.
ALTER TABLE "Evidence" ALTER COLUMN "type" TYPE TEXT USING "type"::TEXT;

-- DropEnum
DROP TYPE "EvidenceType";
