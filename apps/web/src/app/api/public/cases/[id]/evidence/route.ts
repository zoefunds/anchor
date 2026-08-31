import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkEvidenceSubmittable } from "@/lib/evidence-validation";
import { resolvePartyAuth, PARTY_SESSION_COOKIE } from "@/lib/party-auth";

// POST /api/public/cases/:id/evidence — a party submitting evidence
// directly, authenticated by their own per-case token or an exchanged
// session cookie (see lib/party-auth.ts), not an org session or API
// key. Body: { token?, type, content }. `submittedBy` is never a
// caller-supplied field here (unlike the org-authenticated
// /api/cases/:id/evidence, where it's still just a self-asserted
// string) — it's set to whichever role actually resolved, so "the
// claimant said X" is a claim backed by possessing the claimant's real
// secret (or a session exchanged from it), not a form field anyone with
// org write access could type in.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { token, type, content } = await req.json();

  const sessionCookie = req.cookies.get(PARTY_SESSION_COOKIE)?.value;
  const resolved = await resolvePartyAuth(sessionCookie, typeof token === "string" ? token : undefined, params.id);
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
    where: { id: params.id },
    include: { evidence: true },
  });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const submitError = checkEvidenceSubmittable(kase, type);
  if (submitError) return submitError;

  const contentHash = createHash("sha256").update(content).digest("hex");

  const evidence = await prisma.evidence.create({
    data: {
      caseId: kase.id,
      type,
      contentHash,
      storageRef: content,
      submittedBy: resolved.role,
    },
  });

  return NextResponse.json(evidence, { status: 201 });
}
