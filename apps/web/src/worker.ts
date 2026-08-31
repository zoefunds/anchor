// Standalone job worker — runs the same runOnce() loop as the in-process
// poller in lib/jobs.ts, but as its own long-lived process instead of a
// setInterval inside the Next.js server. Two cases this is for:
//
//   1. A serverless web deployment (Vercel, etc) has no long-lived process
//      to host the in-process poller at all — the in-process poller only
//      works under `next start` on a server you keep running yourself.
//   2. Scaling job throughput independently of web request throughput —
//      run N of these without touching the web deployment.
//
// Run: npm run worker (from apps/web), or `tsx src/worker.ts` directly.
// Set JOB_WORKER_EXTERNAL=1 on the web process once this is running
// somewhere, so it stops also polling in-process (see lib/jobs.ts) - not
// required for correctness (claimNextJob's optimistic locking makes
// running both harmless), just avoids a wasted query every tick.

import { runOnce, POLL_INTERVAL_MS } from "@/lib/jobs";

let stopping = false;

async function loop(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`worker: started, polling every ${POLL_INTERVAL_MS}ms`);
  while (!stopping) {
    try {
      await runOnce();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("worker: tick failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  // eslint-disable-next-line no-console
  console.log("worker: stopped");
}

function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`worker: received ${signal}, finishing current tick then exiting`);
  stopping = true;
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

loop();
