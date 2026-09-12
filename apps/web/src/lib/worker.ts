import { Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { ADJUDICATION_QUEUE_NAME, getAdjudicationQueue } from "@/lib/queue";
import { runAdjudicationJob, finalizeExpiredAppealWindows, retryFailedSettlements, confirmPendingDeposits } from "@/lib/adjudication-service";
import { deliverWebhookAttempt } from "@/lib/webhooks";
import { anchorAuditChains } from "@/lib/audit-anchor";
import { runReconciliationSweep } from "@/lib/reconciliation";
import { runReliabilityObservation } from "@/lib/reliability-monitor";
import { checkReliabilityObserverHeartbeat } from "@/lib/reliability-observer-watchdog";
import { runTestnetCanary } from "../../scripts/testnet-canary";
import { getAppEnv, assertDatabaseMatchesAppEnv } from "@/lib/app-env";
import { getAttestorAccounts } from "@/lib/hyperlane";
import { assertWorkerKeyCountBelowThreshold, StartupCheckError } from "@/lib/startup-checks";
import { sendOpsAlert } from "@/lib/alerts";
import { Keypair } from "@solana/web3.js";

// The actual BullMQ job processor — separate from src/worker.ts (the
// standalone process entrypoint) because this module is also imported
// in-process by lib/jobs.ts's ensureJobWorker(). Both paths end up
// calling startAdjudicationWorker(); which one does depends on whether
// you're running `next start`/`next dev` (in-process) or `npm run worker`
// (standalone, src/worker.ts).

const FINALIZE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SETTLEMENT_RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const AUDIT_ANCHOR_SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes — an external checkpoint doesn't need to be real-time, just regular
const DEPOSIT_CONFIRMATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — same cadence as the finalize sweep; a deposit sitting unconfirmed doesn't need faster polling than that
const RECONCILIATION_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes — several real on-chain reads per tick, doesn't need finalize-sweep speed
// Re-audit response (Phase 1, item 3). Widened from 15 to 30 minutes
// (2026-09-06) to cut idle RPC/getLogs usage — still 48 observations/day,
// enough density for a 30-day observation window, without doubling the
// RPC provider load of a check that runs unconditionally on every tick.
const RELIABILITY_OBSERVATION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
// Genuine redundancy: this worker process is separate from
// anc-hor-reliability-observer, so it can notice when that process
// goes silent. 10 minutes gives at least 3-4 checks inside the
// watchdog's own 40-minute staleness window, so a real outage is
// caught within one or two check cycles of crossing the threshold,
// not one entire staleness window late.
const RELIABILITY_OBSERVER_HEARTBEAT_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
// Phase 1, item 4: the canary's own SLA clock defaults to 15 minutes (see
// scripts/testnet-canary.ts) and a run blocks a worker slot until it
// settles or breaches, so this interval must stay comfortably above that
// to avoid two runs overlapping under normal conditions.
const CANARY_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let worker: Worker | null = null;

/**
 * Phase 1, item 1: run once at worker startup, before a single job is
 * pulled off the queue. Deliberately tolerant of ATTESTOR_PRIVATE_KEYS /
 * SOLANA_ATTESTOR_PRIVATE_KEY being entirely unset — that's the normal,
 * unchanged shape of a web-only deployment (e.g. Vercel, or the
 * in-process worker started by lib/jobs.ts's ensureJobWorker on a
 * developer machine) that was never going to attempt a real dispatch in
 * the first place; dispatchSettlementForDecision already throws
 * downstream if it's actually called without these configured. This
 * check exists to fail closed on a MISCONFIGURED signer identity (the
 * keys ARE present but violate threshold/registration expectations),
 * not to require every worker-capable process to be a settlement
 * signer.
 */
function assertWorkerStartupInvariants(): void {
  let evmSignerAddresses: string[] = [];
  try {
    evmSignerAddresses = getAttestorAccounts().map((a) => a.address);
  } catch {
    // ATTESTOR_PRIVATE_KEYS/ATTESTOR_PRIVATE_KEY not set — see doc comment above.
  }
  let solanaSignerPublicKey: string | null = null;
  if (process.env.SOLANA_ATTESTOR_PRIVATE_KEY) {
    const secretKey = Uint8Array.from(JSON.parse(process.env.SOLANA_ATTESTOR_PRIVATE_KEY));
    solanaSignerPublicKey = Keypair.fromSecretKey(secretKey).publicKey.toBase58();
  }

  if (evmSignerAddresses.length === 0 && solanaSignerPublicKey === null) return;
  assertWorkerKeyCountBelowThreshold({ evmSignerAddresses, solanaSignerPublicKey });
}

async function processJob(job: Job): Promise<void> {
  assertJobEnvMatches(job);
  if (job.name === "finalize_expired_appeals") {
    const count = await finalizeExpiredAppealWindows();
    if (count > 0) {
      // eslint-disable-next-line no-console
      console.log(`worker: finalized ${count} case(s) with expired appeal windows`);
    }
    return;
  }
  if (job.name === "retry_failed_settlements") {
    const count = await retryFailedSettlements();
    if (count > 0) {
      // eslint-disable-next-line no-console
      console.log(`worker: retried settlement for ${count} decision(s)`);
    }
    return;
  }
  if (job.name === "confirm_pending_deposits") {
    const count = await confirmPendingDeposits();
    if (count > 0) {
      // eslint-disable-next-line no-console
      console.log(`worker: confirmed ${count} on-chain deposit(s)`);
    }
    return;
  }
  if (job.name === "run_reconciliation_sweep") {
    const { openFindings, escalated } = await runReconciliationSweep();
    // eslint-disable-next-line no-console
    console.log(`worker: reconciliation sweep complete, ${openFindings} open finding(s), ${escalated} escalation alert(s) sent`);
    return;
  }
  if (job.name === "run_reliability_observation") {
    const { passCount, warnCount, failCount, state } = await runReliabilityObservation();
    // eslint-disable-next-line no-console
    console.log(`worker: reliability observation complete, state=${state}, ${passCount} pass, ${warnCount} warn, ${failCount} fail`);
    return;
  }
  if (job.name === "check_reliability_observer_heartbeat") {
    const status = await checkReliabilityObserverHeartbeat();
    // eslint-disable-next-line no-console
    console.log(`worker: reliability-observer heartbeat check complete, stale=${status.stale}, lastObservationAt=${status.lastObservationAt ?? "none"}`);
    return;
  }
  if (job.name === "run_testnet_canary") {
    await runTestnetCanary();
    // eslint-disable-next-line no-console
    console.log("worker: testnet canary run complete");
    return;
  }
  if (job.name === "anchor_audit_chains") {
    const count = await anchorAuditChains();
    if (count > 0) {
      // eslint-disable-next-line no-console
      console.log(`worker: anchored ${count} organization audit chain(s) on-chain`);
    }
    return;
  }
  if (job.name === "deliver_webhook") {
    const { webhookId, payload } = job.data as { webhookId: string; payload: { event: string; createdAt: string; data: Record<string, unknown> } };
    await deliverWebhookAttempt(webhookId, payload);
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
 * Second, belt-and-suspenders environment guard (see lib/app-env.ts for
 * the primary one): every job enqueued by lib/jobs.ts's enqueueJob()
 * carries the enqueuing process's own APP_ENV in its payload. If a job
 * ever reaches a worker whose own APP_ENV doesn't match — which the
 * queue-name namespacing in lib/queue.ts should already make impossible,
 * since each environment has its own queue key — fail it loudly instead
 * of silently processing (or silently no-op'ing) a job that was never
 * meant for this process. Repeatable sweep jobs (finalize/retry) and
 * webhook deliveries don't carry `_env` since they're always enqueued by
 * this same process's own scheduler, never cross-environment by
 * construction; only reject when `_env` is present and wrong.
 */
function assertJobEnvMatches(job: Job): void {
  const jobEnv = (job.data as { _env?: string })._env;
  if (jobEnv && jobEnv !== getAppEnv()) {
    throw new Error(
      `job ${job.id} (${job.name}) was enqueued with _env=${jobEnv}, but this worker's ` +
        `APP_ENV=${getAppEnv()} — refusing to process a job from a different environment. ` +
        `This should be structurally impossible (see queue.ts's APP_ENV-namespaced queue name) ` +
        `unless two environments were misconfigured to share one queue name.`
    );
  }
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

/**
 * Registers the periodic settlement-retry sweep (see
 * adjudication-service.ts's retryFailedSettlements) — the durable
 * reconciliation loop for a FINALIZED decision whose relay dispatch
 * failed. Same upsert-is-idempotent reasoning as the finalize sweep.
 */
async function ensureSettlementRetryScheduled(): Promise<void> {
  await getAdjudicationQueue().upsertJobScheduler(
    "retry-failed-settlements-sweep",
    { every: SETTLEMENT_RETRY_INTERVAL_MS },
    { name: "retry_failed_settlements" }
  );
}

/**
 * Registers the periodic deposit-confirmation sweep (see
 * adjudication-service.ts's confirmPendingDeposits) — automatically
 * promotes a CaseSettlement from PENDING_DEPOSIT to DEPOSITED once
 * both parties have set their address AND the escrow contract's own
 * state shows a matching deposit, without needing an operator to
 * trigger the on-demand confirm-deposit endpoint. Same upsert-is-
 * idempotent reasoning as the other sweeps.
 */
async function ensureDepositConfirmationSweepScheduled(): Promise<void> {
  await getAdjudicationQueue().upsertJobScheduler(
    "confirm-pending-deposits-sweep",
    { every: DEPOSIT_CONFIRMATION_SWEEP_INTERVAL_MS },
    { name: "confirm_pending_deposits" }
  );
}

/**
 * Registers the periodic reconciliation sweep (see
 * lib/reconciliation.ts's runReconciliationSweep) — the real
 * decision -> attestation -> dispatch -> delivery -> processed ->
 * settled -> payout -> audit-anchored chain, checked against live
 * on-chain state, not just DB-internal consistency. Same
 * upsert-is-idempotent reasoning as the other sweeps.
 */
async function ensureReconciliationSweepScheduled(): Promise<void> {
  await getAdjudicationQueue().upsertJobScheduler(
    "reconciliation-sweep",
    { every: RECONCILIATION_SWEEP_INTERVAL_MS },
    { name: "run_reconciliation_sweep" }
  );
}

/**
 * Registers the periodic external audit-chain anchoring sweep (see
 * lib/audit-anchor.ts) — posts each organization's current audit-log
 * chain head to a small Sepolia contract, so history can't be silently
 * rewritten in the database alone. Same upsert-is-idempotent reasoning
 * as the other sweeps.
 */
async function ensureAuditAnchorSweepScheduled(): Promise<void> {
  await getAdjudicationQueue().upsertJobScheduler(
    "anchor-audit-chains-sweep",
    { every: AUDIT_ANCHOR_SWEEP_INTERVAL_MS },
    { name: "anchor_audit_chains" }
  );
}

/**
 * Registers the periodic reliability-observation sweep (see
 * lib/reliability-monitor.ts) — re-audit response, Phase 1 item 3.
 * Same upsert-is-idempotent reasoning as the other sweeps.
 */
async function ensureReliabilityObservationScheduled(): Promise<void> {
  await getAdjudicationQueue().upsertJobScheduler(
    "reliability-observation-sweep",
    { every: RELIABILITY_OBSERVATION_INTERVAL_MS },
    { name: "run_reliability_observation" }
  );
}

/**
 * Registers the periodic reliability-observer heartbeat check (see
 * lib/reliability-observer-watchdog.ts) — a different process (this
 * worker) noticing when anc-hor-reliability-observer itself has gone
 * silent, rather than the observer trying to watch itself. Same
 * upsert-is-idempotent reasoning as the other sweeps.
 */
async function ensureReliabilityObserverHeartbeatScheduled(): Promise<void> {
  await getAdjudicationQueue().upsertJobScheduler(
    "reliability-observer-heartbeat-check",
    { every: RELIABILITY_OBSERVER_HEARTBEAT_CHECK_INTERVAL_MS },
    { name: "check_reliability_observer_heartbeat" }
  );
}

/**
 * Registers the periodic testnet canary sweep (see
 * scripts/testnet-canary.ts's runTestnetCanary) — Phase 1, item 4. Only
 * registered when CANARY_ORGANIZATION_ID is configured: an environment
 * that hasn't set up canary monitoring (e.g. a developer machine, or a
 * deployment that intentionally hasn't enabled it yet) shouldn't have
 * this job scheduled at all, since runTestnetCanary() throws immediately
 * without it. Same upsert-is-idempotent reasoning as the other sweeps.
 */
async function ensureCanarySweepScheduled(): Promise<void> {
  if (!process.env.CANARY_ORGANIZATION_ID) return;
  await getAdjudicationQueue().upsertJobScheduler(
    "testnet-canary-sweep",
    { every: CANARY_SWEEP_INTERVAL_MS },
    { name: "run_testnet_canary" }
  );
}

/**
 * Idempotent — starts the BullMQ Worker once per process; safe to call
 * more than once. Created with autorun disabled so the environment guard
 * (assertDatabaseMatchesAppEnv — see lib/app-env.ts) can run and be
 * awaited BEFORE this process pulls a single job off the queue; a
 * mismatch throws here and the worker never starts running at all,
 * rather than possibly processing one job before the check catches up.
 */
export async function startAdjudicationWorker(): Promise<Worker> {
  if (worker) return worker;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is not set — see apps/web/.env.example");
  }
  const connection = new IORedis(url, { maxRetriesPerRequest: null });

  const w = new Worker(ADJUDICATION_QUEUE_NAME, processJob, { connection, concurrency: 5, autorun: false });

  w.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`worker: job ${job?.id} (${job?.name}) failed:`, err.message);
  });
  w.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error("worker: connection error:", err.message);
  });

  try {
    await assertDatabaseMatchesAppEnv();
    assertWorkerStartupInvariants();
  } catch (err) {
    await w.close();
    // Signer-unavailable / quorum-unavailable at boot: this process is
    // about to exit before signing anything, which is exactly the
    // moment nobody would otherwise hear about it — there's no
    // ReconciliationFinding row possible yet (no decision to key one to)
    // and the process crash itself carries no operator-visible reason.
    // Best-effort: a failed alert delivery must not mask the real
    // startup failure below.
    if (err instanceof StartupCheckError) {
      try {
        await sendOpsAlert({
          severity: "critical",
          title: "Worker refused to start: signer/quorum invariant violated",
          detail: `${err.message}\nSee docs/runbooks/signer-failure.md.`,
        });
      } catch (alertErr) {
        console.error("worker: failed to deliver startup-check-failure alert", alertErr);
      }
    }
    throw err;
  }

  worker = w;
  // Not awaited: with autorun disabled, run() doesn't resolve until the
  // worker is later closed (it's the processing-loop promise, not a
  // "started" signal) — calling it without awaiting kicks off processing
  // and lets startAdjudicationWorker() return immediately, same as it did
  // before autorun was disabled for the guard above.
  w.run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker: processing loop exited with error:", err instanceof Error ? err.message : err);
  });

  ensureFinalizeSweepScheduled().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker: failed to schedule finalize sweep:", err instanceof Error ? err.message : err);
  });
  ensureSettlementRetryScheduled().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker: failed to schedule settlement retry sweep:", err instanceof Error ? err.message : err);
  });
  ensureAuditAnchorSweepScheduled().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker: failed to schedule audit anchor sweep:", err instanceof Error ? err.message : err);
  });
  ensureDepositConfirmationSweepScheduled().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker: failed to schedule deposit confirmation sweep:", err instanceof Error ? err.message : err);
  });
  ensureReconciliationSweepScheduled().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker: failed to schedule reconciliation sweep:", err instanceof Error ? err.message : err);
  });
  ensureReliabilityObservationScheduled().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker: failed to schedule reliability observation sweep:", err instanceof Error ? err.message : err);
  });
  ensureReliabilityObserverHeartbeatScheduled().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker: failed to schedule reliability-observer heartbeat check:", err instanceof Error ? err.message : err);
  });
  ensureCanarySweepScheduled().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("worker: failed to schedule testnet canary sweep:", err instanceof Error ? err.message : err);
  });

  return w;
}
