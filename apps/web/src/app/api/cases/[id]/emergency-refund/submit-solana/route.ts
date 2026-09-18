import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { canAccessCase } from "@/lib/case-access";
import { submitEmergencyRefund, InsufficientSolanaAttestationsError, isRegisteredSolanaAttestor, type ExternalSolanaAttestation } from "@/lib/solana-settle";
import { logAction } from "@/lib/audit";
import { dispatchWebhookEvent } from "@/lib/webhooks";

// POST /api/cases/:id/emergency-refund/submit-solana — the Solana-only
// counterpart to the EVM emergency-refund page's "run this cast command
// yourself" step. See prepare/route.ts's own doc comment for exactly
// why the two chains are asymmetric here: decision-relay's
// emergency_refund, like attested_settle, can only ever be submitted by
// Anchor's own backend (it needs SOLANA_RELAY_PRIVATE_KEY to pay fees
// and the backend's own attestor key), so there is no equivalent of
// "the org runs this themselves" for Solana. This route is that
// backend-side submission, gated the same OWNER-only way as
// prepare/route.ts — it still requires a genuinely valid, externally-
// collected M-of-N attestor signature before it will do anything;
// supplying zero external attestations here throws the same
// InsufficientSolanaAttestationsError the automated settlement path
// throws, not a bypass.
//
// Body: { externalAttestations: [{ publicKey: string (base58), signature: string (hex, 0x-prefixed) }] }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.error === "forbidden" ? 403 : 401 });
  }

  const kase = await prisma.case.findUnique({ where: { id: (await params).id } });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  if (kase.settlementChain !== "solanatestnet") {
    return NextResponse.json({ error: `this case's settlement chain is ${kase.settlementChain ?? "none"}, not solanatestnet — use the EVM emergency-refund page's cast command instead` }, { status: 409 });
  }
  if (!kase.settlementContract || !kase.settlementSolanaEscrowProgram || !kase.settlementSolanaClaimant || !kase.settlementSolanaCaseId) {
    return NextResponse.json({ error: "this case has no complete Solana settlement configuration" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const rawAttestations = Array.isArray(body.externalAttestations) ? body.externalAttestations : [];
  const externalAttestations: ExternalSolanaAttestation[] = [];
  for (const a of rawAttestations) {
    if (typeof a.publicKey !== "string" || typeof a.signature !== "string") continue;
    if (!isRegisteredSolanaAttestor(a.publicKey)) {
      return NextResponse.json({ error: `${a.publicKey} is not a registered Solana attestor` }, { status: 400 });
    }
    let publicKeyBytes: Uint8Array;
    try {
      publicKeyBytes = new (await import("@solana/web3.js")).PublicKey(a.publicKey).toBytes();
    } catch {
      return NextResponse.json({ error: `${a.publicKey} is not a valid base58 public key` }, { status: 400 });
    }
    const sigHex = a.signature.startsWith("0x") ? a.signature.slice(2) : a.signature;
    const signatureBytes = Buffer.from(sigHex, "hex");
    if (signatureBytes.length !== 64) {
      return NextResponse.json({ error: `signature for ${a.publicKey} must be 64 raw bytes` }, { status: 400 });
    }
    externalAttestations.push({ publicKey: publicKeyBytes, signature: signatureBytes });
  }

  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    return NextResponse.json({ error: "SOLANA_RPC_URL is not configured" }, { status: 500 });
  }

  try {
    const { signature } = await submitEmergencyRefund(
      {
        decisionRelayProgramId: kase.settlementContract,
        caseId: kase.settlementSolanaCaseId,
        claimant: kase.settlementSolanaClaimant,
        escrowProgram: kase.settlementSolanaEscrowProgram,
      },
      rpcUrl,
      externalAttestations
    );

    // Matches reconciliation.ts's own EVM emergency-refund detection
    // path exactly: CaseSettlement.status becomes "SETTLED" either way
    // (a real adjudicated settlement or an emergency refund both mean
    // "the escrowed funds have moved, nothing left to reconcile") — the
    // escrow program's own Case.status ("Refunded" vs "Settled") is
    // where the real distinction lives on-chain.
    await prisma.caseSettlement.updateMany({
      where: { caseId: kase.id },
      data: { status: "SETTLED", settledAt: new Date() },
    });

    await logAction({
      organizationId: auth.organizationId,
      memberId: auth.memberId,
      action: "case.emergency_refund_submitted",
      targetType: "Case",
      targetId: kase.id,
      metadata: { caseId: kase.id, chain: "solanatestnet", signature },
    });
    dispatchWebhookEvent({
      organizationId: auth.organizationId,
      event: "case.emergency_refund_settled",
      data: { caseId: kase.id, chain: "solanatestnet", signature },
    });

    return NextResponse.json({ signature });
  } catch (err) {
    if (err instanceof InsufficientSolanaAttestationsError) {
      return NextResponse.json(
        { error: err.message, messageHex: err.messageHex, collectedCount: err.collectedCount, threshold: err.threshold },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
