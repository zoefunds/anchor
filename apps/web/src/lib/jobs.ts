import { getAdjudicationQueue } from "@/lib/queue";

// Enqueues jobs onto the real BullMQ queue (see lib/queue.ts for why this
// replaced the earlier DB-polling `Job` table). Processing itself lives in
// lib/worker.ts, driven by either the in-process worker started by
// ensureJobWorker() below, or the standalone entrypoint at src/worker.ts
// (`npm run worker`) — same tradeoffs as before (single `next start`
// process vs. serverless/independent scaling), just on a real broker now
// instead of a poll loop. Set JOB_WORKER_EXTERNAL=1 to stop the web
// process from also running an in-process worker once a dedicated one is
// deployed.

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 }, // keep completed jobs 7 days for debugging, then GC
  removeOnFail: false, // failed jobs (BullMQ's own dead-letter set) are kept indefinitely until manually cleared
};

export async function enqueueJob(type: string, payload: Record<string, unknown>): Promise<string> {
  const job = await getAdjudicationQueue().add(type, payload, JOB_OPTIONS);
  return job.id!;
}

let workerStarted = false;

/**
 * Idempotent - call on every request that needs the queue running; only
 * actually starts the in-process BullMQ Worker once per process. No-ops
 * when JOB_WORKER_EXTERNAL is set, since that means a standalone worker
 * process (src/worker.ts) is the one running it instead.
 */
export function ensureJobWorker(): void {
  if (workerStarted || process.env.JOB_WORKER_EXTERNAL) return;
  workerStarted = true;
  // Deferred import: lib/worker.ts pulls in adjudication-service and its
  // own dependency chain, which every route importing lib/jobs.ts
  // (enqueueJob callers) doesn't need loaded just to enqueue.
  import("@/lib/worker").then(({ startAdjudicationWorker }) => startAdjudicationWorker());
}
