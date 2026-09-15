import { defineConfig } from "vitest/config";
import path from "path";
import { loadEnvConfig } from "@next/env";

// See vitest.config.ts's identical line for why this is needed at all —
// Vitest never loads apps/web/.env on its own.
loadEnvConfig(path.resolve(__dirname), true);

// Priority 1 of the settlement-readiness gaps: a real Anvil-based EVM
// integration suite, kept as its own vitest project/config (not lumped
// into vitest.config.ts's tests/integration include) because it needs
// `anvil` on PATH and real compiled Foundry artifacts under
// chains/evm/out/ — a CI job without Foundry installed shouldn't
// silently skip these, it should have its own explicit, required gate.
// See .github/workflows/web-evm-integration-tests.yml.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration-evm/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
