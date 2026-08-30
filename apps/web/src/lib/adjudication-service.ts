import { prisma } from "@/lib/prisma";
import { getAdjudicatorContractCode, getGenLayerClient, toAttoAmount } from "@/lib/genlayer";
import { getPolicy } from "@/lib/policies";

/** Required evidence types for a case's policy — used by the adjudicate route's readiness check. */
export function requiredEvidenceTypesFor(policyId: string): string[] {
  const policy = getPolicy(policyId);
  return policy ? policy.requiredEvidence.map((e) => e.type) : [];
}

/**
 * Runs the actual GenLayer round trip (deploy -> adjudicate -> persist
 * decision) for a case that's already past evidence validation and
 * transitioned to ADJUDICATING. Not awaited by the API route that kicks it
 * off — see the caller for why, and its production caveats.
 */
export async function runAdjudicationJob(caseId: string): Promise<void> {
  const kase = await prisma.case.findUniqueOrThrow({
    where: { id: caseId },
    include: { evidence: true },
  });

  const genlayer = getGenLayerClient();

  try {
    const { contractAddress } = await genlayer.deployCase({
      code: getAdjudicatorContractCode(),
      caseId: kase.id,
      claimantRef: kase.claimantRef,
      respondentRef: kase.respondentRef,
      attoAmount: toAttoAmount(Number(kase.amount)),
    });

    await prisma.case.update({ where: { id: kase.id }, data: { contractAddress } });

    // Generic evidence map — the contract looks up which fields it needs
    // by policy_id, so the backend just forwards everything submitted
    // rather than picking named fields per policy.
    const evidence: Record<string, string> = {};
    for (const e of kase.evidence) {
      evidence[e.type] = e.storageRef;
    }

    await genlayer.runAdjudication(contractAddress, { policyId: kase.policyId, evidence });

    const decision = await genlayer.getDecision(contractAddress);
    if (!decision) {
      throw new Error("adjudicate() succeeded but get_decision() returned empty");
    }

    await prisma.$transaction([
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
        },
      }),
      prisma.case.update({
        where: { id: kase.id },
        data: { status: decision.consensus === "ACCEPTED" ? "ACCEPTED" : "UNDETERMINED" },
      }),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`adjudication job failed for case ${caseId}:`, message);
    await prisma.case.update({ where: { id: kase.id }, data: { status: "UNDETERMINED" } });
  }
}
