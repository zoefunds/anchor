import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess, requireScope } from "@/lib/auth";
import { getPolicy, DEFAULT_POLICY_ID } from "@/lib/policies";
import { generatePartyToken } from "@/lib/party-auth";
import { logAction } from "@/lib/audit";

// POST /api/cases/sandbox — one-click test case, addressing a real
// onboarding gap: "the workflow is detailed and well explained, but it
// is still complex for a first-time user... a one-click sandbox case
// with prefilled evidence would let people test the full verdict flow
// without creating their own synthetic dispute or handling private
// party links." Creates a case that's already in EVIDENCE_COLLECTION
// with every required exhibit for `agent_data_task_v1` already filed —
// the caller can go straight to "Submit for adjudication" and watch a
// real GenLayer verdict, or inspect/edit the prefilled evidence first.
//
// Deliberately skips everything a real case creation goes through that
// only makes sense for real disputes: computeRiskAssessment (nothing to
// score), policy-version binding (this is always the static default
// policy, not an org's configured one), and billing events (never
// billable). Party tokens are still generated — harmless, and lets a
// curious user see the public party-link flow too, on a case where
// nothing they do there actually matters.
//
// The prefilled scenario is a deliberately unambiguous RELEASE_FULL-
// shaped delivery (spec fully met) rather than a genuinely contested
// one — the point of a sandbox is a fast, legible "yes, this really
// works end to end" first impression, not a demo of edge-case
// adjudication. isSandbox marks the case so it can be filtered/labeled
// distinctly from real disputes without guessing from claimantRef
// naming conventions.
const SANDBOX_EVIDENCE: Record<string, string> = {
  task_spec:
    "Scrape the top 10 posts from Hacker News' front page (https://news.ycombinator.com) and " +
    "return a JSON array of exactly 10 objects, each with: title (non-empty string), url " +
    "(non-empty string), points (non-negative integer). Output must be valid JSON with no " +
    "extra commentary.",
  delivery_payload: JSON.stringify(
    Array.from({ length: 10 }, (_, i) => ({
      title: `Show HN: sandbox demo post #${i + 1}`,
      url: `https://example.com/item/${i + 1}`,
      points: 300 - i * 12,
    }))
  ),
  claimant_statement:
    "The file arrived on time and looks complete, but I haven't independently verified the " +
    "contents myself — flagging for adjudication out of caution before releasing payment, not " +
    "because I've found a specific defect.",
  respondent_statement:
    "Delivery matches the spec exactly: valid JSON, exactly 10 items, every item has all three " +
    "required fields populated. Requesting release.",
};

export async function POST(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;
  const scopeError = requireScope(auth, "cases:write");
  if (scopeError) return scopeError;

  const policy = getPolicy(DEFAULT_POLICY_ID);
  if (!policy) {
    // Can't happen with the current static registry, but a route this
    // load-bearing for first impressions should never 500 opaquely.
    return NextResponse.json({ error: `sandbox policy ${DEFAULT_POLICY_ID} is not registered` }, { status: 500 });
  }

  const claimantToken = generatePartyToken();
  const respondentToken = generatePartyToken();
  const suffix = Date.now().toString(36);

  const kase = await prisma.$transaction(async (tx) => {
    const created = await tx.case.create({
      data: {
        organizationId: auth.organizationId,
        claim: "Sandbox: agent data-task delivery dispute (safe to test — no real parties)",
        amount: "250.00",
        currency: "USD",
        claimantRef: `sandbox-claimant-${suffix}`,
        respondentRef: `sandbox-respondent-${suffix}`,
        policyId: policy.id,
        policyVersion: policy.version,
        status: "EVIDENCE_COLLECTION",
        claimantTokenHash: claimantToken.hash,
        respondentTokenHash: respondentToken.hash,
        claimantTokenExpiresAt: claimantToken.expiresAt,
        respondentTokenExpiresAt: respondentToken.expiresAt,
        isSandbox: true,
      },
    });

    for (const req of policy.requiredEvidence) {
      const content = SANDBOX_EVIDENCE[req.type];
      if (!content) continue; // shouldn't happen for DEFAULT_POLICY_ID, but never crash the sandbox route over it
      await tx.evidence.create({
        data: {
          caseId: created.id,
          type: req.type,
          contentHash: createHash("sha256").update(content).digest("hex"),
          storageRef: content,
          submittedBy: req.restrictedTo ?? null,
          // organization_asserted, not claimant_authenticated/
          // respondent_authenticated — this content was written by the
          // sandbox route itself, not a real authenticated party, and
          // attributionSource must never claim stronger provenance than
          // what actually happened.
          attributionSource: "organization_asserted",
        },
      });
    }

    await logAction(
      {
        organizationId: auth.organizationId,
        memberId: auth.memberId,
        apiKeyId: auth.apiKeyId,
        action: "case.sandbox_created",
        targetType: "case",
        targetId: created.id,
      },
      tx
    );

    return created;
  });

  return NextResponse.json({ case: kase }, { status: 201 });
}
