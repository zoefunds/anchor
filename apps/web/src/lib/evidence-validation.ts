import { NextResponse } from "next/server";
import type { Case, Evidence } from "@prisma/client";
import { getPolicy } from "@/lib/policies";

export type EvidenceSubmitter = "organization" | "claimant" | "respondent";

/**
 * Shared preconditions for both text and file evidence submission: the
 * case's policy must still exist, the type must be one that policy
 * actually asks for, the submitter must be who the policy says may file
 * that exhibit (organization-held documentation vs. a party's own
 * statement — see RequiredEvidence.restrictedTo), and — outside an
 * appeal window — it can't already be on file (evidence is append-only
 * for audit integrity during normal collection). Returns an error
 * response to return as-is, or null if the submission may proceed.
 */
export function checkEvidenceSubmittable(
  kase: Case & { evidence: Evidence[] },
  type: string,
  submitter: EvidenceSubmitter
): NextResponse | null {
  const isAppealWindow = kase.status === "APPEAL_WINDOW";
  if (kase.status !== "EVIDENCE_COLLECTION" && kase.status !== "OPEN" && !isAppealWindow) {
    return NextResponse.json({ error: `cannot add evidence in status ${kase.status}` }, { status: 409 });
  }

  const policy = getPolicy(kase.policyId);
  if (!policy) {
    return NextResponse.json({ error: `case's policy ${kase.policyId} is not recognized` }, { status: 500 });
  }

  const requiredEntry = policy.requiredEvidence.find((e) => e.type === type);
  if (!requiredEntry) {
    return NextResponse.json(
      {
        error: `unknown evidence type for policy ${policy.id}: ${type}`,
        validTypes: policy.requiredEvidence.map((e) => e.type),
      },
      { status: 400 }
    );
  }

  // restrictedTo: undefined means org-only (the filing org's own
  // documentation); "claimant"/"respondent" means only that party's own
  // authenticated submission — never the org on their behalf, and never
  // the other party.
  const allowedSubmitter = requiredEntry.restrictedTo ?? "organization";
  if (allowedSubmitter !== submitter) {
    return NextResponse.json(
      {
        error: `${requiredEntry.label} must be filed by ${allowedSubmitter === "organization" ? "the organization" : `the ${allowedSubmitter}`}, not ${submitter === "organization" ? "the organization" : `the ${submitter}`}`,
      },
      { status: 403 }
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
