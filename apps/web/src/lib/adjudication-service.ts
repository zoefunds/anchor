import { createHash } from "crypto";
import type { Case, Decision } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdjudicatorContractCode, getGenLayerClient, toAttoAmount } from "@/lib/genlayer";
import { toAtomicAmount } from "@/lib/money";
import { getPolicy } from "@/lib/policies";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { dispatchDecisionForCase, DecisionAlreadySettledError, InsufficientAttestorSignaturesError } from "@/lib/hyperlane";
import { InsufficientSolanaAttestationsError, type SolanaAttestationRecord } from "@/lib/solana-settle";
import type { Hex } from "viem";
import { redactPii, REDACTED_EVIDENCE_TYPES } from "@/lib/pii-redaction";
import { resolveEvidenceUri } from "@/lib/storage";
import { recordSignerLifecycleEvent, escalateRelayRetriesExhausted, type SettlementChainLabel } from "@/lib/signer-lifecycle";
import { parseVelocityLimits, parseHumanReviewTriggers } from "@/lib/policy-engine";
import { recheckRiskAssessmentForSettlement, RiskGateBlockedError } from "@/lib/risk-engine";
import { maybeEscalateCase, assertNoPendingReviewBlocksSettlement, EscalationError, escalateForSettlementFailure } from "@/lib/escalation";

function settlementChainLabel(chain: string): SettlementChainLabel {
  return chain === "sepolia" ? "sepolia" : "solanatestnet";
}

// Real incident, 2026-09-07 (Studio Next migration E2E test): a genuine
// GenLayer decision was computed (real fee spent, real consensus reached)
// but LOST because the immediately-following prisma.decision.create()
// hit a transient "Can't reach database server" — a brief network blip
// to the DB host, not a connection-pool-exhaustion issue (max_connections
// was 300, only ~14 in use at the time). Worse: the catch block's own
// recovery write (marking the case UNDETERMINED) ALSO failed the same
// way, leaving the case permanently stuck in ADJUDICATING with no
// automatic path forward — BullMQ's 3 retries all landed inside the same
// ~20s outage window. withDbRetry (lib/db-retry.ts) retries only the
// narrow set of Prisma "can't reach the database right now" error codes,
// never a real application error. Re-exported here so every existing
// importer of adjudication-service.ts's withDbRetry keeps working
// unchanged — moved to its own module purely to break a circular import
// with lib/signer-lifecycle.ts (which this file also imports).
import { withDbRetry } from "@/lib/db-retry";
import { recordBillableEvent, BillableEventType } from "@/lib/billing-events";
export { withDbRetry };

const APPEAL_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
// GenVM fetches evidence URLs itself, independent of this backend, and
// an appeal can trigger a fresh adjudication run — and therefore a
// fresh fetch of the same evidence — as late as the appeal window's own
// deadline (APPEAL_WINDOW_MS, 48h). Sized to that plus a buffer for
// consensus/retry latency (a second adjudication round can itself take
// a couple of minutes, and finalize/appeal sweeps only run every 5
// minutes), not to some unrelated round number — a signed URL that
// outlives the window it's actually needed for is pure unnecessary
// exposure if it leaks (an evidence upload can contain real PII). Was
// previously 30 days, ~10x longer than anything the appeal lifecycle
// actually requires.
const GENLAYER_EVIDENCE_URL_TTL_SECONDS = APPEAL_WINDOW_MS / 1000 + 24 * 60 * 60; // appeal window + 24h buffer
const MAX_RELAY_ATTEMPTS = 10;
// How long a relayClaimedAt lease is honored before it's treated as an
// abandoned attempt (crashed process, killed worker) rather than one
// still in flight — long enough that a normal RPC round-trip to Sepolia
// never trips it, short enough that a real crash doesn't stall
// settlement for hours.
const RELAY_CLAIM_TTL_MS = 5 * 60 * 1000;
// Sentinel relayError values for a dispatch blocked by an operator-imposed
// gate (pause / settlement limit) rather than a real dispatch failure —
// see dispatchSettlementForDecision's pause/limit branches and
// retryFailedSettlements, which both rely on these being stable strings
// so a blocked decision is neither silently stranded nor mistaken for a
// row worth alerting on as "relay keeps genuinely failing."
export const SETTLEMENT_BLOCKED_PAUSED = "SETTLEMENT_PAUSED";
export const SETTLEMENT_BLOCKED_LIMIT_EXCEEDED = "LIMIT_EXCEEDED";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Emergency pause for new settlement dispatches. Deliberately a single
 * env var, not a DB flag — flipping it must not depend on the same
 * database a broader incident might also be affecting, and it must take
 * effect on next deploy/restart without a migration. Only gates dispatch
 * itself: evidence access, appeals, and decision read paths are entirely
 * unaffected by this flag, by construction (nothing else checks it).
 */
export function isSettlementPaused(): boolean {
  return process.env.SETTLEMENT_PAUSED === "true";
}

/**
 * Per-chain settlement amount ceiling, in atto units (same unit as
 * Case.amount after toAttoAmount). MVP shape: env-var configuration, not
 * the tenant/policy-scoped DB table the fintech controls roadmap
 * describes as the eventual design (docs/fintech-controls-roadmap.md,
 * "Operational controls") — this is the first real step, not the
 * finished version. `chain` is matched case-insensitively against the
 * suffix of `SETTLEMENT_LIMIT_ATTO_<CHAIN>` (e.g. "sepolia" ->
 * SETTLEMENT_LIMIT_ATTO_SEPOLIA); falls back to
 * SETTLEMENT_LIMIT_ATTO_DEFAULT when no chain-specific var is set.
 * Returns null (no limit enforced) only when neither is set — an
 * explicit opt-out, not a silent default, so a misconfigured env doesn't
 * quietly disable the control.
 */
export function getSettlementLimitAtto(chain: string): bigint | null {
  const chainKey = chain.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const raw = process.env[`SETTLEMENT_LIMIT_ATTO_${chainKey}`] ?? process.env.SETTLEMENT_LIMIT_ATTO_DEFAULT;
  if (!raw) return null;
  try {
    const limit = BigInt(raw);
    // A configured-but-negative limit is a misconfiguration, not "no
    // limit" — fail closed (0n blocks everything) rather than silently
    // falling back to unlimited, since an operator who set this var at
    // all clearly intended some ceiling to apply.
    return limit >= 0n ? limit : 0n;
  } catch {
    // eslint-disable-next-line no-console
    console.error(`invalid settlement limit env value for chain ${chain}: "${raw}" — failing closed (blocking settlement on this chain) rather than silently treating it as unlimited`);
    return 0n;
  }
}

