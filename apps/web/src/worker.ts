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
//
// Requires APP_ENV (development/staging/production) and fails fast if it
// doesn't match the database this process's DATABASE_URL points at — see
// lib/app-env.ts. A standalone worker process (e.g. a manually run
// `docker run` container while testing an image before deploying it) is
// exactly the shape of process that caused a real incident by pointing
// at production Redis with a different database underneath it; this
// exits immediately instead of silently consuming the wrong queue.

import { startAdjudicationWorker } from "@/lib/worker";

startAdjudicationWorker()
  .then((worker) => {
    // eslint-disable-next-line no-console
    console.log("worker: started, connected to Redis, waiting for jobs");

    function shutdown(signal: string): void {
      // eslint-disable-next-line no-console
      console.log(`worker: received ${signal}, finishing in-flight jobs then exiting`);
      worker.close().then(() => process.exit(0));
    }

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker: failed to start:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
