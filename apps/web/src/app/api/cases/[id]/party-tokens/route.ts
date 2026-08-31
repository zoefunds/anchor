import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess } from "@/lib/auth";
import { canAccessCase } from "@/lib/case-access";
import { generatePartyToken } from "@/lib/party-auth";
import { logAction } from "@/lib/audit";

// POST /api/cases/:id/party-tokens — reissues one or both party capability
// tokens (see lib/party-auth.ts). Body: { role?: "claimant" | "respondent" }
// — omit to reissue both. Reissuing invalidates whatever raw token that
// role held before (its hash no longer matches anything), the same way
// rotating an API key invalidates the old one — use this if a token was
// shared with the wrong recipient or is suspected leaked.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;

  const kase = await prisma.case.findUnique({ where: { id: params.id } });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const { role } = await req.json().catch(() => ({ role: undefined }));
  const reissueClaimant = role === undefined || role === "claimant";
  const reissueRespondent = role === undefined || role === "respondent";
  if (!reissueClaimant && !reissueRespondent) {
    return NextResponse.json({ error: 'role must be "claimant" or "respondent" if provided' }, { status: 400 });
  }

  const claimantToken = reissueClaimant ? generatePartyToken() : null;
  const respondentToken = reissueRespondent ? generatePartyToken() : null;

  await prisma.case.update({
    where: { id: kase.id },
    data: {
      ...(claimantToken ? { claimantTokenHash: claimantToken.hash } : {}),
      ...(respondentToken ? { respondentTokenHash: respondentToken.hash } : {}),
    },
  });

  logAction({
    organizationId: auth.organizationId,
    memberId: auth.memberId,
    apiKeyId: auth.apiKeyId,
    action: "case.party_tokens_reissued",
    targetType: "case",
    targetId: kase.id,
    metadata: { reissuedClaimant: reissueClaimant, reissuedRespondent: reissueRespondent },
  });

  return NextResponse.json({
    claimantToken: claimantToken?.raw,
    respondentToken: respondentToken?.raw,
  });
}
