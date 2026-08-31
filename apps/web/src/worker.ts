// Standalone job worker — starts the same BullMQ Worker as the in-process
// one (lib/jobs.ts's ensureJobWorker()), but as its own long-lived process
// instead of running inside the Next.js server. Two cases this is for:
//
//   1. A serverless web deployment (Vercel, etc) has nowhere to host a
//      long-lived BullMQ Worker connection at all.
//   2. Scaling job throughput independently of web request throughput —
//      run N of these against the same Redis queue without touching the
//      web deployment; BullMQ's own connection/concurrency handling deals
//      with multiple workers pulling from one queue correctly.
//
// Run: npm run worker (from apps/web), or `tsx src/worker.ts` directly.
// Set JOB_WORKER_EXTERNAL=1 on the web process once this is running
// somewhere, so it stops also starting an in-process worker (not required
// for correctness — BullMQ workers on the same queue don't double-process
// a job — just avoids an idle Redis connection doing nothing there).

import { startAdjudicationWorker } from "@/lib/worker";

const worker = startAdjudicationWorker();
// eslint-disable-next-line no-console
console.log("worker: started, connected to Redis, waiting for jobs");

function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`worker: received ${signal}, finishing in-flight jobs then exiting`);
  worker.close().then(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
