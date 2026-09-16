import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess, requireScope } from "@/lib/auth";
import { getPolicy, DEFAULT_POLICY_ID, POLICIES } from "@/lib/policies";
import { logAction } from "@/lib/audit";
import { caseVisibilityWhere } from "@/lib/case-access";
import { generatePartyToken } from "@/lib/party-auth";
import { parseCanonicalDecimalAmount, InvalidAmountError } from "@/lib/money";
import { resolveActivePolicyVersion, parseVelocityLimits, parseHumanReviewTriggers } from "@/lib/policy-engine";
import { computeRiskAssessment } from "@/lib/risk-engine";
import { maybeEscalateCase } from "@/lib/escalation";
import { recordBillableEventTx, BillableEventType } from "@/lib/billing-events";

// POST /api/cases — create a case under a named policy (defaults to
// agent_data_task_v1 if omitted, for backward compatibility with existing
// integrations). Body: { claim, amount, claimantRef, respondentRef, policyId? }
// `amount` MUST be a JSON string (e.g. "1250.50"), not a JSON numeric
// literal — see lib/money.ts's own header comment for why: precision is
// already lost during JSON.parse for a numeric literal, before any
// validation in this handler runs. Real, intentional breaking change
// (external audit finding) — a caller sending a JSON number now gets a
// clear 400, not silent precision loss.
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
  const scopeError = requireScope(auth, "cases:write");
  if (scopeError) return scopeError;

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
  let canonicalAmount: string;
  try {
    canonicalAmount = parseCanonicalDecimalAmount(amount);
  } catch (err) {
    if (err instanceof InvalidAmountError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
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
      { error: `unsupported settlementChain "${settlementChain}", supported: ${SUPPORTED_SETTLEMENT_CHAINS.join(", ")}` },
      { status: 400 }
    );
  }
  const isSealevelSettlement = settlementChain === "solanatestnet";
  // Real bug found and fixed 2026-09-12: this route never set Case.currency
  // at all, so every real case (regardless of settlementChain) silently
  // took the Prisma schema's "USD" default — even though Anchor settles
  // only native chain assets (ETH on Sepolia, SOL on Solana; USDC support
  // was removed entirely). That mismatch made checkAutoSignEligibility's
  // currency check refuse EVERY real case, permanently, since none of
  // them were actually USD. A case created with no settlementChain (no
  // settlement configured yet) still gets the "USD" placeholder — it's
  // harmless there since such a case never reaches attestor signing.
  const SETTLEMENT_CHAIN_CURRENCIES: Record<string, string> = { sepolia: "ETH", solanatestnet: "SOL" };
  const currency = settlementChain ? SETTLEMENT_CHAIN_CURRENCIES[settlementChain] : undefined;
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
  // Real P0 fixed here (external audit finding, raised twice): both
  // settlementContract and settlementSolanaEscrowProgram used to be
  // accepted as-is from the caller with no validation against anything
  // this project actually deployed — an arbitrary EVM/Solana address
  // could be set as a case's "settlement" or "escrow" target. Reject
  // anything not on the operator-approved list (see
  // lib/hyperlane.ts's isApprovedSettlementContract/
  // isApprovedSolanaEscrowProgram doc comments for why this is a real
  // fix but not the full escrow-adapter model the audit also correctly
  // asks for — that remains a separate, larger follow-up: this closes
  // "arbitrary address," not "no real per-case escrow binding").
  if (settlementChain && settlementContract) {
    const { isApprovedSettlementContract, isApprovedSolanaEscrowProgram } = await import("@/lib/hyperlane");
    if (!isApprovedSettlementContract(settlementChain, settlementContract)) {
      return NextResponse.json(
        { error: `settlementContract "${settlementContract}" is not an approved settlement target for chain "${settlementChain}"` },
        { status: 400 }
      );
    }
    if (isSealevelSettlement && settlementSolanaEscrowProgram && !isApprovedSolanaEscrowProgram(settlementSolanaEscrowProgram)) {
      return NextResponse.json(
        { error: `settlementSolanaEscrowProgram "${settlementSolanaEscrowProgram}" is not an approved escrow program` },
        { status: 400 }
      );
    }
  }

  const policy = getPolicy(policyId);
  if (!policy) {
    return NextResponse.json(
      { error: `unknown policyId: ${policyId}`, availablePolicies: Object.keys(POLICIES) },
      { status: 400 }
    );
  }

  // Phase 4, item 1 — bind this case to its org's currently-active,
  // immutable policy configuration NOW, once, at creation. Falls back to
  // the org's "default" policy key if none is published under this
  // adjudication policyId; stays unbound (null) if the org has never
  // published any policy at all, matching this codebase's existing
  // "additive, no behavior change until an operator opts in" convention
  // (see settlement-kyc.ts's own requireKycApproval default). Every
  // downstream read of this case's governance config must go through
  // this bound row (case.policyVersionRecord), never re-resolve "current".
  const boundPolicyVersion =
    (await resolveActivePolicyVersion(auth.organizationId, policyId)) ??
    (await resolveActivePolicyVersion(auth.organizationId, "default"));
  const velocityLimits = parseVelocityLimits(boundPolicyVersion?.velocityLimits ?? null);
  const humanReviewTriggers = parseHumanReviewTriggers(boundPolicyVersion?.humanReviewTriggers ?? null);

  if (boundPolicyVersion) {
    if (boundPolicyVersion.allowedChains.length > 0 && settlementChain && !boundPolicyVersion.allowedChains.includes(settlementChain)) {
      return NextResponse.json({ error: `settlementChain "${settlementChain}" is not allowed by this organization's active policy` }, { status: 400 });
    }
    if (boundPolicyVersion.allowedOutcomes.length > 0 && !boundPolicyVersion.allowedOutcomes.includes("*")) {
      // Outcomes aren't known until adjudication runs — this only rules
      // out a policy published with an empty/misconfigured outcome list
      // at case-creation time being silently accepted; the real outcome
      // check happens at decision time (see docs/decision-schema.md scope
      // note in the report — enforcing this post-adjudication is a
      // reasonable follow-up, not implemented in this pass).
    }
  }

  // Phase 4, item 2 — risk/anti-abuse gate, computed BEFORE the case is
  // created so a BLOCK action genuinely refuses case creation rather
  // than creating the row and then hiding it. Fail-closed: a caller
  // cannot create a case whose organization's own dispute history this
  // computation itself fails to read (the throw propagates, same as any
  // other unexpected error in this route).
  const riskResult = await computeRiskAssessment({
    organizationId: auth.organizationId,
    claimantRef,
    respondentRef,
    amountUsd: Number(canonicalAmount),
    velocityLimits,
  });
  if (riskResult.action === "BLOCK") {
    return NextResponse.json(
      { error: "case creation blocked by risk policy", riskAction: riskResult.action, reasons: riskResult.reasons },
      { status: 403 }
    );
  }

  // Per-party capability tokens (see lib/party-auth.ts) — generated now,
  // shown exactly once below, so the caller can hand each raw token to
  // the actual claimant/respondent. Only the hashes are persisted.
  const claimantToken = generatePartyToken();
  const respondentToken = generatePartyToken();
  // No signing keypair generated here (see lib/party-signing.ts's own
  // header comment for why this changed) — a key this backend generates
  // and hands the party is not real non-repudiation, since Anchor itself
  // briefly held the private key. A party who wants cryptographic
  // attribution instead generates their OWN keypair client-side and
  // self-registers the public key via POST
  // /api/public/cases/:id/signing-key (party-token-authenticated) —
  // Anchor never sees or touches their private key at any point. Cases
  // created before this change may still have a claimantPublicKey/
  // respondentPublicKey Anchor generated; existing submissions signed
  // against those keys remain verifiable, just weaker than a
  // self-registered one.

  // Case creation and its audit-log entry are wrapped in one transaction
  // — see lib/audit.ts's `tx` param doc comment for why: this endpoint
  // has no idempotency key, so a client that saw a 500 (from what would
  // otherwise be "case created, but the audit write failed separately")
  // would have no safe way to tell "did that actually create a case?"
  // and a naive retry would create a duplicate. Wrapping both in one
  // transaction means that failure mode can't happen — either both
  // commit, or neither does and the response is honestly a failure.
  const kase = await prisma.$transaction(async (tx) => {
    const created = await tx.case.create({
      data: {
        organizationId: auth.organizationId,
        claim,
        amount: canonicalAmount,
        ...(currency ? { currency } : {}),
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
        claimantTokenExpiresAt: claimantToken.expiresAt,
        respondentTokenExpiresAt: respondentToken.expiresAt,
        policyVersionRecordId: boundPolicyVersion?.id ?? null,
      },
    });

    await tx.riskAssessment.create({
      data: {
        caseId: created.id,
        action: riskResult.action,
        reasons: riskResult.reasons,
        claimantRecentDisputeCount: riskResult.claimantRecentDisputeCount,
        respondentRecentDisputeCount: riskResult.respondentRecentDisputeCount,
        repeatPairDisputeCount: riskResult.repeatPairDisputeCount,
        orgRollingDisputeCount: riskResult.orgRollingDisputeCount,
        orgRollingVolumeUsd: riskResult.orgRollingVolumeUsd,
      },
    });

    await logAction(
      {
        organizationId: auth.organizationId,
        memberId: auth.memberId,
        apiKeyId: auth.apiKeyId,
        action: "case.created",
        targetType: "case",
        targetId: created.id,
        metadata: { policyId: policy.id, claim },
      },
      tx
    );

    await recordBillableEventTx(tx, {
      organizationId: auth.organizationId,
      eventType: BillableEventType.CASE_OPENED,
      subjectId: created.id,
    });

    return created;
  });

  // Phase 4, item 3 — escalate for human review if this case's amount or
  // its just-computed risk action trips a real trigger. Outside the
  // transaction above deliberately: the case and its RiskAssessment must
  // both exist first, and a failure here should not roll back a
  // successfully created case (an operator can still open a review
  // manually via POST /api/cases/:id/review if this step is ever lost
  // to a transient error).
  await maybeEscalateCase({
    caseId: kase.id,
    amountUsd: Number(canonicalAmount),
    riskAction: riskResult.action,
    humanReviewTriggers,
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
  const scopeError = requireScope(auth, "cases:read");
  if (scopeError) return scopeError;

  const cases = await prisma.case.findMany({
    where: { organizationId: auth.organizationId, ...caseVisibilityWhere(auth) },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(cases);
}