/** sha256 of the exact contract source deployed for this decision — see Decision.contractCodeHash's schema comment. */
function computeContractCodeHash(): string {
  return sha256Hex(getAdjudicatorContractCode());
}

/** sha256 of the canonical (sorted) evidenceUsed array — see Decision.evidenceManifestHash's schema comment. */
function computeEvidenceManifestHash(evidenceUsed: string[]): string {
  return sha256Hex(JSON.stringify([...evidenceUsed].sort()));
}

/**
 * sha256 of this decision's own canonical content — see
 * Decision.decisionHash's schema comment. Exported (not just used
 * internally) so the public decision-verification endpoint can
 * recompute it from the same preimage fields it publishes, proving to
 * an external, non-trusting verifier that decisionHash wasn't just
 * asserted — anyone can redo this exact computation themselves. See
 * api/public/decisions/:id/verify.
 */
export function computeDecisionHash(params: {
  caseId: string;
  policyId: string;
  policyVersion: string;
  outcome: string;
  claimantShareBps: number | null | undefined;
  respondentShareBps: number | null | undefined;
  reasonCodes: string[];
  proofHash: string | null;
  contractCodeHash: string;
}): string {
  return sha256Hex(
    JSON.stringify({
      caseId: params.caseId,
      policyId: params.policyId,
      policyVersion: params.policyVersion,
      outcome: params.outcome,
      claimantShareBps: params.claimantShareBps ?? null,
      respondentShareBps: params.respondentShareBps ?? null,
      reasonCodes: [...params.reasonCodes].sort(),
      proofHash: params.proofHash,
      contractCodeHash: params.contractCodeHash,
    })
  );
}

/** Required evidence types for a case's policy — used by the adjudicate route's readiness check. */
export function requiredEvidenceTypesFor(policyId: string): string[] {
  const policy = getPolicy(policyId);
  return policy ? policy.requiredEvidence.map((e) => e.type) : [];
}

/**
 * Dispatches settlement for a FINALIZED decision with a settlement target
 * configured. Split out from runAdjudicationJob so both that function
 * (the appeal-decided path, where FINALIZED happens immediately - see
 * MAX_APPEALS note below) and finalizeExpiredAppealWindows (the
 * non-appealed path) can call the exact same dispatch logic rather than
 * duplicating it.
 *
 * Only ever call this once a case is genuinely FINALIZED - never from
 * APPEAL_WINDOW. A decision that can still be appealed can still change,
 * so settling against it would let an appeal contest a verdict after
 * funds were already released against the earlier one.
 *
 * `rehearsalToken` (2026-09-13 remediation plan, item 3) is the ONLY way
 * the SETTLEMENT_PAUSED check below can ever be bypassed — and even
 * then, only for the ONE decision whose own testRehearsalAuthToken
 * matches, never globally. Every real caller in this codebase
 * (retryFailedSettlements, finalizeExpiredAppealWindows,
 * runAdjudicationJob) calls this function with no third argument, so
 * the pause continues to apply to every real case exactly as before —
 * this parameter exists solely for
 * scripts/rehearse-controlled-settlement.ts, a manual, human-operated,
 * single-case, single-use CLI tool, never reachable from any HTTP route
 * or automated sweep.
 */
