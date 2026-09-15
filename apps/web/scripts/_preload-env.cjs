// Preloads apps/web/.env (and .env.local/.env.<APP_ENV>, same precedence
// as `next dev`) into process.env for the standalone scripts in this
// directory — none of them get this for free the way the Next.js app
// does, since `tsx scripts/whatever.ts` never reads .env on its own.
//
// A plain top-of-file `import`/`require` inside each script isn't
// reliable here: esbuild's ESM->CJS transform (what tsx uses) can hoist
// every import-derived require to the top of the compiled output ahead
// of any interleaved statement, so a script's own DATABASE_URL-reading
// imports can end up evaluated before an in-file env-loading call even
// if it's written first (confirmed empirically — see src/worker.ts's
// identical fix). A `--require` preload sidesteps that entirely: Node
// runs this file to completion before it even begins loading the target
// script's module graph.
//
// Usage: tsx --require ./scripts/_preload-env.cjs scripts/whatever.ts
const { loadEnvConfig } = require("@next/env");
const path = require("path");
loadEnvConfig(path.resolve(__dirname, ".."), true);
