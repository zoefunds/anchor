import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey, KeyObject } from "crypto";

// Optional upgrade path on top of party-auth.ts's bearer tokens, toward
// real non-repudiation — audit finding: "bearer capabilities are still
// not identity... for real financial claims, bind parties to
// authenticated identities... or signed submissions."
//
// A bearer token proves "possesses the secret Anchor handed out" — it
// says nothing about who actually produced a given submission if the
// token itself leaked or was shared. A signature proves "controls the
// private key" for that ONE submission, which is what actually matters
// for non-repudiation: even if the bearer token later leaks, past
// signed submissions remain provably attributable, because forging a
// new one still requires the private key, not just the token.
//
// Deliberately additive, not a replacement: the raw signing private
// key is generated and shown once alongside the party token/link (same
// discipline as party-auth.ts), and every public route still accepts a
// bearer-token-only submission — a party who doesn't want to manage a
// keypair isn't blocked. A caller who DOES include a valid signature
// gets that submission marked as cryptographically verified (see
// Evidence.signatureVerified), which is meaningfully stronger evidence
// than bearer-token possession alone for anything downstream (an
// auditor, a dispute-about-the-dispute) that cares about attribution.
//
// Ed25519 (not secp256k1/EVM-style) — smaller keys/signatures, no
// dependency on a specific chain's curve, and Node's crypto module
// supports it natively (no extra dependency).

export interface PartySigningKeypair {
  /** hex-encoded raw 32-byte Ed25519 public key — stored on Case.claimantPublicKey/respondentPublicKey. */
  publicKeyHex: string;
  /** base64-encoded PKCS8 private key — shown to the party exactly once, never stored. */
  privateKeyBase64: string;
}

export function generatePartySigningKeypair(): PartySigningKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Raw 32-byte form for storage/display — much shorter than the
  // default SPKI DER encoding, and this is the standard "raw Ed25519
  // public key" shape most external signing tools expect.
  const publicKeyHex = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const privateKeyBase64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  return { publicKeyHex, privateKeyBase64 };
}

function publicKeyFromHex(publicKeyHex: string): KeyObject {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
    throw new Error(`publicKeyHex must be a 32-byte hex string, got: ${publicKeyHex}`);
  }
  // Re-wrap the raw 32-byte key in the minimal SPKI DER header Ed25519
  // keys use — Node's createPublicKey needs a recognized format, and
  // there's no "raw" input format for Ed25519 in this Node version.
  const rawKey = Buffer.from(publicKeyHex, "hex");
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([spkiPrefix, rawKey]), format: "der", type: "spki" });
}

/**
 * Verifies a base64-encoded Ed25519 signature over `message` against a
 * hex-encoded raw public key. Returns false (never throws) on any
 * malformed input — a public submission route calling this shouldn't
 * have to separately try/catch just to treat "garbage signature" the
 * same as "wrong signature."
 */
export function verifyPartySignature(publicKeyHex: string, message: string, signatureBase64: string): boolean {
  try {
    const publicKey = publicKeyFromHex(publicKeyHex);
    const signature = Buffer.from(signatureBase64, "base64");
    return edVerify(null, Buffer.from(message, "utf-8"), publicKey, signature);
  } catch {
    return false;
  }
}

/** Test/tooling helper — not used by any production route (a party signs client-side with their own private key, this backend never holds one). Kept here so the exact canonical signing scheme lives in one place, not re-derived ad hoc in tests. */
export function signWithPartyKey(privateKeyBase64: string, message: string): string {
  const privateKey = createPrivateKey({ key: Buffer.from(privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
  return edSign(null, Buffer.from(message, "utf-8"), privateKey).toString("base64");
}

/** Canonical message a party signs for an evidence submission — every field that actually matters for "what was submitted," nothing incidental (timestamps, request metadata) that would make a valid signature non-reproducible by the party's own tooling. */
export function evidenceSigningMessage(params: { caseId: string; type: string; content: string }): string {
  return JSON.stringify({ caseId: params.caseId, type: params.type, content: params.content });
}