export async function dispatchSettlementForDecision(kase: Case, decision: Decision, rehearsalToken?: string): Promise<void> {
  if (!kase.settlementChain || !kase.settlementContract) return;
  if (decision.consensus !== "ACCEPTED") return;
  if (decision.relayTxHash) return; // already settled — retryFailedSettlements can call this again, must not double-dispatch
  if (decision.relayAttempts >= MAX_RELAY_ATTEMPTS) return; // see retryFailedSettlements' schema comment
  const rehearsalAuthorized =
    !!rehearsalToken &&
    !!decision.testRehearsalAuthToken &&
    decision.testRehearsalAuthToken === rehearsalToken &&
    !decision.testRehearsalConsumedAt;
  if (isSettlementPaused() && !rehearsalAuthorized) {
    // Durably record the block as a relayError (WITHOUT incrementing
    // relayAttempts) so retryFailedSettlements' periodic sweep — which
    // only looks at relayError-set/relayTxHash-null rows — picks this
    // decision back up automatically once SETTLEMENT_PAUSED is cleared,
    // instead of the decision silently never being retried. A prior
    // version of this gate returned here with no durable state at all,
    // which stranded any decision finalized while paused forever, since
    // nothing about "the pause got lifted" would ever re-trigger
    // dispatch for it. Not counted as a real attempt because the block
    // is operator-imposed, not a failure of this dispatch attempt.
    if (decision.relayError !== SETTLEMENT_BLOCKED_PAUSED) {
      await withDbRetry(() => prisma.decision.update({ where: { id: decision.id }, data: { relayError: SETTLEMENT_BLOCKED_PAUSED } }));
    }
    // eslint-disable-next-line no-console
    console.error(`settlement dispatch paused (SETTLEMENT_PAUSED) — refusing to dispatch decision ${decision.id} for case ${kase.id}`);
    return;
  }
  const settlementLimitAtto = getSettlementLimitAtto(kase.settlementChain);
  if (settlementLimitAtto !== null && toAttoAmount(kase.amount.toString()) > settlementLimitAtto) {
    // Same durable-block reasoning as the pause branch above — raising
    // the configured limit later must be able to un-strand this decision
    // via the same retry sweep, not require someone to notice and
    // manually re-trigger dispatch.
    if (decision.relayError !== SETTLEMENT_BLOCKED_LIMIT_EXCEEDED) {
      await withDbRetry(() => prisma.decision.update({ where: { id: decision.id }, data: { relayError: SETTLEMENT_BLOCKED_LIMIT_EXCEEDED } }));
    }
    // eslint-disable-next-line no-console
    console.error(`case ${kase.id} amount exceeds configured settlement limit for chain ${kase.settlementChain} — refusing to dispatch decision ${decision.id}`);
    return;
  }
  if (!decision.proofHash || !decision.decisionHash) {
    // Every real ACCEPTED decision has both (set when the Decision row
    // was created - see runAdjudicationJob). Missing either means
    // something upstream regressed; refuse to relay with no real proof
    // rather than silently fabricating one.
    // eslint-disable-next-line no-console
    console.error(`decision ${decision.id} for case ${kase.id} has no proofHash/decisionHash — refusing to dispatch settlement`);
    return;
  }

  // Phase 4, items 2 & 3 — risk-velocity recheck and human-review gate,
  // both fail-closed in the same style as checkAutoSignEligibility's
  // amount cap: a thrown error here durably records relayError (via the
  // catch block below) and leaves relayTxHash null, so
  // retryFailedSettlements' periodic sweep picks the decision back up
  // once a human resolves the review or the velocity condition clears,
  // rather than either silently blocking forever or silently settling
  // through an unresolved risk/review state.
  try {
    const policyVersion = kase.policyVersionRecordId
      ? await prisma.policyVersion.findUnique({ where: { id: kase.policyVersionRecordId } })
      : null;
    const velocityLimits = parseVelocityLimits(policyVersion?.velocityLimits ?? null);
    const humanReviewTriggers = parseHumanReviewTriggers(policyVersion?.humanReviewTriggers ?? null);
    await recheckRiskAssessmentForSettlement(kase.id, velocityLimits);
    const currentRisk = await prisma.riskAssessment.findUnique({ where: { caseId: kase.id } });
    await maybeEscalateCase({
      caseId: kase.id,
      amountUsd: Number(kase.amount),
      riskAction: currentRisk?.recheckAction ?? currentRisk?.action ?? "ALLOW",
      humanReviewTriggers,
    });
    await assertNoPendingReviewBlocksSettlement(kase.id);
  } catch (gateErr) {
    if (gateErr instanceof RiskGateBlockedError || gateErr instanceof EscalationError) {
      const message = gateErr.message;
      // eslint-disable-next-line no-console
      console.error(`settlement dispatch blocked by Phase 4 gate for decision ${decision.id} (case ${kase.id}): ${message}`);
      await withDbRetry(() => prisma.decision.update({ where: { id: decision.id }, data: { relayError: message } }));
      return;
    }
    throw gateErr;
  }

  // Real bug found 2026-09-13 (see hyperlane.ts's DispatchDecisionParams.directSettleDeadline
  // doc comment): the deadline signed into attestedSettle()'s digest
  // must stay STABLE across retries of the same decision, or signatures
  // collected against one retry's hash can never combine with another's.
  // Computed here (pure, no DB write of its own — folded into the claim
  // update just below) and reused until it actually expires. Sepolia-only
  // — Solana's attested_settle has no deadline field, so this is simply
  // unused (and harmless) for that branch.
  const DIRECT_SETTLE_DEADLINE_SECONDS = 30 * 60;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  let directSettleDeadline = decision.directSettleDeadline ? BigInt(decision.directSettleDeadline) : null;
  const needsFreshDeadline = kase.settlementChain === "sepolia" && (!directSettleDeadline || directSettleDeadline <= nowSeconds);
  if (needsFreshDeadline) {
    directSettleDeadline = nowSeconds + BigInt(DIRECT_SETTLE_DEADLINE_SECONDS);
  }

  // Atomic claim/lease (see Decision.relayClaimedAt's schema comment) —
  // only proceeds if no other worker holds an unexpired claim on this
  // decision, so a concurrent retry sweep firing at the same moment as
  // this call can't both pass the checks above and both dispatch. The
  // freshly-chosen deadline (if any) is persisted in this SAME write,
  // not a separate one, so this remains the only DB write between the
  // gate checks above and the real dispatch attempt below.
  const claimCutoff = new Date(Date.now() - RELAY_CLAIM_TTL_MS);
  const claimed = await withDbRetry(() =>
    prisma.decision.updateMany({
      where: {
        id: decision.id,
        relayTxHash: null,
        OR: [{ relayClaimedAt: null }, { relayClaimedAt: { lt: claimCutoff } }],
      },
      data: { relayClaimedAt: new Date(), ...(needsFreshDeadline ? { directSettleDeadline: directSettleDeadline!.toString() } : {}) },
    })
  );
  if (claimed.count === 0) {
    // eslint-disable-next-line no-console
    console.error(`decision ${decision.id} for case ${kase.id} already has an in-flight relay claim — skipping`);
    return;
  }

  // Reads the bound integration's own assetDecimals rather than
  // hardcoding 18, so this isn't re-hardcoded to "assume ETH" the
  // moment a different-decimals asset is ever bound again. The Solana
  // branch of dispatchDecisionForCase ignores
  // claimantAmountAtto/respondentAmountAtto entirely (it dispatches by
  // claimantShareBps against the escrow's own on-chain balance, see
  // solana-settle.ts's submitAttestedSettle), so this only matters for
  // the sepolia branch — but that branch REQUIRES a bound
  // CaseSettlement already (throws otherwise, see hyperlane.ts's
  // dispatchDecisionForCase), so this lookup is never wasted work when
  // it actually matters, and defaults to 18 decimals for the case
  // where no integration is bound yet (Solana, or a case that hasn't
  // reached deposit binding).
  const boundIntegration = await prisma.caseSettlement.findUnique({
    where: { caseId: kase.id },
    select: { integration: { select: { assetDecimals: true } } },
  });
  const settlementAssetDecimals = boundIntegration?.integration.assetDecimals ?? 18;
  const totalAmountAtto = toAtomicAmount(kase.amount.toString(), settlementAssetDecimals);
  const claimantBps = BigInt(decision.claimantShareBps ?? 0);
  const respondentBps = BigInt(decision.respondentShareBps ?? 0);

  try {
    const { txHash, messageId, notificationTxHash } = await dispatchDecisionForCase({
      caseId: kase.id,
      outcome: decision.outcome,
      claimantShareBps: decision.claimantShareBps ?? 0,
      respondentShareBps: decision.respondentShareBps ?? 0,
      claimantAmountAtto: (totalAmountAtto * claimantBps) / 10000n,
      respondentAmountAtto: (totalAmountAtto * respondentBps) / 10000n,
      settlementChain: kase.settlementChain,
      settlementContract: kase.settlementContract,
      settlementSolanaClaimant: kase.settlementSolanaClaimant,
      settlementSolanaRespondent: kase.settlementSolanaRespondent,
      settlementSolanaEscrowProgram: kase.settlementSolanaEscrowProgram,
      settlementSolanaCaseId: kase.settlementSolanaCaseId,
      evidenceHash: decision.proofHash,
      decisionHash: decision.decisionHash,
      directSettleDeadline: directSettleDeadline ?? undefined,
      externalAttestationSignatures: decision.pendingAttestationSignatures as Hex[],
      externalSolanaAttestations: (decision.pendingSolanaAttestations as SolanaAttestationRecord[] | null ?? []).map((a) => ({
        publicKey: new Uint8Array(Buffer.from(a.publicKey, "base64")),
        signature: new Uint8Array(Buffer.from(a.signature, "base64")),
      })),
    });
    // Retried, not just wrapped like the other writes below: the real
    // on-chain dispatch above has ALREADY happened by this point — a
    // lost write here (confirmed live, 2026-09-07) risks re-dispatching
    // a settlement that already succeeded on-chain. DecisionAlreadySettledError
    // reconciliation is the last-resort backstop for that; this retry is
    // what should prevent ever needing it in the first place.
    await withDbRetry(() =>
      prisma.decision.update({
        where: { id: decision.id },
        data: {
          relayTxHash: txHash,
          relayMessageId: messageId,
          relayNotificationTxHash: notificationTxHash ?? null,
          relayError: null,
          relayAttempts: { increment: 1 },
          pendingAttestationHash: null,
          pendingAttestationSignatures: [],
          pendingSolanaAttestationMessage: null,
          pendingSolanaAttestations: [],
          directSettleDeadline: null,
          // Consumed HERE, not at the top of this function: gathering
          // attestor signatures can legitimately take several retries of
          // this same one authorized action (InsufficientAttestorSignaturesError,
          // waiting on the real attestor service) — those don't count as
          // "using" the rehearsal authorization. Only a dispatch that
          // actually reaches a real transaction hash consumes it,
          // matching the "re-arms after one use" requirement exactly:
          // one real settlement per authorization, however many retries
          // it took to get there.
          ...(rehearsalAuthorized ? { testRehearsalConsumedAt: new Date() } : {}),
        },
      })
    );
    dispatchWebhookEvent({
      organizationId: kase.organizationId,
      event: "case.relay_dispatched",
      data: { caseId: kase.id, txHash, messageId },
    });
    await recordSignerLifecycleEvent({
      decisionId: decision.id,
      chain: settlementChainLabel(kase.settlementChain),
      state: notificationTxHash ? "DELIVERED" : "DISPATCHED",
      reason: txHash,
    });
    await recordSignerLifecycleEvent({
      decisionId: decision.id,
      chain: settlementChainLabel(kase.settlementChain),
      state: "SETTLED",
      reason: txHash,
    });
    await recordBillableEvent({
      organizationId: kase.organizationId,
      eventType: BillableEventType.SETTLEMENT_COMPLETED,
      subjectId: decision.id,
      metadata: { caseId: kase.id, chain: kase.settlementChain, txHash },
    });
  } catch (relayErr) {
    const relayMessage = relayErr instanceof Error ? relayErr.message : String(relayErr);
    if (kase.settlementChain === "solanatestnet" && relayMessage.includes("already Settled on-chain")) {
      console.error(`decision ${decision.id} for case ${kase.id} already settled on Solana — reconciled, not re-sent`);
      await withDbRetry(() =>
        prisma.$transaction(async (tx) => {
          await tx.decision.update({
            where: { id: decision.id },
            data: { relayTxHash: "reconciled:onchain", relayError: null, relayAttempts: { increment: 1 }, relayClaimedAt: null },
          });
          await tx.caseSettlement.updateMany({
            where: { caseId: kase.id, status: { not: "SETTLED" } },
            data: { status: "SETTLED", settledTxHash: "reconciled:onchain", settledAt: new Date() },
          });
        })
      );
      await recordBillableEvent({
        organizationId: kase.organizationId,
        eventType: BillableEventType.SETTLEMENT_COMPLETED,
        subjectId: decision.id,
        metadata: { caseId: kase.id, chain: kase.settlementChain, txHash: "reconciled:onchain" },
      });
      return;
    }
    if (relayErr instanceof DecisionAlreadySettledError) {
      // Reconciliation caught what a lost local record would otherwise
      // have retried forever: the destination contract already has this
      // exact decisionHash marked processed, so a prior dispatch's
      // transaction genuinely landed even though relayTxHash never got
      // written here (crash, dropped connection, etc. between the send
      // and the DB update). There's no local txHash to show for it —
      // "reconciled:onchain" records that this was detected via
      // destination-chain state, not a transaction this process itself
      // observed succeeding — but relayTxHash being non-null is what
      // stops every future dispatch attempt (see the guard at the top
      // of this function and the atomic claim above), which is what
      // actually matters here.
      // eslint-disable-next-line no-console
      console.error(`decision ${decision.id} for case ${kase.id} already settled on-chain — reconciled, not re-sent`);
      await withDbRetry(() =>
        prisma.decision.update({
          where: { id: decision.id },
          data: { relayTxHash: "reconciled:onchain", relayError: null, relayAttempts: { increment: 1 } },
        })
      );
      await recordBillableEvent({
        organizationId: kase.organizationId,
        eventType: BillableEventType.SETTLEMENT_COMPLETED,
        subjectId: decision.id,
        metadata: { caseId: kase.id, chain: kase.settlementChain, txHash: "reconciled:onchain" },
      });
      return;
    }
    if (relayErr instanceof InsufficientAttestorSignaturesError) {
      // Not a real failure — expected once real attestor-key custody is
      // split across independent holders (see
      // docs/multisig-attestor-setup.md): the backend's own keys alone
      // don't reach attestorThreshold, so this decision waits for a
      // signature submitted via POST
      // /api/internal/pending-attestations/[decisionId]/sign. Deliberately
      // does NOT increment relayAttempts — a human collecting a
      // signature can take much longer than MAX_RELAY_ATTEMPTS' ~100
      // minute budget for genuine transient failures, and this isn't one.
      // eslint-disable-next-line no-console
      console.log(
        `decision ${decision.id} for case ${kase.id} awaiting external attestor signature(s): ` +
          `${relayErr.collectedCount}/${relayErr.threshold} collected (hash ${relayErr.attestationHash})`
      );
      await withDbRetry(() =>
        prisma.decision.update({
          where: { id: decision.id },
          data: {
            pendingAttestationHash: relayErr.attestationHash,
            relayError: `awaiting external attestor signature(s): ${relayErr.collectedCount}/${relayErr.threshold} collected`,
          },
        })
      );
      await recordSignerLifecycleEvent({
        decisionId: decision.id,
        chain: "sepolia",
        state: "SIGNING",
        reason: `${relayErr.collectedCount}/${relayErr.threshold} signatures collected`,
      });
      return;
    }
    if (relayErr instanceof InsufficientSolanaAttestationsError) {
      // Solana-side equivalent of the EVM InsufficientAttestorSignaturesError
      // branch above — same reasoning, same "don't increment relayAttempts"
      // choice. Fixes a real gap a re-audit found: submitAttestedSettle was
      // being called with no externalAttestations at all, so a real 2-of-2
      // Solana decision would throw here every single time with no way to
      // ever collect the second signature — see POST
      // /api/internal/pending-solana-attestations/[decisionId]/sign.
      // eslint-disable-next-line no-console
      console.log(
        `decision ${decision.id} for case ${kase.id} awaiting external Solana attestor signature(s): ` +
          `${relayErr.collectedCount}/${relayErr.threshold} collected`
      );
      await withDbRetry(() =>
        prisma.decision.update({
          where: { id: decision.id },
          data: {
            pendingSolanaAttestationMessage: relayErr.messageHex,
            relayError: `awaiting external Solana attestor signature(s): ${relayErr.collectedCount}/${relayErr.threshold} collected`,
          },
        })
      );
      await recordSignerLifecycleEvent({
        decisionId: decision.id,
        chain: "solanatestnet",
        state: "SIGNING",
        reason: `${relayErr.collectedCount}/${relayErr.threshold} signatures collected`,
      });
      return;
    }
    // A failed relay dispatch doesn't undo the decision itself — the
    // adjudication succeeded and is recorded regardless. Record the
    // error so it's visible; retryFailedSettlements' periodic sweep (not
    // this function) is what durably retries it later, so a transient
    // relay failure right after finalization doesn't leave a FINALIZED
    // decision permanently unsettled just because this one attempt hit
    // a bad RPC call or a momentary rate limit.
    // eslint-disable-next-line no-console
    console.error(`decision relay dispatch failed for case ${kase.id}:`, relayMessage);
    const updatedDecision = await withDbRetry(() =>
      prisma.decision.update({
        where: { id: decision.id },
        data: { relayError: relayMessage, relayAttempts: { increment: 1 } },
      })
    );
    const chainLabel = settlementChainLabel(kase.settlementChain);
    await recordSignerLifecycleEvent({ decisionId: decision.id, chain: chainLabel, state: "FAILED", reason: relayMessage });
    if (updatedDecision.relayAttempts >= MAX_RELAY_ATTEMPTS) {
      await escalateRelayRetriesExhausted(decision.id, chainLabel, relayMessage);
      // Track 5, item 5 — a permanently-stuck settlement is a
      // deterministic human-escalation trigger in its own right, not
      // just an ops alert: a FINALIZED decision that can never
      // automatically settle needs a human decision (retry manually,
      // change the settlement target, or resolve the case another way),
      // the same way HIGH_VALUE/FRAUD_RISK/APPEAL_FILED do.
      await escalateForSettlementFailure(kase.id);
    }
  }
}

