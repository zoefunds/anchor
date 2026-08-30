import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runAdjudicationJob } from "@/lib/adjudication-service";

// DB-backed queue: replaces the earlier bare `void runAdjudicationJob(id)`
// fire-and-forget call. A Job row is durable — if this process is killed
// mid-run, the row is still there at RUNNING for the sweep below to
// requeue, instead of the case being silently stuck in ADJUDICATING
// forever with no record anything was ever supposed to happen.
//
// This is still one in-process poller, not a separate worker fleet or a
// real broker (BullMQ/SQS/etc) - see the Job model's schema comment for
// the honest scope of what durability this buys vs. what horizontal
// scaling would still need.

const POLL_INTERVAL_MS = 3000;
const MAX_ATTEMPTS = 3;
const STUCK_RUNNING_MS = 5 * 60 * 1000; // a RUNNING row older than this is presumed crashed, not slow

type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

const HANDLERS: Record<string, JobHandler> = {
  adjudicate_case: async (payload) => {
    const caseId = payload.caseId as string;
    const isAppeal = Boolean(payload.isAppeal);
    await runAdjudicationJob(caseId, isAppeal);
  },
};

export async function enqueueJob(type: string, payload: Record<string, unknown>): Promise<string> {
  const job = await prisma.job.create({
    data: { type, payload: payload as Prisma.InputJsonValue, status: "PENDING" },
  });
  return job.id;
}

async function claimNextJob() {
  // Also reclaims rows stuck at RUNNING past the crash-presumption
  // window, so a process restart doesn't orphan them forever.
  const candidate = await prisma.job.findFirst({
    where: {
      OR: [
        { status: "PENDING" },
        { status: "RUNNING", updatedAt: { lt: new Date(Date.now() - STUCK_RUNNING_MS) } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  // Optimistic claim: only succeeds if the row is still in the state we
  // read it in, so two pollers (or a poller racing a stuck-row reclaim)
  // can't both pick up the same job.
  const claimed = await prisma.job.updateMany({
    where: { id: candidate.id, status: candidate.status },
    data: { status: "RUNNING", attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;

  return prisma.job.findUnique({ where: { id: candidate.id } });
}

async function runOnce(): Promise<void> {
  const job = await claimNextJob();
  if (!job) return;

  const handler = HANDLERS[job.type];
  if (!handler) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "FAILED", lastError: `no handler registered for job type ${job.type}` },
    });
    return;
  }

  try {
    await handler(job.payload as Record<string, unknown>);
    await prisma.job.update({ where: { id: job.id }, data: { status: "DONE" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failedPermanently = job.attempts >= MAX_ATTEMPTS;
    await prisma.job.update({
      where: { id: job.id },
      data: { status: failedPermanently ? "FAILED" : "PENDING", lastError: message },
    });
  }
}

let pollerStarted = false;

/** Idempotent - call on every request that needs the queue running; only actually starts the interval once per process. */
export function ensureJobPoller(): void {
  if (pollerStarted) return;
  pollerStarted = true;
  setInterval(() => {
    runOnce().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("job poller tick failed:", err instanceof Error ? err.message : err);
    });
  }, POLL_INTERVAL_MS);
}
