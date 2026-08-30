import { NextResponse } from "next/server";
import type { Case, Evidence } from "@prisma/client";
import { getPolicy } from "@/lib/policies";

/**
 * Shared preconditions for both text and file evidence submission: the
 * case's policy must still exist, the type must be one that policy
 * actually asks for, and — outside an appeal window — it can't already
 * be on file (evidence is append-only for audit integrity during normal
 * collection). Returns an error response to return as-is, or null if the
 * submission may proceed.
 */
export function checkEvidenceSubmittable(
  kase: Case & { evidence: Evidence[] },
  type: string
): NextResponse | null {
  const isAppealWindow = kase.status === "APPEAL_WINDOW";
  if (kase.status !== "EVIDENCE_COLLECTION" && kase.status !== "OPEN" && !isAppealWindow) {
    return NextResponse.json({ error: `cannot add evidence in status ${kase.status}` }, { status: 409 });
  }

  const policy = getPolicy(kase.policyId);
  if (!policy) {
    return NextResponse.json({ error: `case's policy ${kase.policyId} is not recognized` }, { status: 500 });
  }

  const validTypes = new Set(policy.requiredEvidence.map((e) => e.type));
  if (!validTypes.has(type)) {
    return NextResponse.json(
      { error: `unknown evidence type for policy ${policy.id}: ${type}`, validTypes: [...validTypes] },
      { status: 400 }
    );
  }

  // Outside an appeal window, a required type already on file can't be
  // silently overwritten (audit integrity). During an appeal window, a
  // resubmission is exactly the point — a party correcting or updating
  // evidence before the re-adjudication runs — so it's allowed; the
  // adjudication job picks the most recent row per type (see
  // adjudication-service.ts).
  if (!isAppealWindow && kase.evidence.some((e) => e.type === type)) {
    return NextResponse.json({ error: `evidence of type ${type} already submitted for this case` }, { status: 409 });
  }

  return null;
}