/**
 * Retries settlement for FINALIZED decisions whose relay dispatch failed
 * (relayError set, relayTxHash still null) and hasn't exhausted
 * MAX_RELAY_ATTEMPTS. Meant to be run periodically (see lib/worker.ts's
 * repeatable job), not called from a request path.
 *
 * Before this existed, a relay failure after finalization (a transient
 * RPC error, the destination chain being briefly unreachable, etc.) left
 * a FINALIZED decision permanently unsettled - the error was recorded,
 * but nothing ever tried again. This is the durable reconciliation loop
 * that was missing.
 */
/**
 * Sweeps CaseSettlements sitting in PENDING_DEPOSIT with both party
 * addresses already set, and confirms any that actually have a
 * matching deposit on-chain — see lib/case-settlement.ts's
 * checkAndConfirmDeposit for what "matching" means (state read
 * directly from the escrow contract, never a caller-supplied txHash).
 * This is what makes deposit confirmation automatic rather than
 * requiring an operator to click "confirm-deposit" for every case —
 * that endpoint still exists for an immediate on-demand check, this is
 * the same logic run periodically so it self-heals without anyone
 * watching.
 */
export async function confirmPendingDeposits(): Promise<number> {
  const { checkAndConfirmDeposit } = await import("@/lib/case-settlement");
  const pending = await prisma.caseSettlement.findMany({
    where: {
      status: "PENDING_DEPOSIT",
      claimantAddress: { not: null },
      respondentAddress: { not: null },
    },
    select: { id: true },
  });

  let confirmedCount = 0;
  for (const cs of pending) {
    try {
      const result = await checkAndConfirmDeposit(cs.id);
      if (result.outcome === "confirmed") confirmedCount++;
    } catch (err) {
      console.error(`confirmPendingDeposits: failed checking CaseSettlement ${cs.id}`, err);
    }
  }
  return confirmedCount;
}

