-- USDC support removed entirely (see this commit's message): the
-- deployed EscrowUSDC.sol at 0x87e94aac03f1a032b264e035fd41a76bcdc802e2
-- on Sepolia is left exactly as-is on-chain (immutable, still holds 3
-- real testnet USDC from a live test that never dispatched because of
-- DecisionRelay's single-settlement-target-per-chain limitation), but
-- Anchor's application layer no longer references it at all, so the
-- 'USDC_V1' EscrowVersion enum value is dead code from here on.
--
-- Postgres cannot drop a single enum value in place — the type must be
-- recreated. This is safe here because no SettlementIntegration row
-- uses 'USDC_V1' (verified before writing this migration: `SELECT
-- count(*) FROM "SettlementIntegration" WHERE "escrowVersion" =
-- 'USDC_V1'` returned 0 against the local dev DB). If a genuinely
-- different environment's DB has USDC_V1 rows, this migration will
-- fail loudly at the ALTER TABLE step below rather than silently
-- corrupting data — resolve those rows first before applying it there.

ALTER TABLE "SettlementIntegration" ALTER COLUMN "escrowVersion" DROP DEFAULT;

ALTER TYPE "EscrowVersion" RENAME TO "EscrowVersion_old";

CREATE TYPE "EscrowVersion" AS ENUM ('V1', 'V2', 'SOLANA_V1');

ALTER TABLE "SettlementIntegration"
  ALTER COLUMN "escrowVersion" TYPE "EscrowVersion"
  USING ("escrowVersion"::text::"EscrowVersion");

ALTER TABLE "SettlementIntegration" ALTER COLUMN "escrowVersion" SET DEFAULT 'V1';

DROP TYPE "EscrowVersion_old";
