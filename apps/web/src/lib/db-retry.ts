// Extracted from adjudication-service.ts (see that file's own history
// comment for the real 2026-09-07 incident this exists to prevent) so
// lib/signer-lifecycle.ts and scripts/testnet-canary.ts can reuse the
// exact same "retry only transient DB errors" discipline without a
// circular import back into adjudication-service.ts, which itself now
// imports lib/signer-lifecycle.ts.
const TRANSIENT_PRISMA_ERROR_CODES = new Set(["P1001", "P1002", "P1008", "P1017"]);

function isTransientPrismaError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === "string" && TRANSIENT_PRISMA_ERROR_CODES.has(code);
}

export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientPrismaError(err)) throw err;
      const delayMs = 1000 * 2 ** i; // 1s, 2s, 4s, 8s, 16s
      // eslint-disable-next-line no-console
      console.error(`withDbRetry: transient DB error (attempt ${i + 1}/${attempts}), retrying in ${delayMs}ms:`, (err as Error).message);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}
