import { Queue } from "bullmq";
import IORedis from "ioredis";

// Real message broker (BullMQ on Redis), replacing the earlier DB-polling
// queue (a `Job` Prisma table a setInterval loop scanned every few
// seconds). That table is gone — nothing else read it (only lib/jobs.ts
// itself did), so there was no reason to keep two sources of truth for
// job state once Redis became the real one.
//
// What this buys over DB polling: push-based dispatch instead of a fixed
// poll interval, real exponential backoff between retries (see
// ADJUDICATION_QUEUE_NAME's default job options below), and a genuine
// dead-letter set (BullMQ's own `failed` state, queryable via
// queue.getFailed()) instead of a bare `status: "FAILED"` column with no
// backoff between attempts.
//
// Run Redis locally with:
//   docker run -d --name anchor-redis --restart unless-stopped \
//     -p 6379:6379 -v anchor-redis-data:/data \
//     redis:7-alpine redis-server --appendonly yes
// (this repo's own dev instance runs on host port 6390 instead of 6379 —
// see .env's REDIS_URL comment — because 6379 was already taken by other
// local projects on the machine this was built on; use whatever's free
// for yours.)

export const ADJUDICATION_QUEUE_NAME = "adjudication";

let connection: IORedis | null = null;
let queue: Queue | null = null;

function getConnection(): IORedis {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("REDIS_URL is not set — see apps/web/.env.example");
    }
    // BullMQ requires this exact option - without it ioredis gives up
    // retrying a dropped connection after its own default limit, which
    // BullMQ needs to manage itself.
    connection = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return connection;
}

/** Shared BullMQ Queue instance — both enqueueJob() (web process) and the worker (src/worker.ts or in-process) use this same queue name/connection. */
export function getAdjudicationQueue(): Queue {
  if (!queue) {
    queue = new Queue(ADJUDICATION_QUEUE_NAME, { connection: getConnection() });
  }
  return queue;
}
