import { NextResponse } from "next/server";
import type { Case, Evidence } from "@prisma/client";
import { getPolicy } from "@/lib/policies";

/**
 * Shared preconditions for both text and file evidence submission: the
 * case must be collecting evidence, its policy must still exist, the type
 * must be one that policy actually asks for, and it can't already be on
 * file (evidence is append-only for audit integrity). Returns an error
 * response to return as-is, or null if the submission may proceed.
 */
export function checkEvidenceSubmittable(
  kase: Case & { evidence: Evidence[] },
  type: string
): NextResponse | null {
  if (kase.status !== "EVIDENCE_COLLECTION" && kase.status !== "OPEN") {
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

  if (kase.evidence.some((e) => e.type === type)) {
    return NextResponse.json({ error: `evidence of type ${type} already submitted for this case` }, { status: 409 });
  }

  return null;
}
