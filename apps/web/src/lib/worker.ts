import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { ADJUDICATION_QUEUE_NAME, getAdjudicationQueue } from "@/lib/queue";
import { runAdjudicationJob, finalizeExpiredAppealWindows } from "@/lib/adjudication-service";

// The actual BullMQ job processor — separate from src/worker.ts (the
// standalone process entrypoint) because this module is also imported
// in-process by lib/jobs.ts's ensureJobWorker(). Both paths end up
// calling startAdjudicationWorker(); which one does depends on whether
// you're running `next start`/`next dev` (in-process) or `npm run worker`
// (standalone, src/worker.ts).

const FINALIZE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let worker: Worker | null = null;

async function processJob(job: Job): Promise<void> {
  if (job.name === "finalize_expired_appeals") {
    const count = await finalizeExpiredAppealWindows();
    if (count > 0) {
      // eslint-disable-next-line no-console
      console.log(`worker: finalized ${count} case(s) with expired appeal windows`);
    }
    return;
  }
  if (job.name !== "adjudicate_case") {
    throw new Error(`no handler registered for job type ${job.name}`);
  }
  const caseId = job.data.caseId as string;
  const isAppeal = Boolean(job.data.isAppeal);
  await runAdjudicationJob(caseId, isAppeal);
}

/**
 * Registers the periodic appeal-window finalization sweep (see
 * adjudication-service.ts's finalizeExpiredAppealWindows) as a BullMQ
 * repeatable job — this is what actually finalizes and settles the
 * common case (a decision nobody appealed), since nothing else advances
 * a case out of APPEAL_WINDOW on its own. Registering a repeatable job
 * with the same name/pattern more than once is a safe no-op in BullMQ
 * (it dedupes by repeat key), so calling this on every worker startup
 * doesn't create duplicate schedules.
 */
async function ensureFinalizeSweepScheduled(): Promise<void> {
  await getAdjudicationQueue().upsertJobScheduler(
    "finalize-expired-appeals-sweep",
    { every: FINALIZE_SWEEP_INTERVAL_MS },
    { name: "finalize_expired_appeals" }
  );
}

/** Idempotent — starts the BullMQ Worker once per process; safe to call more than once. */
export function startAdjudicationWorker(): Worker {
  if (worker) return worker;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is not set — see apps/web/.env.example");
  }
  const connection = new IORedis(url, { maxRetriesPerRequest: null });

  worker = new Worker(ADJUDICATION_QUEUE_NAME, processJob, { connection, concurrency: 5 });

  worker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`worker: job ${job?.id} (${job?.name}) failed:`, err.message);
  });
  worker.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("worker: connection error:", err.message);
  });

  ensureFinalizeSweepScheduled().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker: failed to schedule finalize sweep:", err instanceof Error ? err.message : err);
  });

  return worker;
}
