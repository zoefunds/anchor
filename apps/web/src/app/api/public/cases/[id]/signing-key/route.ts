import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePartyAuth, PARTY_SESSION_COOKIE } from "@/lib/party-auth";
import { logAction } from "@/lib/audit";

// POST /api/public/cases/:id/signing-key — a party self-registers their
// OWN Ed25519 public key (generated client-side — a browser's
// crypto.subtle, a CLI tool, a wallet's own key derivation, whatever the
// party already controls). Body: { token?, publicKeyHex }.
//
// This is deliberately the ONLY way a case's claimantPublicKey/
// respondentPublicKey gets set now — case creation used to generate a
// keypair server-side and hand the party its own private key, which
// defeats the actual point of signing: if Anchor generated the key, it
// briefly held it, and "the party's signature" is only as trustworthy as
// "Anchor didn't misuse a key it had in memory for a moment." A party
// that registers a public key it generated itself, and Anchor never
// sees the private half of, gets a real non-repudiation claim: a valid
// signature can only have come from whoever holds that private key, and
// Anchor was never in a position to forge one.
//
// Authenticated the same way as evidence submission (bearer token or
// exchanged session — see lib/party-auth.ts), since registering a
// signing key is exactly as sensitive an action as submitting evidence:
// whoever can do this can bind cryptographic identity to a role in this
// case. Re-registering overwrites the previous key for that role (same
// trust boundary as reissuing a party token) and is logged.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { token, publicKeyHex } = await req.json().catch(() => ({ token: undefined, publicKeyHex: undefined }));

  const sessionCookie = req.cookies.get(PARTY_SESSION_COOKIE)?.value;
  const resolved = await resolvePartyAuth(sessionCookie, typeof token === "string" ? token : undefined, params.id);
  if (!resolved) {
    return NextResponse.json({ error: "invalid token or session" }, { status: 401 });
  }

  if (typeof publicKeyHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
    return NextResponse.json({ error: "publicKeyHex must be a 32-byte hex string (raw Ed25519 public key)" }, { status: 400 });
  }

  const kase = await prisma.case.findUnique({ where: { id: params.id } });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const field = resolved.role === "claimant" ? "claimantPublicKey" : "respondentPublicKey";
  // Security-audit fix: this used to allow silent re-registration
  // ("same trust boundary as reissuing a party token"). That made
  // signature verification elsewhere (settlement-address) meaningless
  // against the exact threat it's meant to guard: if only the bearer
  // token leaks, an attacker could use it to register THEIR OWN key
  // here first, then sign later requests with it and pass verification
  // trivially. Write-once closes that — whichever key registers first
  // for a role is the one that can ever sign for it, matching the same
  // "first real claim wins" pattern this codebase already uses for
  // escrowId (Escrow.sol) and deposit authorization.
  if (kase[field]) {
    return NextResponse.json({ error: `a signing key is already registered for ${resolved.role} on this case and cannot be replaced` }, { status: 409 });
  }
  await prisma.$transaction(async (tx) => {
    await tx.case.update({
      where: { id: params.id },
      data: { [field]: publicKeyHex.toLowerCase() },
    });
    await logAction(
      {
        organizationId: kase.organizationId,
        action: "case.signing_key_registered",
        targetType: "case",
        targetId: kase.id,
        metadata: { role: resolved.role },
      },
      tx
    );
  });

  return NextResponse.json({ role: resolved.role, publicKeyHex: publicKeyHex.toLowerCase() });
}
