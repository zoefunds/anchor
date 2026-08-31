import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess } from "@/lib/auth";
import { getPolicy, DEFAULT_POLICY_ID, POLICIES } from "@/lib/policies";
import { logAction } from "@/lib/audit";
import { caseVisibilityWhere } from "@/lib/case-access";
import { generatePartyToken } from "@/lib/party-auth";

// POST /api/cases — create a case under a named policy (defaults to
// agent_data_task_v1 if omitted, for backward compatibility with existing
// integrations). Body: { claim, amount, claimantRef, respondentRef, policyId? }
// claimantRef/respondentRef must already be pseudonymous refs — Anchor
// never stores real party identity on the case record itself (see
// packages/types privacy note); the mapping to a real account lives in a
// separate identity table, not modeled yet in this MVP schema.
//
// Auth: either an API key (Authorization: Bearer ak_live_...) for agent/
// programmatic callers, or a dashboard session cookie for humans — see
// lib/auth.ts. Every case is scoped to the caller's organization.
export async function POST(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;

  const body = await req.json();
  const {
    claim,
    amount,
    claimantRef,
    respondentRef,
    policyId = DEFAULT_POLICY_ID,
    settlementChain,
    settlementContract,
    settlementSolanaClaimant,
    settlementSolanaRespondent,
    settlementSolanaEscrowProgram,
    settlementSolanaCaseId,
  } = body;

  if (!claim || !amount || !claimantRef || !respondentRef) {
    return NextResponse.json(
      { error: "claim, amount, claimantRef, respondentRef are required" },
      { status: 400 }
    );
  }
  const amountNumber = Number(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
  }
  const SUPPORTED_SETTLEMENT_CHAINS = ["sepolia", "solanatestnet"];
  // Both or neither — a settlement target only makes sense as a pair, and
  // half-configuring it would silently never dispatch (see
  // adjudication-service.ts's check) rather than error loudly here.
  if (Boolean(settlementChain) !== Boolean(settlementContract)) {
    return NextResponse.json(
      { error: "settlementChain and settlementContract must be provided together" },
      { status: 400 }
    );
  }
  if (settlementChain && !SUPPORTED_SETTLEMENT_CHAINS.includes(settlementChain)) {
    return NextResponse.json(
      { error: `unsupported settlementChain "${settlementChain}" — supported: ${SUPPORTED_SETTLEMENT_CHAINS.join(", ")}` },
      { status: 400 }
    );
  }
  const isSealevelSettlement = settlementChain === "solanatestnet";
  if (
    isSealevelSettlement &&
    (!settlementSolanaClaimant || !settlementSolanaRespondent || !settlementSolanaEscrowProgram || !settlementSolanaCaseId)
  ) {
    return NextResponse.json(
      {
        error:
          "settlementSolanaClaimant, settlementSolanaRespondent, settlementSolanaEscrowProgram, and settlementSolanaCaseId are required when settlementChain is a Solana chain",
      },
      { status: 400 }
    );
  }

  const policy = getPolicy(policyId);
  if (!policy) {
    return NextResponse.json(
      { error: `unknown policyId: ${policyId}`, availablePolicies: Object.keys(POLICIES) },
      { status: 400 }
    );
  }

  // Per-party capability tokens (see lib/party-auth.ts) — generated now,
  // shown exactly once below, so the caller can hand each raw token to
  // the actual claimant/respondent. Only the hashes are persisted.
  const claimantToken = generatePartyToken();
  const respondentToken = generatePartyToken();

  const kase = await prisma.case.create({
    data: {
      organizationId: auth.organizationId,
      claim,
      amount,
      claimantRef,
      respondentRef,
      policyId: policy.id,
      policyVersion: policy.version,
      status: "EVIDENCE_COLLECTION",
      settlementChain: settlementChain || null,
      settlementContract: settlementContract || null,
      settlementSolanaClaimant: isSealevelSettlement ? settlementSolanaClaimant : null,
      settlementSolanaRespondent: isSealevelSettlement ? settlementSolanaRespondent : null,
      settlementSolanaEscrowProgram: isSealevelSettlement ? settlementSolanaEscrowProgram : null,
      settlementSolanaCaseId: isSealevelSettlement ? settlementSolanaCaseId : null,
      claimantTokenHash: claimantToken.hash,
      respondentTokenHash: respondentToken.hash,
    },
  });

  logAction({
    organizationId: auth.organizationId,
    memberId: auth.memberId,
    apiKeyId: auth.apiKeyId,
    action: "case.created",
    targetType: "case",
    targetId: kase.id,
    metadata: { policyId: policy.id, claim },
  });

  // Hashes aren't secret, but echoing them back is just noise the caller
  // never needs — the raw tokens below are the only thing that matters.
  const { claimantTokenHash: _claimantTokenHash, respondentTokenHash: _respondentTokenHash, ...kaseWithoutHashes } = kase;
  return NextResponse.json(
    {
      ...kaseWithoutHashes,
      // Shown once — not retrievable again (only the hashes are stored).
      // A caller that loses these needs POST /api/cases/:id/party-tokens
      // to reissue fresh ones (invalidating whichever old token that role
      // had).
      claimantToken: claimantToken.raw,
      respondentToken: respondentToken.raw,
    },
    { status: 201 }
  );
}

export async function GET(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }

  const cases = await prisma.case.findMany({
    where: { organizationId: auth.organizationId, ...caseVisibilityWhere(auth) },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(cases);
}
