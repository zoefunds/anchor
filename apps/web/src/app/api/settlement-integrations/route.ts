import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { normalizeEvmAddress, SettlementIntegrationError } from "@/lib/case-settlement";
import { detectEscrowVersion, UnknownEscrowVersionError } from "@/lib/escrow-version";
import { EscrowCodeIdentityError } from "@/lib/escrow-code-identity";

const SUPPORTED_CHAINS = ["sepolia"] as const;

// GET /api/settlement-integrations — list this org's settlement
// integrations. OWNER-only, matching webhooks: an integration names a
// real escrow contract funds actually move through, not a read a
// MEMBER/VIEWER needs day to day for case work.
export async function GET() {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const integrations = await prisma.settlementIntegration.findMany({
    where: { organizationId: member.organizationId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(integrations);
}

// POST /api/settlement-integrations — register a new escrow contract
// as a settlement target. Body: { chain, escrowContractAddress,
// decisionRelayAddress, assetSymbol, assetDecimals, requireKycApproval? }.
//
// decisionRelayAddress is required here even though it isn't stored on
// SettlementIntegration itself — it exists only so this route can do a
// real on-chain check (escrow.decisionRelay() === decisionRelayAddress)
// before the integration is ever usable, catching a fat-fingered or
// unrelated escrow address at registration time rather than only
// discovering it later when a case tries to bind to it. Each case
// still separately re-verifies its own settlementContract matches at
// bind time — this is a fast, early sanity check, not a substitute.
export async function POST(req: NextRequest) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const body = await req.json();
  const { chain, decisionRelayAddress, assetSymbol, assetDecimals, requireKycApproval } = body;

  if (!SUPPORTED_CHAINS.includes(chain)) {
    return NextResponse.json({ error: `chain must be one of: ${SUPPORTED_CHAINS.join(", ")}` }, { status: 400 });
  }
  const escrowContractAddress = normalizeEvmAddress(body.escrowContractAddress);
  if (!escrowContractAddress) {
    return NextResponse.json({ error: "escrowContractAddress must be a valid EVM address" }, { status: 400 });
  }
  const relayAddress = normalizeEvmAddress(decisionRelayAddress);
  if (!relayAddress) {
    return NextResponse.json({ error: "decisionRelayAddress must be a valid EVM address" }, { status: 400 });
  }
  if (typeof assetSymbol !== "string" || assetSymbol.length === 0) {
    return NextResponse.json({ error: "assetSymbol is required" }, { status: 400 });
  }
  if (typeof assetDecimals !== "number" || !Number.isInteger(assetDecimals) || assetDecimals < 0 || assetDecimals > 36) {
    return NextResponse.json({ error: "assetDecimals must be an integer between 0 and 36" }, { status: 400 });
  }

  const { assertEscrowBoundToDecisionRelay } = await import("@/lib/case-settlement");
  try {
    await assertEscrowBoundToDecisionRelay({
      chain,
      escrowContractAddress,
      expectedDecisionRelayAddress: relayAddress,
    });
  } catch (err) {
    if (err instanceof SettlementIntegrationError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: `could not verify escrow contract on-chain: ${(err as Error).message}` }, { status: 502 });
  }

  // Priority 2: the escrow's real ABI shape is established here, once,
  // from the contract's own live behavior — never assumed. An address
  // whose deposits() doesn't match a known shape is rejected outright
  // (fail-closed), not registered with a best-guess ABI.
  let escrowVersion: "V1" | "V2";
  try {
    escrowVersion = await detectEscrowVersion(escrowContractAddress);
  } catch (err) {
    if (err instanceof UnknownEscrowVersionError || err instanceof EscrowCodeIdentityError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: `could not detect escrow contract version: ${(err as Error).message}` }, { status: 502 });
  }

  const integration = await prisma.$transaction(async (tx) => {
    const created = await tx.settlementIntegration.create({
      data: {
        organizationId: member.organizationId,
        chain,
        escrowContractAddress,
        assetSymbol,
        assetDecimals,
        requireKycApproval: requireKycApproval === true,
        escrowVersion,
        createdByMemberId: member.memberId,
      },
    });
    await logAction(
      {
        organizationId: member.organizationId,
        memberId: member.memberId,
        action: "settlement_integration.created",
        targetType: "SettlementIntegration",
        targetId: created.id,
        metadata: { chain, escrowContractAddress, decisionRelayAddress: relayAddress, assetSymbol, requireKycApproval: created.requireKycApproval, escrowVersion },
      },
      tx
    );
    return created;
  });

  return NextResponse.json(integration, { status: 201 });
}
