-- Job queueing moved to BullMQ on Redis (see src/lib/queue.ts) — nothing
-- in the app read this table directly except the poller it replaced.
DROP TABLE "Job";
