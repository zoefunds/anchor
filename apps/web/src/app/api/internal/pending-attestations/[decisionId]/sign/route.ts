import { NextRequest, NextResponse } from "next/server";
import { recoverAddress, isHex, type Address, type Hex } from "viem";
import { prisma } from "@/lib/prisma";
import { checkInternalSecret } from "@/lib/internal-auth";
import { isRegisteredAttestor, countValidDistinctSigners, getAttestorThreshold } from "@/lib/hyperlane";
import { recordSignerLifecycleEvent } from "@/lib/signer-lifecycle";

// POST /api/internal/pending-attestations/[decisionId]/sign
// Body: { signature: "0x..." } — a 65-byte ECDSA signature over the
// decision's own pendingAttestationHash, produced OFFLINE by an
// external attestor holder (see docs/multisig-attestor-setup.md):
//   cast wallet sign --private-key <key> --no-hash <attestationHash>
// The private key itself never touches this backend — only the
// resulting signature does, which by itself authorizes nothing beyond
// this one specific decision's exact content (see
// DecisionRelay.sol's attestation hash binding).
export async function POST(req: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const authError = checkInternalSecret(req);
  if (authError) return authError;

  const { decisionId } = await params;
  const body = (await req.json().catch(() => null)) as { signature?: string } | null;
  const signature = body?.signature;
  if (!signature || !isHex(signature) || signature.length !== 132) {
    // 132 = "0x" + 65 bytes * 2 hex chars — same 65-byte (r,s,v) shape DecisionRelay.sol's _recoverSigner requires.
    return NextResponse.json({ error: "body must be { signature: '0x...' }, a 65-byte hex signature" }, { status: 400 });
  }

  const decision = await prisma.decision.findUnique({
    where: { id: decisionId },
    include: { case: { select: { settlementContract: true } } },
  });
  if (!decision) {
    return NextResponse.json({ error: "decision not found" }, { status: 404 });
  }
  if (decision.relayTxHash) {
    return NextResponse.json({ error: "decision is already settled, no signature needed" }, { status: 409 });
  }
  if (!decision.pendingAttestationHash || !decision.case.settlementContract) {
    return NextResponse.json({ error: "decision has no pending attestation awaiting a signature" }, { status: 409 });
  }

  const relayAddress = decision.case.settlementContract as Address;
  const attestationHash = decision.pendingAttestationHash as Hex;

  let recovered: Address;
  try {
    recovered = await recoverAddress({ hash: attestationHash, signature: signature as Hex });
  } catch {
    return NextResponse.json({ error: "could not recover a signer address from this signature, is it over the right hash?" }, { status: 400 });
  }

  const registered = await isRegisteredAttestor(relayAddress, recovered);
  if (!registered) {
    return NextResponse.json(
      { error: `recovered address ${recovered} is not a registered attestor on ${relayAddress} — signature rejected` },
      { status: 403 }
    );
  }

  // Dedup by RECOVERED SIGNER, not raw signature bytes — a re-audit
  // correctly flagged that the same key can produce more than one
  // valid-but-different signature encoding over the same hash (ECDSA
  // isn't deterministic by default; even with RFC 6979 deterministic
  // nonces, a different signing implementation could still produce a
  // different valid (r,s,v)), so byte-equality alone lets one signer's
  // signature be stored twice under different bytes and inflate the
  // apparent distinct-signer count. Recover every ALREADY-stored
  // signature's signer and reject a new one from the same address
  // outright — one signer contributes at most one stored signature,
  // ever, for this decision.
  const existingRecovered = await Promise.all(
    decision.pendingAttestationSignatures.map(async (sig) => {
      try {
        return await recoverAddress({ hash: attestationHash, signature: sig as Hex });
      } catch {
        return null;
      }
    })
  );
  if (existingRecovered.some((addr) => addr?.toLowerCase() === recovered.toLowerCase())) {
    return NextResponse.json({ error: `signer ${recovered} has already submitted a signature for this decision` }, { status: 409 });
  }

  // Deliberately does NOT attempt dispatch itself: this route runs on
  // Vercel (the Next.js app deployment), which never holds
  // HYPERLANE_RELAY_PRIVATE_KEY/ATTESTOR_PRIVATE_KEYS — only the Fly
  // worker (anc-hor-worker) does, since it's the only process meant to
  // actually move funds. retryFailedSettlements' sweep there (every 10
  // minutes — see lib/worker.ts) picks up the newly-stored signature and
  // completes dispatch as soon as enough are collected.
  const updated = await prisma.decision.update({
    where: { id: decisionId },
    data: { pendingAttestationSignatures: { push: signature } },
    select: { pendingAttestationSignatures: true },
  });

  // Reported count is DISTINCT VALID REGISTERED signers (revalidated
  // against the live isAttestor mapping right now), never raw array
  // length — see countValidDistinctSigners's own doc comment. This also
  // means a signature from an attestor governance has since removed
  // stops counting immediately, without needing any cleanup step here.
  const { validCount } = await countValidDistinctSigners(relayAddress, attestationHash, updated.pendingAttestationSignatures as Hex[]);

  const threshold = await getAttestorThreshold(relayAddress);
  await recordSignerLifecycleEvent({
    decisionId,
    chain: "sepolia",
    state: validCount >= threshold ? "QUORUM_REACHED" : "SIGNING",
    signerAddress: recovered,
    reason: `${validCount}/${threshold} signatures collected`,
  });

  return NextResponse.json({
    signerAddress: recovered,
    collectedExternalSignatures: validCount,
    note: "settlement completes within ~10 minutes via the worker's periodic sweep once enough signatures are collected",
  });
}
