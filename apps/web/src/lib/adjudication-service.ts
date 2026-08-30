import { prisma } from "@/lib/prisma";
import { getAdjudicatorContractCode, getGenLayerClient, toAttoAmount } from "@/lib/genlayer";
import { getPolicy } from "@/lib/policies";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { dispatchDecisionForCase } from "@/lib/hyperlane";

const APPEAL_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

/** Required evidence types for a case's policy — used by the adjudicate route's readiness check. */
export function requiredEvidenceTypesFor(policyId: string): string[] {
  const policy = getPolicy(policyId);
  return policy ? policy.requiredEvidence.map((e) => e.type) : [];
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
        attoAmount: toAttoAmount(Number(kase.amount)),
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
      evidence[e.type] = e.storageRef;
    }

    await genlayer.runAdjudication(contractAddress, { policyId: kase.policyId, evidence });

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
          evidenceUsed: [],
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

    // Auto-dispatch: a decided case with a settlement target configured
    // relays automatically, no separate manual/scripted trigger needed.
    // Only for a real ACCEPTED verdict — nothing to settle on UNDETERMINED.
    if (decision.consensus === "ACCEPTED" && kase.settlementChain && kase.settlementContract) {
      const totalAmountAtto = toAttoAmount(Number(kase.amount));
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
        });
        await prisma.decision.update({
          where: { id: createdDecision.id },
          data: { relayTxHash: txHash, relayMessageId: messageId },
        });
        dispatchWebhookEvent({
          organizationId: kase.organizationId,
          event: "case.relay_dispatched",
          data: { caseId: kase.id, txHash, messageId },
        });
      } catch (relayErr) {
        // A failed relay dispatch doesn't undo the decision itself — the
        // adjudication succeeded and is recorded regardless. Record the
        // error on the decision so it's visible, but don't fail the job.
        const relayMessage = relayErr instanceof Error ? relayErr.message : String(relayErr);
        // eslint-disable-next-line no-console
        console.error(`decision relay dispatch failed for case ${kase.id}:`, relayMessage);
        await prisma.decision.update({ where: { id: createdDecision.id }, data: { relayError: relayMessage } });
      }
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
