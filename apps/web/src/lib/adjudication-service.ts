import { createHash } from "crypto";
import type { Case, Decision } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdjudicatorContractCode, getGenLayerClient, toAttoAmount } from "@/lib/genlayer";
import { getPolicy } from "@/lib/policies";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { dispatchDecisionForCase, DecisionAlreadySettledError } from "@/lib/hyperlane";
import { redactPii, REDACTED_EVIDENCE_TYPES } from "@/lib/pii-redaction";

const APPEAL_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
const MAX_RELAY_ATTEMPTS = 10;
// How long a relayClaimedAt lease is honored before it's treated as an
// abandoned attempt (crashed process, killed worker) rather than one
// still in flight — long enough that a normal RPC round-trip to Sepolia
// never trips it, short enough that a real crash doesn't stall
// settlement for hours.
const RELAY_CLAIM_TTL_MS = 5 * 60 * 1000;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** sha256 of the exact contract source deployed for this decision — see Decision.contractCodeHash's schema comment. */
function computeContractCodeHash(): string {
  return sha256Hex(getAdjudicatorContractCode());
}

/** sha256 of the canonical (sorted) evidenceUsed array — see Decision.evidenceManifestHash's schema comment. */
function computeEvidenceManifestHash(evidenceUsed: string[]): string {
  return sha256Hex(JSON.stringify([...evidenceUsed].sort()));
}

/** sha256 of this decision's own canonical content — see Decision.decisionHash's schema comment. */
function computeDecisionHash(params: {
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
 */
async function dispatchSettlementForDecision(kase: Case, decision: Decision): Promise<void> {
  if (!kase.settlementChain || !kase.settlementContract) return;
  if (decision.consensus !== "ACCEPTED") return;
  if (decision.relayTxHash) return; // already settled — retryFailedSettlements can call this again, must not double-dispatch
  if (decision.relayAttempts >= MAX_RELAY_ATTEMPTS) return; // see retryFailedSettlements' schema comment
  if (!decision.proofHash || !decision.decisionHash) {
    // Every real ACCEPTED decision has both (set when the Decision row
    // was created - see runAdjudicationJob). Missing either means
    // something upstream regressed; refuse to relay with no real proof
    // rather than silently fabricating one.
    // eslint-disable-next-line no-console
    console.error(`decision ${decision.id} for case ${kase.id} has no proofHash/decisionHash — refusing to dispatch settlement`);
    return;
  }

  // Atomic claim/lease (see Decision.relayClaimedAt's schema comment) —
  // only proceeds if no other worker holds an unexpired claim on this
  // decision, so a concurrent retry sweep firing at the same moment as
  // this call can't both pass the checks above and both dispatch.
  const claimCutoff = new Date(Date.now() - RELAY_CLAIM_TTL_MS);
  const claimed = await prisma.decision.updateMany({
    where: {
      id: decision.id,
      relayTxHash: null,
      OR: [{ relayClaimedAt: null }, { relayClaimedAt: { lt: claimCutoff } }],
    },
    data: { relayClaimedAt: new Date() },
  });
  if (claimed.count === 0) {
    // eslint-disable-next-line no-console
    console.error(`decision ${decision.id} for case ${kase.id} already has an in-flight relay claim — skipping`);
    return;
  }

  const totalAmountAtto = toAttoAmount(kase.amount.toString());
  const claimantBps = BigInt(decision.claimantShareBps ?? 0);
  const respondentBps = BigInt(decision.respondentShareBps ?? 0);
  try {
    const { txHash, messageId } = await dispatchDecisionForCase({
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
    });
    await prisma.decision.update({
      where: { id: decision.id },
      data: { relayTxHash: txHash, relayMessageId: messageId, relayError: null, relayAttempts: { increment: 1 } },
    });
    dispatchWebhookEvent({
      organizationId: kase.organizationId,
      event: "case.relay_dispatched",
      data: { caseId: kase.id, txHash, messageId },
    });
  } catch (relayErr) {
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
      await prisma.decision.update({
        where: { id: decision.id },
        data: { relayTxHash: "reconciled:onchain", relayError: null, relayAttempts: { increment: 1 } },
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
    const relayMessage = relayErr instanceof Error ? relayErr.message : String(relayErr);
    // eslint-disable-next-line no-console
    console.error(`decision relay dispatch failed for case ${kase.id}:`, relayMessage);
    await prisma.decision.update({
      where: { id: decision.id },
      data: { relayError: relayMessage, relayAttempts: { increment: 1 } },
    });
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
  const kase = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: { evidence: true },
  });

  const genlayer = getGenLayerClient();

  try {
    let contractAddress = kase.contractAddress as `0x${string}` | null;

    if (isAppeal) {
      if (!contractAddress) {
        throw new Error("cannot appeal a case with no deployed contract");
      }
      await genlayer.appealCase(contractAddress);
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
      // adjudication rather than just "this URL is reachable."
      const value = e.extractedText ?? e.storageRef;
      // Redact common structured PII (emails, phone numbers, SSNs, card
      // numbers) out of free-text party statements before they reach
      // GenLayer — see lib/pii-redaction.ts for why this applies only to
      // statement fields, not the substantive evidence being judged.
      evidence[e.type] = REDACTED_EVIDENCE_TYPES.has(e.type) ? redactPii(value) : value;
    }

    // Capture the real GenLayer transaction hash of the call that
    // produced this decision — previously discarded, leaving no way to
    // independently verify a decision actually happened on GenLayer
    // (`genlayer receipt <txHash>`) short of trusting Anchor's own claim.
    const { txHash: adjudicateTxHash } = await genlayer.runAdjudication(contractAddress, {
      policyId: kase.policyId,
      evidence,
    });

    const decision = await genlayer.getDecision(contractAddress);
    if (!decision) {
      throw new Error("adjudicate() succeeded but get_decision() returned empty");
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

    const [createdDecision] = await prisma.$transaction([
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
    ]);

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
    await prisma.case.update({ where: { id: kase.id }, data: { status: "UNDETERMINED" } });
    dispatchWebhookEvent({
      organizationId: kase.organizationId,
      event: "case.status_changed",
      data: { caseId: kase.id, status: "UNDETERMINED", error: message },
    });
    throw err; // let the Job queue record the failure/retry, not just swallow it
  }
}
