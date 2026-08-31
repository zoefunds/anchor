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
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
