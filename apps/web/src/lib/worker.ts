import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { ADJUDICATION_QUEUE_NAME } from "@/lib/queue";
import { runAdjudicationJob } from "@/lib/adjudication-service";

// The actual BullMQ job processor — separate from src/worker.ts (the
// standalone process entrypoint) because this module is also imported
// in-process by lib/jobs.ts's ensureJobWorker(). Both paths end up
// calling startAdjudicationWorker(); which one does depends on whether
// you're running `next start`/`next dev` (in-process) or `npm run worker`
// (standalone, src/worker.ts).

let worker: Worker | null = null;

async function processJob(job: Job): Promise<void> {
  if (job.name !== "adjudicate_case") {
    throw new Error(`no handler registered for job type ${job.name}`);
  }
  const caseId = job.data.caseId as string;
  const isAppeal = Boolean(job.data.isAppeal);
  await runAdjudicationJob(caseId, isAppeal);
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

  return worker;
}
