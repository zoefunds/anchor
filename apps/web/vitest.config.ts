import { defineConfig } from "vitest/config";
import path from "path";

// Integration tests hit a real local Postgres (same DATABASE_URL as
// `npm run dev`, see .env) through the actual route handlers and
// lib/*.ts functions — no mocked Prisma client, no HTTP server. That's
// enough for App Router route handlers: they're just async functions
// that take a (Next-flavored) Request and return a Response, so calling
// them directly exercises the real auth/validation/DB logic without the
// overhead of spinning up `next start`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts", "tests/unit/**/*.test.ts"],
    setupFiles: ["tests/setup/guard-test-database.ts"],
    testTimeout: 15000,
    // These tests hit one real, shared local Postgres with no per-file
    // isolation (no schema-per-worker, no transactional rollback) — and
    // some (retryFailedSettlements-based tests in particular) query
    // GLOBALLY across all organizations, not scoped to their own test
    // fixtures. Running test FILES in parallel (Vitest's default) is a
    // real, reproduced source of flakiness: one file's in-flight fixture
    // rows get swept up by another file's sweep-based assertions. Found
    // live while adding solana-cosign.test.ts — a genuinely correct test
    // failed intermittently only when run alongside the rest of the
    // suite, never in isolation. Forcing sequential file execution
    // trades a few seconds of wall-clock time for deterministic results,
    // which matters far more for a suite this size.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
