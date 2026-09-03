import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePartyAuth, PARTY_SESSION_COOKIE } from "@/lib/party-auth";
import { normalizeEvmAddress } from "@/lib/case-settlement";
import { logAction } from "@/lib/audit";

// POST /api/public/cases/:id/settlement-address — a party setting
// their OWN payout address, authenticated the same way party evidence
// submission is (their own token or an exchanged session — see
// lib/party-auth.ts), never a form field staff fills in on their
// behalf. This is the real fix for how CaseSettlement.claimantAddress/
// respondentAddress used to get set this session: by hand, from
// whatever address a human pasted into chat. Body: { token?, address }.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { token, address } = await req.json();

  const sessionCookie = req.cookies.get(PARTY_SESSION_COOKIE)?.value;
  const resolved = await resolvePartyAuth(sessionCookie, typeof token === "string" ? token : undefined, params.id);
  if (!resolved) {
    return NextResponse.json({ error: "invalid token or session" }, { status: 401 });
  }

  const normalized = normalizeEvmAddress(address);
  if (!normalized) {
    return NextResponse.json({ error: "address must be a valid EVM address" }, { status: 400 });
  }

  const kase = await prisma.case.findUnique({ where: { id: params.id }, include: { settlement: true } });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  const settlement = kase.settlement;
  if (!settlement) {
    return NextResponse.json({ error: "this case has no settlement binding yet — nothing to set an address on" }, { status: 409 });
  }
  // Once a deposit is confirmed on-chain, the addresses that deposit is
  // locked to are exactly what Escrow.sol will ever pay out to — a
  // party changing their mind afterward would just silently stop
  // matching the real on-chain deposit at settle time. Refuse rather
  // than accept a write that can never take effect.
  if (settlement.status !== "PENDING_DEPOSIT") {
    return NextResponse.json({ error: `settlement is already ${settlement.status} — the address can no longer be changed` }, { status: 409 });
  }

  const field = resolved.role === "claimant" ? "claimantAddress" : "respondentAddress";
  const setAtField = resolved.role === "claimant" ? "claimantAddressSetAt" : "respondentAddressSetAt";

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.caseSettlement.update({
      where: { id: settlement.id },
      data: { [field]: normalized, [setAtField]: new Date() },
    });
    await logAction(
      {
        organizationId: kase.organizationId,
        action: "case_settlement.party_address_set",
        targetType: "CaseSettlement",
        targetId: settlement.id,
        metadata: { caseId: kase.id, role: resolved.role, address: normalized },
      },
      tx
    );
    return result;
  });

  return NextResponse.json({ role: resolved.role, address: normalized, settlement: updated });
}
