import { getAdjudicationQueue } from "@/lib/queue";
import { getAppEnv } from "@/lib/app-env";

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

// Real bug found 2026-09-18: adjudicate_case used the default attempts: 3
// above, which sounds like harmless resilience but isn't for this job
// specifically — runAdjudicationJob's own catch block ALREADY marks the
// case UNDETERMINED on any failure and then re-throws (deliberately, so
// BullMQ records the failure — see that function's own comment), which
// meant a real GenLayer consensus/LLM failure (not just a transient
// network blip) silently triggered up to 2 MORE automatic
// runAdjudicationJob invocations — each capable of a real second
// adjudicate() contract call — with no org/frontend action ever
// requesting it. An org watching a case go UNDETERMINED had no way to
// know a second (or third) real adjudication attempt was happening
// invisibly in the background, consuming GenLayer calls and potentially
// landing on ANOTHER UNDETERMINED before the org ever got to decide
// whether to retry at all. adjudicate_case now gets exactly one attempt;
// a genuine transient failure surfaces as UNDETERMINED like any other
// failure, and the org explicitly chooses to retry via
// POST /api/cases/:id/reopen (see that route — it also deploys a fresh
// contract, never reusing the one that just failed/disagreed).
const JOB_OPTIONS_BY_TYPE: Record<string, Partial<typeof JOB_OPTIONS>> = {
  adjudicate_case: { attempts: 1 },
};

export async function enqueueJob(type: string, payload: Record<string, unknown>): Promise<string> {
  // _env: second, belt-and-suspenders environment guard checked by
  // lib/worker.ts's assertJobEnvMatches — see lib/app-env.ts for the
  // primary one (the queue name itself is already APP_ENV-namespaced, so
  // this should never actually mismatch; it's here in case that
  // namespacing is ever bypassed by a misconfiguration).
  const options = { ...JOB_OPTIONS, ...JOB_OPTIONS_BY_TYPE[type] };
  const job = await getAdjudicationQueue().add(type, { ...payload, _env: getAppEnv() }, options);
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
  import("@/lib/worker")
    .then(({ startAdjudicationWorker }) => startAdjudicationWorker())
    .catch((err) => {
      // Env mismatch (see lib/app-env.ts) or a real connection failure —
      // either way, the in-process worker never started. Jobs enqueued
      // by this process will sit unprocessed rather than being picked up
      // by a possibly-wrong-environment worker; log loudly so it's
      // impossible to miss instead of enqueueJob() calls silently
      // succeeding into a queue nothing is draining.
      // eslint-disable-next-line no-console
      console.error("jobs: in-process worker failed to start:", err instanceof Error ? err.message : err);
    });
}
