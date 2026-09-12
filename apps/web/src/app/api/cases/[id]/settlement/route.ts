import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireOwner, requireScope } from "@/lib/auth";
import { canAccessCase } from "@/lib/case-access";
import { logAction } from "@/lib/audit";
import { toAtomicAmount } from "@/lib/money";
import { deriveEscrowIdForCase, assertEscrowBoundToDecisionRelay, SettlementIntegrationError } from "@/lib/case-settlement";
import { assertSolanaEscrowBoundToDecisionRelay, toLamports, SolanaEscrowError } from "@/lib/solana-escrow";

// GET /api/cases/:id/settlement — current binding/deposit/settlement
// state for this case, if any.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "settlements:read");
  if (scopeError) return scopeError;

  const kase = await prisma.case.findUnique({ where: { id: params.id }, include: { settlement: { include: { integration: true } } } });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  return NextResponse.json(kase.settlement);
}

// POST /api/cases/:id/settlement — bind a case to a settlement
// integration, creating its CaseSettlement in PENDING_DEPOSIT.
// Deliberately does NOT accept claimant/respondent addresses in this
// body — those only ever come from each party themselves, via
// /api/public/cases/:id/settlement-address (see lib/party-auth.ts).
// Staff choose WHICH integration a case settles through; they don't
// choose whose wallet gets paid.
//
// Security-audit fix: OWNER-only (was requireWriteAccess, which any
// MEMBER or API key passed) — this decision picks which real escrow
// contract a case's funds flow through, the same real financial
// authority creating/deactivating the integration itself already
// requires (see settlement-integrations/route.ts). API keys never
// pass requireOwner at all, matching how webhooks/members/audit-log
// are already OWNER-only, session-only actions.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireOwner();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.error === "forbidden" ? 403 : 401 });
  }

  const kase = await prisma.case.findUnique({ where: { id: params.id }, include: { settlement: true } });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  if (kase.settlement) {
    return NextResponse.json({ error: "this case already has a settlement binding" }, { status: 409 });
  }
  if (!kase.settlementChain || !kase.settlementContract) {
    return NextResponse.json(
      { error: "case has no settlementChain/settlementContract configured — set those before binding a settlement integration" },
      { status: 400 }
    );
  }

  const { integrationId } = await req.json();
  if (typeof integrationId !== "string" || integrationId.length === 0) {
    return NextResponse.json({ error: "integrationId is required" }, { status: 400 });
  }
  const integration = await prisma.settlementIntegration.findUnique({ where: { id: integrationId } });
  if (!integration || integration.organizationId !== auth.organizationId) {
    return NextResponse.json({ error: "settlement integration not found" }, { status: 404 });
  }
  if (!integration.active) {
    return NextResponse.json({ error: "this settlement integration is not active" }, { status: 409 });
  }
  if (integration.chain !== kase.settlementChain) {
    return NextResponse.json({ error: `integration chain (${integration.chain}) does not match case settlementChain (${kase.settlementChain})` }, { status: 400 });
  }

  try {
    if (integration.chain === "solanatestnet") {
      await assertSolanaEscrowBoundToDecisionRelay({
        escrowProgramId: integration.escrowContractAddress,
        decisionRelayProgramId: kase.settlementContract,
      });
    } else {
      await assertEscrowBoundToDecisionRelay({
        chain: integration.chain,
        escrowContractAddress: integration.escrowContractAddress as `0x${string}`,
        expectedDecisionRelayAddress: kase.settlementContract as `0x${string}`,
      });
    }
  } catch (err) {
    if (err instanceof SettlementIntegrationError || err instanceof SolanaEscrowError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: `could not verify escrow contract on-chain: ${(err as Error).message}` }, { status: 502 });
  }

  // Real bug fixed 2026-09-12: this used to call toAttoAmount
  // unconditionally for every non-Solana integration, hardcoding 18
  // decimals. Reads integration.assetDecimals (set per-integration at
  // registration time, see settlement-integrations/route.ts) instead
  // of assuming 18 — every EVM integration today is native ETH (18
  // decimals), so this evaluates the same way it always did, but it no
  // longer silently re-hardcodes that assumption into the code itself.
  const expectedAmountAtto =
    integration.chain === "solanatestnet"
      ? toLamports(kase.amount.toString()).toString()
      : toAtomicAmount(kase.amount.toString(), integration.assetDecimals).toString();
  const escrowId = deriveEscrowIdForCase(kase);

  const settlement = await prisma.$transaction(async (tx) => {
    const created = await tx.caseSettlement.create({
      data: {
        caseId: kase.id,
        integrationId: integration.id,
        escrowId,
        expectedAmountAtto,
      },
    });
    await logAction(
      {
        organizationId: auth.organizationId,
        memberId: auth.memberId,
        action: "case_settlement.bound",
        targetType: "CaseSettlement",
        targetId: created.id,
        metadata: { caseId: kase.id, integrationId: integration.id, escrowId, expectedAmountAtto },
      },
      tx
    );
    return created;
  });

  return NextResponse.json(settlement, { status: 201 });
}
