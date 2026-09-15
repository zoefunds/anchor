import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkEvidenceSubmittable } from "@/lib/evidence-validation";
import { resolvePartyAuth, PARTY_SESSION_COOKIE } from "@/lib/party-auth";
import { verifyPartySignature, evidenceSigningMessage } from "@/lib/party-signing";
import { logAction } from "@/lib/audit";

// POST /api/public/cases/:id/evidence — a party submitting evidence
// directly, authenticated by their own per-case token or an exchanged
// session cookie (see lib/party-auth.ts), not an org session or API
// key. Body: { token?, type, content, signature? }. `submittedBy` is
// never a caller-supplied field here (unlike the org-authenticated
// /api/cases/:id/evidence, where it's still just a self-asserted
// string) — it's set to whichever role actually resolved, so "the
// claimant said X" is a claim backed by possessing the claimant's real
// secret (or a session exchanged from it), not a form field anyone with
// org write access could type in.
//
// `signature` is optional — see lib/party-signing.ts. If present, it's
// verified against the resolving party's stored Ed25519 public key and
// this row is marked signatureVerified: a strictly stronger
// attribution claim than bearer-token possession alone (a leaked token
// can't be used to forge a new signed submission). Its absence doesn't
// block submission — the bearer token/session remains sufficient on
// its own, this is purely additive.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { token, type, content, signature } = await req.json();

  const sessionCookie = req.cookies.get(PARTY_SESSION_COOKIE)?.value;
  const resolved = await resolvePartyAuth(sessionCookie, typeof token === "string" ? token : undefined, (await params).id);
  if (!resolved) {
    // Same response whether the token/session is simply invalid or
    // valid-but-for-a-different-case — don't help a caller distinguish
    // "wrong" from "right, wrong case" while probing.
    return NextResponse.json({ error: "invalid token or session" }, { status: 401 });
  }

  if (!type || !content) {
    return NextResponse.json({ error: "type and content are required" }, { status: 400 });
  }

  const kase = await prisma.case.findUnique({
    where: { id: (await params).id },
    include: { evidence: true },
  });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const submitError = checkEvidenceSubmittable(kase, type, resolved.role);
  if (submitError) return submitError;

  let signatureVerified = false;
  if (typeof signature === "string" && signature.length > 0) {
    const publicKeyHex = resolved.role === "claimant" ? kase.claimantPublicKey : kase.respondentPublicKey;
    if (!publicKeyHex) {
      // This party's case predates signing keys, or never had one
      // issued — a signature that can't possibly be checked is treated
      // as absent, not as a submission-blocking error. The bearer
      // token already authenticated this request; a missing signing
      // key just means no extra attribution strength is available.
    } else {
      signatureVerified = verifyPartySignature(
        publicKeyHex,
        evidenceSigningMessage({ caseId: kase.id, type, content }),
        signature
      );
      if (!signatureVerified) {
        // Unlike a missing signature, a PRESENT-BUT-WRONG one is worth
        // rejecting outright — it usually means the caller's signing
        // code has a bug (wrong message format, stale key), and
        // silently downgrading to "unsigned" would hide that from
        // whoever's building the integration.
        return NextResponse.json({ error: "signature does not verify against the party's public key" }, { status: 401 });
      }
    }
  }

  const contentHash = createHash("sha256").update(content).digest("hex");

  // Real audit-completeness gap fixed here (external audit finding):
  // party-submitted evidence was never audited at all, unlike
  // org-authenticated submissions elsewhere in this project. Wrapped in
  // one transaction with the audit write; no memberId/apiKeyId here
  // since this is party-token auth, not org auth — the party's role
  // (real, resolved from their token — see this route's own header
  // comment) is recorded in the metadata instead.
  const evidence = await prisma.$transaction(async (tx) => {
    const created = await tx.evidence.create({
      data: {
        caseId: kase.id,
        type,
        contentHash,
        storageRef: content,
        submittedBy: resolved.role,
        attributionSource: resolved.role === "claimant" ? "claimant_authenticated" : "respondent_authenticated",
        signatureVerified,
      },
    });
    await logAction(
      {
        organizationId: kase.organizationId,
        action: "evidence.submitted",
        targetType: "evidence",
        targetId: created.id,
        metadata: { caseId: kase.id, type, contentHash, submittedBy: resolved.role, signatureVerified, source: "party" },
      },
      tx
    );
    return created;
  });

  return NextResponse.json(evidence, { status: 201 });
}
