import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePartyAuth, PARTY_SESSION_COOKIE } from "@/lib/party-auth";
import { normalizeSettlementAddress, authorizeDepositOnChain } from "@/lib/case-settlement";
import { verifyPartySignature, settlementAddressSigningMessage } from "@/lib/party-signing";
import { logAction } from "@/lib/audit";

// POST /api/public/cases/:id/settlement-address — a party setting
// their OWN payout address, authenticated the same way party evidence
// submission is (their own token or an exchanged session — see
// lib/party-auth.ts), never a form field staff fills in on their
// behalf. This is the real fix for how CaseSettlement.claimantAddress/
// respondentAddress used to get set this session: by hand, from
// whatever address a human pasted into chat. Body: { token?, address, signature? }.
//
// Security-audit fix: a bearer token alone proves "possesses the
// secret Anchor handed out," not "controls the wallet being named" —
// a leaked/forwarded token could otherwise redirect a real payout
// address. Once a party has registered a signing key (write-once —
// see signing-key/route.ts), `signature` becomes REQUIRED here and is
// verified against it; a party who never registered a key can still
// use the bearer-token-only path (lib/party-signing.ts's own
// "additive, not a replacement" design), but once a key exists, token
// possession alone is no longer sufficient for this specific,
// fund-directing action.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { token, address, signature } = await req.json();

  const sessionCookie = req.cookies.get(PARTY_SESSION_COOKIE)?.value;
  const resolved = await resolvePartyAuth(sessionCookie, typeof token === "string" ? token : undefined, (await params).id);
  if (!resolved) {
    return NextResponse.json({ error: "invalid token or session" }, { status: 401 });
  }

  const kase = await prisma.case.findUnique({ where: { id: (await params).id }, include: { settlement: true } });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const normalized = normalizeSettlementAddress(kase.settlementChain ?? "", address);
  if (!normalized) {
    return NextResponse.json(
      { error: kase.settlementChain === "solanatestnet" ? "address must be a valid base58 Solana pubkey" : "address must be a valid EVM address" },
      { status: 400 }
    );
  }

  const publicKeyField = resolved.role === "claimant" ? "claimantPublicKey" : "respondentPublicKey";
  const registeredPublicKey = kase[publicKeyField];
  if (registeredPublicKey) {
    if (typeof signature !== "string" || signature.length === 0) {
      return NextResponse.json(
        { error: `a signing key is registered for ${resolved.role} on this case — a valid signature is required to set the settlement address, a bearer token alone is no longer sufficient` },
        { status: 401 }
      );
    }
    const message = settlementAddressSigningMessage({ caseId: kase.id, role: resolved.role, address: normalized });
    if (!verifyPartySignature(registeredPublicKey, message, signature)) {
      return NextResponse.json({ error: "signature does not verify against the registered signing key for this role" }, { status: 401 });
    }
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
  // Security-audit fix (finding #2): once both addresses are set, the
  // real on-chain authorizeDeposit() call below locks them in
  // permanently (Escrow.sol's authorization is one-shot per escrowId —
  // it cannot be re-authorized with different values). Allowing a
  // further address change past that point would silently desync the
  // app's record from what the chain will actually ever pay out to.
  if (settlement.claimantAddress && settlement.respondentAddress) {
    return NextResponse.json({ error: "both settlement addresses are already set and locked in — this can no longer be changed" }, { status: 409 });
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

  // Fire the real on-chain authorization once both addresses are now
  // set — best-effort here (logged, not thrown back to the party): a
  // failure leaves depositAuthorizedAt null, which checkAndConfirmDeposit
  // and the reconciliation sweep can both surface/retry rather than
  // this route silently swallowing it with no trace.
  if (updated.claimantAddress && updated.respondentAddress) {
    try {
      const authResult = await authorizeDepositOnChain(settlement.id);
      if (authResult.outcome === "not_ready") {
        // eslint-disable-next-line no-console
        console.error(`authorizeDepositOnChain: CaseSettlement ${settlement.id} not ready despite both addresses appearing set: ${authResult.reason}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`authorizeDepositOnChain failed for CaseSettlement ${settlement.id} — deposit will be blocked until this is retried`, err);
    }
  }

  return NextResponse.json({ role: resolved.role, address: normalized, settlement: updated });
}
