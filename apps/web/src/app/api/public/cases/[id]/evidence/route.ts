import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkEvidenceSubmittable } from "@/lib/evidence-validation";
import { resolvePartyToken } from "@/lib/party-auth";

// POST /api/public/cases/:id/evidence — a party submitting evidence
// directly, authenticated by their own per-case token (see
// lib/party-auth.ts), not an org session or API key. Body:
// { token, type, content }. `submittedBy` is never a caller-supplied
// field here (unlike the org-authenticated /api/cases/:id/evidence,
// where it's still just a self-asserted string) — it's set to whichever
// role the token actually resolved to, so "the claimant said X" is a
// claim backed by possessing the claimant's real secret, not a form
// field anyone with org write access could type in.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { token, type, content } = await req.json();
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "token is required" }, { status: 401 });
  }

  const resolved = await resolvePartyToken(token);
  if (!resolved || resolved.caseId !== params.id) {
    // Same 404 whether the token is simply invalid or valid-but-for-a-
    // different-case — don't help a caller distinguish "wrong token" from
    // "right token, wrong case" while probing.
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  if (!type || !content) {
    return NextResponse.json({ error: "type and content are required" }, { status: 400 });
  }

  const kase = await prisma.case.findUnique({
    where: { id: resolved.caseId },
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
