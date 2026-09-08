import type { Prisma, SignerLifecycleState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withDbRetry } from "@/lib/db-retry";
import { sendOpsAlert } from "@/lib/alerts";
import { tryAlert } from "@/lib/reconciliation";

// Phase 1 (signer/settlement/delivery reliability): the durable,
// queryable lifecycle trail for one decision's automated settlement
// path. See prisma/schema.prisma's SignerLifecycleEvent for why this
// exists as its own append-only table rather than being inferred after
// the fact from Decision.relayError/relayTxHash alone — a stuck 1-of-3
// vs. 2-of-3 quorum state looks identical from those two fields.

export type SettlementChainLabel = "sepolia" | "solanatestnet";

/**
 * Records one lifecycle transition. Never throws into the caller's own
 * dispatch/sign flow — a lost lifecycle-log write must not fail (or
 * retry-loop) the real settlement action it's merely recording, so
 * failures here are logged and swallowed, same posture as
 * dispatchWebhookEvent's fire-and-forget delivery elsewhere in this
 * codebase. Uses withDbRetry so a transient DB blip doesn't need that
 * fallback in the common case.
 */
export async function recordSignerLifecycleEvent(params: {
  decisionId: string;
  chain: SettlementChainLabel;
  state: SignerLifecycleState;
  signerAddress?: string | null;
  reason?: string | null;
}): Promise<void> {
  try {
    await withDbRetry(() =>
      prisma.signerLifecycleEvent.create({
        data: {
          decisionId: params.decisionId,
          chain: params.chain,
          state: params.state,
          signerAddress: params.signerAddress ?? null,
          reason: params.reason ?? null,
        },
      })
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`recordSignerLifecycleEvent: failed to persist ${params.state} for decision ${params.decisionId}`, err);
  }
}

/**
 * A decision whose relayAttempts hit MAX_RELAY_ATTEMPTS without ever
 * reaching relayTxHash is not retried again by retryFailedSettlements
 * (see adjudication-service.ts's query, which filters on
 * relayAttempts < MAX_RELAY_ATTEMPTS) — before this existed that state
 * was silent: a human would only discover it by noticing a FINALIZED
 * case that never got a relayTxHash. Idempotent via ReconciliationFinding's
 * (type, targetId) uniqueness — same open/resolve/re-alert discipline as
 * lib/reconciliation.ts's raiseFinding, reimplemented here rather than
 * reused because raiseFinding's `type` parameter is a private union
 * that deliberately doesn't include these two new finding types.
 */
export async function escalateRelayRetriesExhausted(decisionId: string, chain: SettlementChainLabel, reason: string): Promise<void> {
  await recordSignerLifecycleEvent({ decisionId, chain, state: "ESCALATED", reason });

  const existing = await prisma.reconciliationFinding.findUnique({
    where: { type_targetId: { type: "RELAY_RETRIES_EXHAUSTED", targetId: decisionId } },
  });
  if (existing && !existing.resolvedAt) {
    if (!existing.alertedAt) {
      await tryAlert(existing.id, {
        severity: "critical",
        title: "Decision settlement retries exhausted",
        detail: `Decision ${decisionId} (${chain}) hit MAX_RELAY_ATTEMPTS without settling. Last error: ${reason}`,
      });
    }
    return;
  }

  const detail: Prisma.InputJsonValue = { decisionId, chain, reason };
  const finding = existing
    ? await prisma.reconciliationFinding.update({ where: { id: existing.id }, data: { resolvedAt: null, detail, openedAt: new Date(), alertedAt: null } })
    : await prisma.reconciliationFinding.create({ data: { type: "RELAY_RETRIES_EXHAUSTED", targetType: "Decision", targetId: decisionId, detail } });

  await tryAlert(finding.id, {
    severity: "critical",
    title: "Decision settlement retries exhausted",
    detail: `Decision ${decisionId} (${chain}) hit MAX_RELAY_ATTEMPTS without settling. Last error: ${reason}`,
  });
}

/**
 * The canary's own SLA-breach escalation — same shape as
 * escalateRelayRetriesExhausted but keyed by the canary run's own
 * decisionId (a fresh synthetic one per run, so this never collides
 * with a real settlement's finding) and always alerted immediately
 * (a canary breach is itself the alert-worthy event, not a recurring
 * condition to dedupe against).
 */
export async function escalateCanarySlaBreach(canaryRunId: string, detail: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.error(`ALERT [CANARY_SLA_BREACH]: ${canaryRunId}: ${detail}`);
  const finding = await prisma.reconciliationFinding.create({
    data: { type: "CANARY_SLA_BREACH", targetType: "CanaryRun", targetId: canaryRunId, detail: { detail } as Prisma.InputJsonValue },
  });
  try {
    await sendOpsAlert({ severity: "critical", title: "Testnet settlement canary breached its SLA", detail: `${canaryRunId}: ${detail}` });
    await prisma.reconciliationFinding.update({ where: { id: finding.id }, data: { alertedAt: new Date() } });
  } catch (err) {
    console.error(`escalateCanarySlaBreach: failed to deliver alert for ${canaryRunId}`, err);
  }
}
