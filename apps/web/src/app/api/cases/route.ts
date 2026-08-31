import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess } from "@/lib/auth";
import { getPolicy, DEFAULT_POLICY_ID, POLICIES } from "@/lib/policies";
import { logAction } from "@/lib/audit";

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

  return NextResponse.json(kase, { status: 201 });
}

export async function GET(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }

  const cases = await prisma.case.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(cases);
}
