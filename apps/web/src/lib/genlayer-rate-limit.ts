import IORedis from "ioredis";

// GenLayer enforces a real rate limit on the network this app talks to —
// 30 requests/minute, confirmed against real usage, not a guess from
// docs. Every real GenLayer network call (deploy/write/read) across the
// whole app must acquire a slot here first, whichever process makes it —
// the in-process web server or the standalone worker — since GenLayer
// counts raw calls against the account, not per-process. That's why this
// is Redis-backed (a fixed-window counter) rather than an in-memory
// counter like checkApiKeyRateLimit in lib/auth.ts: an in-memory counter
// would only see one process's calls and silently blow through the real
// limit the moment more than one process is running, which is exactly
// the deployment this app now runs under (Vercel web + a separate Fly
// worker).

const MAX_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

let redis: IORedis | null = null;

function getRedis(): IORedis {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("REDIS_URL is not set — see apps/web/.env.example");
    }
    redis = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return redis;
}

/**
 * Blocks until a GenLayer API call slot is available under the global
 * 30-req/min budget. Fixed-window counter keyed by the current minute —
 * simpler than a sliding log, and the boundary-burst tolerance it trades
 * away (technically up to ~2x the limit across a window edge) is fine
 * here since GenLayer calls in this app are inherently low-frequency
 * (one adjudication run makes a handful of calls over ~1-2 minutes of
 * real consensus time, not a tight loop).
 */
export async function acquireGenLayerSlot(): Promise<void> {
  const client = getRedis();
  for (;;) {
    const bucket = Math.floor(Date.now() / WINDOW_MS);
    const key = `genlayer_rl:${bucket}`;
    const count = await client.incr(key);
    if (count === 1) {
      await client.expire(key, Math.ceil(WINDOW_MS / 1000) + 5);
    }
    if (count <= MAX_PER_MINUTE) return;

    const msUntilNextWindow = WINDOW_MS - (Date.now() % WINDOW_MS);
    await new Promise((resolve) => setTimeout(resolve, msUntilNextWindow + Math.random() * 250));
  }
}
