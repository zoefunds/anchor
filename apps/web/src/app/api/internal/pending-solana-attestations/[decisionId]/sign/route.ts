import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { checkInternalSecret } from "@/lib/internal-auth";
import { isRegisteredSolanaAttestor, verifySolanaAttestationSignature, getSolanaAttestorThreshold, type SolanaAttestationRecord } from "@/lib/solana-settle";
import { recordSignerLifecycleEvent } from "@/lib/signer-lifecycle";

// POST /api/internal/pending-solana-attestations/[decisionId]/sign
// Body: { publicKey: "<base58>", signature: "0x..." (or bare hex) } —
// the Solana equivalent of POST
// /api/internal/pending-attestations/[decisionId]/sign (EVM). Unlike
// EVM's ECDSA (recoverable from just the signature), Ed25519 signatures
// aren't recoverable, so the caller must supply the signer's public key
// explicitly — this route verifies the signature actually matches that
// claimed key before ever storing anything (see
// verifySolanaAttestationSignature's own doc comment).
//
// The offline attestor holder produces this signature with, e.g., Node's
// built-in crypto (no npm install needed):
//   node -e 'const c=require("crypto");const priv=c.createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.from(require("fs").readFileSync("keypair.json","utf8")).slice(0,32)]),format:"der",type:"pkcs8"});console.log(c.sign(null,Buffer.from(process.argv[1],"hex"),priv).toString("hex"))' <messageHex>
// — see docs/multisig-attestor-setup.md's Solana section for the exact,
// tested command.
export async function POST(req: NextRequest, { params }: { params: Promise<{ decisionId: string }> }) {
  const authError = checkInternalSecret(req);
  if (authError) return authError;

  const { decisionId } = await params;
  const body = (await req.json().catch(() => null)) as { publicKey?: string; signature?: string } | null;
  const publicKey = body?.publicKey;
  const signature = body?.signature;
  if (!publicKey || !signature) {
    return NextResponse.json({ error: "body must be { publicKey: '<base58>', signature: '0x...' }" }, { status: 400 });
  }

  if (!isRegisteredSolanaAttestor(publicKey)) {
    return NextResponse.json({ error: `${publicKey} is not a registered Solana attestor — signature rejected` }, { status: 403 });
  }

  const decision = await prisma.decision.findUnique({ where: { id: decisionId } });
  if (!decision) {
    return NextResponse.json({ error: "decision not found" }, { status: 404 });
  }
  if (decision.relayTxHash) {
    return NextResponse.json({ error: "decision is already settled — no signature needed" }, { status: 409 });
  }
  if (!decision.pendingSolanaAttestationMessage) {
    return NextResponse.json({ error: "decision has no pending Solana attestation awaiting a signature" }, { status: 409 });
  }

  // Verify the signature is real BEFORE storing anything — a forged or
  // malformed signature is rejected outright, never persisted, mirroring
  // the EVM route's recoverAddress-then-isRegisteredAttestor ordering.
  const valid = verifySolanaAttestationSignature(publicKey, decision.pendingSolanaAttestationMessage, signature);
  if (!valid) {
    return NextResponse.json({ error: "signature does not verify against this decision's pending attestation message" }, { status: 400 });
  }

  const publicKeyBase64 = publicKeyToBase64(publicKey);
  const existing = (decision.pendingSolanaAttestations as SolanaAttestationRecord[] | null) ?? [];
  if (existing.some((a) => a.publicKey === publicKeyBase64)) {
    return NextResponse.json({ error: `signer ${publicKey} has already submitted a signature for this decision` }, { status: 409 });
  }

  const record: SolanaAttestationRecord = {
    publicKey: publicKeyBase64,
    signature: hexToBase64(signature),
  };
  const updatedList = [...existing, record];

  // Deliberately does NOT attempt dispatch itself — same reasoning as
  // the EVM sign route: this runs on Vercel, which never holds
  // SOLANA_ATTESTOR_PRIVATE_KEY/SOLANA_RELAY_PRIVATE_KEY. The worker's
  // retryFailedSettlements sweep picks up the newly-stored signature.
  await prisma.decision.update({
    where: { id: decisionId },
    data: { pendingSolanaAttestations: updatedList as unknown as Prisma.InputJsonValue },
  });

  const threshold = getSolanaAttestorThreshold();
  await recordSignerLifecycleEvent({
    decisionId,
    chain: "solanatestnet",
    // +1 accounts for the backend's own key, which isn't stored in
    // pendingSolanaAttestations but always contributes one signature at
    // dispatch time — see solana-settle.ts's submitAttestedSettle.
    state: updatedList.length + 1 >= threshold ? "QUORUM_REACHED" : "SIGNING",
    signerAddress: publicKey,
    reason: `${updatedList.length}/${threshold - 1} external signatures collected`,
  });

  return NextResponse.json({
    signerPublicKey: publicKey,
    collectedExternalSignatures: updatedList.length,
    note: "settlement completes within ~10 minutes via the worker's periodic sweep once enough signatures are collected",
  });
}

/** Decodes a base58 Solana public key to its raw 32 bytes, base64-encoded — matches the encoding ExternalSolanaAttestation.publicKey (a raw Uint8Array) expects once read back in adjudication-service.ts, NOT a re-encoding of the base58 string itself. */
function publicKeyToBase64(base58PublicKey: string): string {
  return Buffer.from(new PublicKey(base58PublicKey).toBytes()).toString("base64");
}

function hexToBase64(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(clean, "hex").toString("base64");
}