export async function retryFailedSettlements(): Promise<number> {
  const stuck = await prisma.decision.findMany({
    where: {
      relayError: { not: null },
      relayTxHash: null,
      relayAttempts: { lt: MAX_RELAY_ATTEMPTS },
      consensus: "ACCEPTED",
      case: { status: "FINALIZED" },
    },
    include: { case: true },
  });

  let retriedCount = 0;
  for (const { case: kase, ...decision } of stuck) {
    retriedCount++;
    await dispatchSettlementForDecision(kase, decision);
  }
  return retriedCount;
}

/**
 * Sweeps cases sitting in APPEAL_WINDOW whose window has actually closed
 * (no appeal came in) and finalizes them — transitioning to FINALIZED and
 * only THEN dispatching settlement, never before. Meant to be run
 * periodically (see lib/worker.ts's repeatable job), not called from a
 * request path.
 *
 * This is what makes "settlement only after finalization" true for the
 * common case (no appeal filed) — the appeal-decided path finalizes
 * immediately inside runAdjudicationJob instead, since MAX_APPEALS=1 on
 * the contract means there's nothing left to wait for once an appeal
 * itself has been decided.
 */
export async function finalizeExpiredAppealWindows(): Promise<number> {
  const now = new Date();
  const expired = await prisma.case.findMany({
    where: {
      status: "APPEAL_WINDOW",
      decisions: { some: { appealWindowClosesAt: { lte: now } } },
    },
    include: { decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  let finalizedCount = 0;
  for (const kase of expired) {
    const latestDecision = kase.decisions[0];
    if (!latestDecision || !latestDecision.appealWindowClosesAt || latestDecision.appealWindowClosesAt > now) {
      continue; // race: another sweep tick (or an appeal) already moved this case on
    }

    // Atomic, conditional transition — only succeeds if the case is still
    // exactly where we read it, so two overlapping sweep ticks (or a
    // sweep racing an appeal request) can't both finalize/settle the
    // same case.
    const claimed = await prisma.case.updateMany({
      where: { id: kase.id, status: "APPEAL_WINDOW" },
      data: { status: "FINALIZED" },
    });
    if (claimed.count === 0) continue;

    finalizedCount++;
    dispatchWebhookEvent({
      organizationId: kase.organizationId,
      event: "case.status_changed",
      data: { caseId: kase.id, status: "FINALIZED" },
    });
    await dispatchSettlementForDecision(kase, latestDecision);
  }
  return finalizedCount;
}

export interface SyncCaseResult {
  actions: string[];
}

export type SyncCaseStep = "all" | "adjudication" | "finalization" | "relay";

/**
 * On-demand version of the three periodic sweeps above
 * (confirmPendingDeposits, finalizeExpiredAppealWindows,
 * retryFailedSettlements), scoped to one case instead of scanning every
 * case in the org. Exists so staff aren't stuck waiting out a sweep's
 * own interval (up to 10 minutes for settlement retry) to see a case
 * move forward — the periodic sweeps still run unchanged and remain the
 * real safety net; this is purely a "check this one case right now"
 * convenience, deliberately not a replacement for them (a case nobody
 * ever manually syncs must still resolve on its own).
 *
 * Each step only fires if that step's real precondition already holds
 * (e.g. deposit-check only runs if a settlement is still
 * PENDING_DEPOSIT) — calling this on a case with nothing to do is a
 * harmless no-op, safe to invoke repeatedly.
 */
export async function syncCase(caseId: string, step: SyncCaseStep = "all"): Promise<SyncCaseResult> {
  const actions: string[] = [];

  let kase = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: { settlement: true, decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  if (step === "all" && kase.settlement && kase.settlement.status === "PENDING_DEPOSIT" && kase.settlement.claimantAddress && kase.settlement.respondentAddress) {
    const { checkAndConfirmDeposit } = await import("@/lib/case-settlement");
    const result = await checkAndConfirmDeposit(kase.settlement.id);
    actions.push(`deposit check: ${result.outcome}`);
  }

  kase = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: { settlement: true, decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  const latestDecision = kase.decisions[0];

  if ((step === "all" || step === "finalization") && kase.status === "APPEAL_WINDOW" && latestDecision?.appealWindowClosesAt && latestDecision.appealWindowClosesAt <= new Date()) {
    const claimed = await prisma.case.updateMany({ where: { id: kase.id, status: "APPEAL_WINDOW" }, data: { status: "FINALIZED" } });
    if (claimed.count > 0) {
      actions.push("appeal window closed — finalized");
      dispatchWebhookEvent({ organizationId: kase.organizationId, event: "case.status_changed", data: { caseId: kase.id, status: "FINALIZED" } });
      kase = await prisma.case.findUniqueOrThrow({
        where: { id: caseId },
        include: { settlement: true, decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
    }
  }

  const decision = kase.decisions[0];
  if ((step === "all" || step === "relay") && kase.status === "FINALIZED" && decision && decision.consensus === "ACCEPTED" && !decision.relayTxHash) {
    const before = decision.relayError;
    await dispatchSettlementForDecision(kase, decision);
    const after = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    if (after.relayTxHash) actions.push(`settlement dispatched: ${after.relayTxHash}`);
    else if (after.relayError !== before) actions.push(`settlement not yet dispatched: ${after.relayError}`);
    else actions.push("settlement retry attempted — no change yet");
  }

  if (step === "adjudication") {
    actions.push(kase.decisions[0] ? "adjudication already recorded" : `case is ${kase.status} — use submit for adjudication when evidence is complete`);
  }

  if (actions.length === 0) actions.push("nothing to do — case is not waiting on any sync-eligible step");
  return { actions };
}

/**
 * Runs the actual GenLayer round trip (deploy -> adjudicate -> persist
 * decision) for a case that's already past evidence validation and
 * transitioned to ADJUDICATING/RE_ADJUDICATING. Invoked by the Job queue
 * (src/lib/jobs.ts), not called directly by API routes.
 *
 * `isAppeal` distinguishes a fresh case (deploy a new contract) from an
 * appeal re-run (reuse the existing contract, call appeal() first to
 * reopen it, then adjudicate() again with whatever evidence is on file
 * now — which may include rows added during the appeal window).
 */
export async function runAdjudicationJob(caseId: string, isAppeal = false): Promise<void> {
  const kase = await withDbRetry(() =>
    prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      include: { evidence: true },
    })
  );

  const genlayer = getGenLayerClient();

  try {
    let contractAddress = kase.contractAddress as `0x${string}` | null;

    // Real bug found and fixed 2026-09-06 (case cmtq5l4jq0002gi5mum3t6xui):
    // the non-appeal branch used to unconditionally deployCase() every
    // time this job ran, with no `if (!contractAddress)` guard — unlike
    // the appeal branch right above, which already reuses the existing
    // contract. A retry after ANY transient failure (a network blip
    // reading getDecision(), a DB write hiccup) would redeploy a brand
    // new contract and call adjudicate() again, abandoning whatever the
    // first, possibly-successful attempt had already decided on GenLayer
    // — the real decision then sits on-chain at the OLD address forever,
    // invisible to this job and to the app, while the case is left
    // showing a generic UNDETERMINED from whatever the retry's own
    // failure happened to be. Now: only deploy once per case; a retry
    // reuses the existing contract and checks get_decision() BEFORE
    // calling adjudicate() again, so a decision that already exists is
    // recovered instead of silently orphaned by a duplicate deploy.
    let recoveredDecision: Awaited<ReturnType<typeof genlayer.getDecision>> = null;
    if (isAppeal) {
      if (!contractAddress) {
        throw new Error("cannot appeal a case with no deployed contract");
      }
      // Real bug found and fixed 2026-09-14 (case cmu0fuxzy0002xq5dzk6y95po):
      // unlike the non-appeal retry branch below, this had no protection
      // against calling appeal() a second time after a prior attempt's
      // appeal() succeeded but the FOLLOWING adjudicate() call failed
      // (timed out, transient GenLayer error, etc.) — a bare retry would
      // call appeal() again, which the contract correctly rejects
      // (`status != "DECIDED"`, since a successful appeal() already
      // flipped it to "PENDING"), throwing and landing the case in
      // UNDETERMINED with no recovery path, exactly the failure mode
      // documented above for the non-appeal branch. Adjudicator.py's
      // appeal() raises a UserError containing this exact substring for
      // that specific condition (see adjudicator.py's own appeal()) —
      // caught here and treated as "already appealed, proceed to
      // adjudicate()" rather than a real failure.
      //
      // "Appeal limit reached" (adjudicator.py's OTHER appeal() revert,
      // `appeal_count >= MAX_APPEALS`) is caught the same way for a
      // second reason: a retry landing here after appeal() AND
      // adjudicate() have BOTH already succeeded (only the DB write
      // after that was lost) sees a contract back in the "DECIDED"
      // state, so this specific check is what would fire instead of the
      // "not in a decided state" one above — genuinely already-appealed,
      // not a real failure either. The getDecision() call just below
      // recovers that case; a real MAX_APPEALS violation (a party
      // attempting a second, unrelated appeal) would still show up
      // there as a non-null decision with nothing new to persist, not a
      // silent no-op.
      try {
        await genlayer.appealCase(contractAddress);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("is not in a decided state") && !message.includes("Appeal limit reached")) {
          throw err;
        }
      }
      // Same reasoning as the non-appeal branch's recovery check just
      // below: a prior attempt's appeal() AND adjudicate() may both have
      // already succeeded, with only the DB write after that lost — in
      // which case a fresh adjudicate() call here would hit the
      // contract's own "already decided" guard. Checking first recovers
      // that real decision instead of throwing.
      recoveredDecision = await genlayer.getDecision(contractAddress);
    } else if (contractAddress) {
      // A retry: this case already has a deployed contract from a prior
      // attempt. Check whether that attempt actually landed a real
      // decision before assuming it didn't and calling adjudicate()
      // again (which the contract correctly rejects once already
      // decided — see genvm-lint's own "already-decided re-adjudication
      // rejection" test case).
      recoveredDecision = await genlayer.getDecision(contractAddress);
    } else {
      const deployed = await genlayer.deployCase({
        code: getAdjudicatorContractCode(),
        caseId: kase.id,
        claimantRef: kase.claimantRef,
        respondentRef: kase.respondentRef,
        attoAmount: toAttoAmount(kase.amount.toString()),
      });
      contractAddress = deployed.contractAddress;
      await prisma.case.update({ where: { id: kase.id }, data: { contractAddress } });
    }

    // Generic evidence map — the contract looks up which fields it needs
    // by policy_id, so the backend just forwards everything submitted
    // rather than picking named fields per policy. Sorted oldest-first so
    // a later row wins on type collision — the only way a type repeats is
    // a correction submitted during an appeal window (evidence-validation
    // only allows that resubmission there), and the corrected value is
    // the one that should reach the contract.
    const evidence: Record<string, string> = {};
    const sortedEvidence = [...kase.evidence].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const e of sortedEvidence) {
      // A PDF with successfully extracted text (see the evidence upload
      // route + lib/pdf-extract.ts) sends that real content instead of
      // the bare URL — the contract has no PDF-parsing capability of its
      // own, so this is the only way its actual content reaches
      // adjudication rather than just "this URL is reachable." Image
      // evidence (no extractedText) still needs a real fetchable URL —
      // file evidence is stored as a private Cloudinary reference (see
      // lib/storage.ts), so resolve it into a freshly signed URL right
      // here rather than sending GenVM a reference it can't fetch.
      const value = e.extractedText ?? resolveEvidenceUri(e.storageRef, GENLAYER_EVIDENCE_URL_TTL_SECONDS);
      // Redact common structured PII (emails, phone numbers, SSNs, card
      // numbers) out of free-text party statements before they reach
      // GenLayer — see lib/pii-redaction.ts for why this applies only to
      // statement fields, not the substantive evidence being judged.
      evidence[e.type] = REDACTED_EVIDENCE_TYPES.has(e.type) ? redactPii(value) : value;
    }

    // Hard stop before ever calling GenLayer with a broken evidence map.
    // Observed live: under concurrent adjudication jobs, this map has come
    // back empty despite kase.evidence.length being correctly non-zero
    // moments earlier in the same function call — root cause not yet
    // isolated (ruled out: shared module state, Prisma query scoping,
    // BullMQ job-id collisions, a stale deploy - the running code was
    // byte-identical to source). Whatever the cause, GenLayer still
    // returned a confident-looking ACCEPTED verdict for zero evidence,
    // which is far worse than a loud failure: a decision "GenLayer
    // decided" with nothing backing it, persisted and eligible to
    // finalize and settle real funds. This check makes that impossible
    // regardless of why the map ended up wrong - required evidence
    // missing at this point throws, which the caller's catch block turns
    // into an UNDETERMINED case and a job-queue retry, not a corrupted
    // ACCEPTED one.
    const requiredTypes = requiredEvidenceTypesFor(kase.policyId);
    const missingTypes = requiredTypes.filter((t) => !evidence[t]);
    if (missingTypes.length > 0) {
      throw new Error(
        `refusing to adjudicate case ${kase.id} with missing evidence [${missingTypes.join(", ")}] — ` +
          `kase.evidence had ${kase.evidence.length} row(s), evidence map had ${Object.keys(evidence).length} ` +
          `key(s); this should never happen if evidence validation upstream passed`
      );
    }

    let adjudicateTxHash: string | null = null;
    let decision: NonNullable<typeof recoveredDecision>;
    if (recoveredDecision) {
      // Recovered from a prior attempt's already-decided contract (see
      // the retry-safety comment above) — no new adjudicate() call, so
      // no new transaction hash exists for this run. adjudicateTxHash
      // stays null rather than fabricated; the original attempt's real
      // tx hash wasn't captured before it was lost, which is exactly
      // the gap this fix closes for every future case.
      decision = recoveredDecision;
    } else {
      // Capture the real GenLayer transaction hash of the call that
      // produced this decision — previously discarded, leaving no way to
      // independently verify a decision actually happened on GenLayer
      // (`genlayer receipt <txHash>`) short of trusting Anchor's own claim.
      const result = await genlayer.runAdjudication(contractAddress, {
        policyId: kase.policyId,
        evidence,
      });
      adjudicateTxHash = result.txHash;

      const fetched = await genlayer.getDecision(contractAddress);
      if (!fetched) {
        throw new Error("adjudicate() succeeded but get_decision() returned empty");
      }
      decision = fetched;
    }

    // A successful first decision opens an appeal window; a successful
    // appeal decision is final (the contract's MAX_APPEALS=1 means there's
    // nothing left to appeal again, so there's no point holding another
    // window open). An UNDETERMINED result never gets an appeal window —
    // there's no accepted verdict to contest, the fix is better evidence
    // and a normal resubmission, not an appeal.
    const nextStatus =
      decision.consensus !== "ACCEPTED" ? "UNDETERMINED" : isAppeal ? "FINALIZED" : "APPEAL_WINDOW";

    // Hashes of what was actually sent to the contract (post-redaction,
    // PDF-text-extraction) — not e.contentHash, which is the hash of the
    // original uploaded evidence. Those two diverge for any statement
    // that got redacted or any PDF whose extracted text replaced its
    // storageRef, so hashing the original would let evidenceManifestHash
    // "verify" content the adjudication never actually saw.
    const evidenceUsed = Object.entries(evidence).map(([type, value]) => `${type}:${sha256Hex(value)}`);
    const proofHash = decision.evidenceHash ?? null;
    const contractCodeHash = computeContractCodeHash();
    const evidenceManifestHash = computeEvidenceManifestHash(evidenceUsed);
    const decisionHash = computeDecisionHash({
      caseId: kase.id,
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      outcome: decision.outcome,
      claimantShareBps: decision.claimantShareBps,
      respondentShareBps: decision.respondentShareBps,
      reasonCodes: decision.reasonCodes,
      proofHash,
      contractCodeHash,
    });

    const [createdDecision] = await withDbRetry(() => prisma.$transaction([
      prisma.decision.create({
        data: {
          caseId: kase.id,
          policyId: decision.policyId,
          policyVersion: decision.policyVersion,
          outcome: decision.outcome,
          claimantShareBps: decision.claimantShareBps,
          respondentShareBps: decision.respondentShareBps,
          reasonCodes: decision.reasonCodes,
          // The actual evidence type/contentHash pairs sent to the
          // contract for this run — a real record of what was
          // adjudicated on, not a placeholder.
          evidenceUsed,
          // The contract's own deterministic evidence_hash - see
          // dispatchSettlementForDecision for why this, not a hash of
          // the case ID, is what gets relayed as settlement proof.
          proofHash,
          // The rest of the finalized-decision proof bundle — see each
          // field's schema comment for what it independently verifies.
          contractCodeHash,
          adjudicateTxHash,
          evidenceManifestHash,
          decisionHash,
          consensus: decision.consensus,
          appealWindowClosesAt: nextStatus === "APPEAL_WINDOW" ? new Date(Date.now() + APPEAL_WINDOW_MS) : null,
        },
      }),
      prisma.case.update({ where: { id: kase.id }, data: { status: nextStatus } }),
    ]));

    await recordBillableEvent({
      organizationId: kase.organizationId,
      eventType: BillableEventType.ADJUDICATION_RUN,
      subjectId: createdDecision.id,
      metadata: { caseId: kase.id, isAppeal, consensus: decision.consensus },
    });

    dispatchWebhookEvent({
      organizationId: kase.organizationId,
      event: "case.decided",
      data: { caseId: kase.id, status: nextStatus, outcome: decision.outcome, consensus: decision.consensus },
    });
    dispatchWebhookEvent({
      organizationId: kase.organizationId,
      event: "case.status_changed",
      data: { caseId: kase.id, status: nextStatus },
    });

    // Settlement only ever dispatches once a case is truly FINALIZED —
    // never from APPEAL_WINDOW, where the decision can still be
    // contested. FINALIZED here only happens on the appeal-decided path
    // (isAppeal=true): the contract's MAX_APPEALS=1 means an appeal
    // decision itself can never be appealed again, so there's nothing
    // left to wait for. The far more common path — a first decision that
    // goes uncontested — reaches FINALIZED (and dispatches settlement)
    // later, via finalizeExpiredAppealWindows's periodic sweep once the
    // window genuinely closes.
    if (nextStatus === "FINALIZED") {
      await dispatchSettlementForDecision(kase, createdDecision);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`adjudication job failed for case ${caseId}:`, message);
    // Retried too: if THIS write also hits a transient DB error and
    // throws, the case is left stuck in ADJUDICATING forever with no
    // automatic recovery path (adjudicate's own API guard only accepts
    // EVIDENCE_COLLECTION) — exactly what happened in the 2026-09-07
    // incident this whole retry mechanism exists to prevent.
    await withDbRetry(() => prisma.case.update({ where: { id: kase.id }, data: { status: "UNDETERMINED" } }));
    dispatchWebhookEvent({
      organizationId: kase.organizationId,
      event: "case.status_changed",
      data: { caseId: kase.id, status: "UNDETERMINED", error: message },
    });
    throw err; // let the Job queue record the failure/retry, not just swallow it
  }
}
