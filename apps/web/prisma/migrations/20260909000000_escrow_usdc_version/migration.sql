-- Track 2 follow-up: EscrowUSDC deployed to Sepolia at
-- 0x87e94aac03f1a032b264e035fd41a76bcdc802e2. deposits() returns the
-- same 192-byte shape as native V2, so it needs its own EscrowVersion
-- value distinguished by a real code-identity check (usdcToken()
-- getter probe + bytecode comparison against EscrowUSDC's own
-- reference), not the deposits()-shape probe alone.
ALTER TYPE "EscrowVersion" ADD VALUE 'USDC_V1';
