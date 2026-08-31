import { prisma } from "@/lib/prisma";

// Guards against a real incident: a worker process pointed at one
// database (e.g. a local test container's DATABASE_URL) consumed jobs
// from a Redis queue actually meant for another environment (production),
// because both happened to share the same queue name on the same Redis
// instance. Jobs it pulled referenced case IDs that don't exist in its
// own database, so it failed them — silently burning the job's retry
// budget in the wrong environment and leaving the right environment's
// worker with nothing to process.
//
// Every one of local/staging/production must set APP_ENV explicitly —
// there is no default, on purpose. A missing APP_ENV fails loudly at
// startup instead of falling back to some guess that's right until it
// silently isn't.
export type AppEnv = "development" | "staging" | "production";
const VALID_ENVS: readonly AppEnv[] = ["development", "staging", "production"];

let cachedEnv: AppEnv | null = null;

export function getAppEnv(): AppEnv {
  if (cachedEnv) return cachedEnv;
  const raw = process.env.APP_ENV;
  if (!raw || !VALID_ENVS.includes(raw as AppEnv)) {
    throw new Error(
      `APP_ENV must be set to one of ${VALID_ENVS.join("/")} — got ${JSON.stringify(raw)}. ` +
        `See apps/web/.env.example. This is required before the job queue or worker will start: ` +
        `it namespaces the BullMQ queue and is checked against the database this process is ` +
        `connected to, so a misconfigured process can't silently consume jobs meant for a ` +
        `different environment.`
    );
  }
  cachedEnv = raw as AppEnv;
  return cachedEnv;
}

/**
 * Reject startup if this process's APP_ENV doesn't match the database it's
 * actually connected to. Self-bootstraps on first run against a fresh
 * database (creates the single guard row for the environment this process
 * claims to be); any run after that requires an exact match or throws.
 * Call this once at worker startup (both the in-process worker started by
 * ensureJobWorker() and the standalone src/worker.ts entrypoint) — not on
 * every request, since it does a real DB round trip.
 */
export async function assertDatabaseMatchesAppEnv(): Promise<void> {
  const appEnv = getAppEnv();
  const existing = await prisma.deploymentEnvironment.findUnique({ where: { id: "singleton" } });
  if (!existing) {
    await prisma.deploymentEnvironment.create({ data: { id: "singleton", env: appEnv } });
    return;
  }
  if (existing.env !== appEnv) {
    throw new Error(
      `Environment mismatch: this process has APP_ENV=${appEnv}, but the database it's connected ` +
        `to (DATABASE_URL) is tagged env=${existing.env}. Refusing to start the job worker — ` +
        `running with a mismatched APP_ENV/DATABASE_URL pair is exactly what let a worker consume ` +
        `production Redis jobs while reading/writing a different database. If this database ` +
        `genuinely changed environment on purpose, update its DeploymentEnvironment row explicitly ` +
        `rather than editing APP_ENV to match it.`
    );
  }
}
