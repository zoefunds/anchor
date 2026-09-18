import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePartyAuth, readPartySessionCookie } from "@/lib/party-auth";
import { resolveEvidenceUri } from "@/lib/storage";
import { toPartyVisibleReviewStatus } from "@/lib/escalation";
import { getPolicy } from "@/lib/policies";

const PUBLIC_EVIDENCE_URL_TTL_SECONDS = 10 * 60;

// GET /api/public/cases/:id?token=... — for the counterparty in a
// dispute who doesn't hold an org session or API key but still needs to
// see the case's evidence and verdict. Requires a valid per-case party
// token or an exchanged session cookie (see lib/party-auth.ts) — a bare
// case ID is not a credential, and evidence/statements are exactly the
// kind of thing that must not be readable by anyone who merely learns
// the ID (forwarded link, referrer leak, log line, etc).
//
// Deliberately a narrow field set, not `prisma.case` wholesale: no
// organizationId, no internal contractAddress-adjacent org context, and
// evidence storageRef is still exposed (it's either the literal
// submitted text, or — for a file — a freshly signed, short-lived
// Cloudinary URL resolved just for this response, not a standing
// public link — see lib/storage.ts's resolveEvidenceUri) but nothing
// about which org filed it or its API keys/members/billing.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = req.nextUrl.searchParams.get("token") ?? undefined;
  const sessionCookie = readPartySessionCookie(req.cookies, (await params).id);
  const resolved = await resolvePartyAuth(sessionCookie, token, (await params).id);
  if (!resolved) {
    return NextResponse.json({ error: "token query parameter or session is required" }, { status: 401 });
  }

  const kase = await prisma.case.findUnique({
    where: { id: (await params).id },
    include: {
      evidence: { orderBy: { createdAt: "asc" } },
      decisions: { orderBy: { createdAt: "desc" } },
      settlement: { include: { integration: true } },
      review: true,
      policyVersionRecord: true,
    },
  });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: kase.id,
    status: kase.status,
    claim: kase.claim,
    amount: kase.amount,
    currency: kase.currency,
    policyId: kase.policyId,
    claimantRef: kase.claimantRef,
    respondentRef: kase.respondentRef,
    createdAt: kase.createdAt,
    // Phase 5, item 2 — surfaced so the public case page can render an
    // evidence-submission deadline and appeal-window countdown without
    // exposing the rest of the policy (allowedOutcomes, velocity limits,
    // etc are org-internal and stay out of this response).
    //
    // Two independent sources of "policy" exist for a case: the
    // org-configurable PolicyVersion engine (kase.policyVersionRecord,
    // Phase 4) and the older static registry keyed by kase.policyId
    // (lib/policies.ts) — a case can be bound to either, and most cases
    // created outside the versioned-policy flow have no
    // policyVersionRecord at all. Gating this whole field on
    // policyVersionRecord alone meant those cases got `policy: null`,
    // which made requiredEvidence silently empty — the party page then
    // read "nothing left to file" instead of the real required exhibit,
    // showing "you've already submitted" on a case with zero evidence.
    // requiredEvidence must come from whichever source actually has it,
    // not only the versioned one.
    policy: kase.policyVersionRecord
      ? {
          evidenceDeadlineHours: kase.policyVersionRecord.evidenceDeadlineHours,
          appealWindowHours: kase.policyVersionRecord.appealWindowHours,
          // Type/label only (no allowedOutcomes/velocity limits) — lets the
          // page offer a dropdown of accepted evidence types instead of a
          // free-text field parties can typo, which the server otherwise
          // rejects with an opaque 400 (see checkEvidenceSubmittable).
          requiredEvidence: getPolicy(kase.policyId)?.requiredEvidence ?? [],
        }
      : getPolicy(kase.policyId)
        ? {
            // No versioned deadline/window exists for a static-registry
            // case — real enforcement (checkEvidenceSubmittable, the
            // appeal-window check) is entirely status/timestamp-driven,
            // never this display-only figure, so omitting it just skips
            // the optional countdown rather than blocking anything.
            evidenceDeadlineHours: null,
            appealWindowHours: null,
            requiredEvidence: getPolicy(kase.policyId)!.requiredEvidence,
          }
        : null,
    // The resolving party's own role — lets the page render "set YOUR
    // payout address" without a second round trip, and without ever
    // exposing which role a caller resolved to anyone who didn't
    // already prove it via their own token/session.
    role: resolved.role,
    // Phase 4, item 3 — party-visible escalation/appeal status. Never
    // exposes reviewer identities or CaseReviewNote content, only
    // whether the case is currently under human review and why in
    // coarse terms.
    review: toPartyVisibleReviewStatus(kase.review),
    settlement: kase.settlement
      ? {
          status: kase.settlement.status,
          chain: kase.settlement.integration.chain,
          assetSymbol: kase.settlement.integration.assetSymbol,
          expectedAmountAtto: kase.settlement.expectedAmountAtto,
          claimantAddress: kase.settlement.claimantAddress,
          respondentAddress: kase.settlement.respondentAddress,
          // Added for the dedicated (non-embedded, signing-capable)
          // /public/cases/[id]/deposit page — see that route's own
          // header comment for why this is deliberately NOT exposed to
          // CasePanel.tsx/the embeddable widget, which stay
          // wallet-connect-free by design. escrowContractAddress/escrowId
          // are public on-chain facts (visible to anyone reading the
          // Escrow contract's own events), not secrets.
          escrowContractAddress: kase.settlement.integration.escrowContractAddress,
          escrowId: kase.settlement.escrowId,
          // Solana only — decision-relay's own program id, needed
          // client-side to derive the escrow_authority PDA that
          // initializeCase's `adjudicator` arg must be set to. Same
          // "public on-chain fact" justification as the two fields
          // above; null for Sepolia, where the deposit page never uses it.
          decisionRelayProgramId: kase.settlement.integration.chain === "solanatestnet" ? kase.settlementContract : null,
        }
      : null,
    evidence: kase.evidence.map((e) => ({
      id: e.id,
      type: e.type,
      storageRef: resolveEvidenceUri(e.storageRef, PUBLIC_EVIDENCE_URL_TTL_SECONDS, e.mimeType),
      mimeType: e.mimeType,
      createdAt: e.createdAt,
    })),
    decisions: kase.decisions.map((d) => ({
      outcome: d.outcome,
      claimantShareBps: d.claimantShareBps,
      respondentShareBps: d.respondentShareBps,
      reasonCodes: d.reasonCodes,
      consensus: d.consensus,
      appealWindowClosesAt: d.appealWindowClosesAt,
      createdAt: d.createdAt,
    })),
  });
}
