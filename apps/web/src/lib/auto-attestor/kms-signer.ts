// Automated attestor signer backed by a cloud KMS (AWS or GCP), never a raw
// env-var private key. Produces the exact same signature shape the existing
// backend attestor produces (see hyperlane.ts's getAttestorAccounts ->
// account.sign({hash})) — a 65-byte (r,s,v) hex signature over the raw
// attestation hash, recoverable via viem's recoverAddress({hash, signature}).
// This is what /api/internal/pending-attestations/[decisionId]/sign expects.
//
// KMS returns a DER-encoded (r,s) ECDSA signature and never tells you the
// recovery id (v) — Ethereum's secp256k1 signatures need it to make address
// recovery unambiguous. This module derives it by trying both candidates
// and checking which one recovers to the signer's own known address (read
// once via KMS's public-key export, at startup).
import { secp256k1 } from "@noble/curves/secp256k1";
import { recoverAddress, type Address, type Hex } from "viem";

export interface KmsSigner {
  /** The Ethereum address this signer signs as — derived from the KMS-held public key, never from a private key this process holds. */
  address: Address;
  /** Signs `hash` (the attestation hash) and returns a 65-byte (r,s,v) hex signature recoverable to `address`. */
  sign(hash: Hex): Promise<Hex>;
}

function derToRS(der: Uint8Array): { r: bigint; s: bigint } {
  // Minimal DER SEQUENCE(INTEGER r, INTEGER s) parser — KMS's Sign API
  // response format for ECC_SECG_P256K1 / EC_SIGN_SECP256K1_SHA256 keys.
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("kms signature: expected DER SEQUENCE");
  let seqLen = der[offset++];
  if (seqLen & 0x80) {
    const nBytes = seqLen & 0x7f;
    seqLen = 0;
    for (let i = 0; i < nBytes; i++) seqLen = (seqLen << 8) | der[offset++];
  }
  function readInt(): bigint {
    if (der[offset++] !== 0x02) throw new Error("kms signature: expected DER INTEGER");
    let len = der[offset++];
    if (len & 0x80) {
      const nBytes = len & 0x7f;
      len = 0;
      for (let i = 0; i < nBytes; i++) len = (len << 8) | der[offset++];
    }
    const bytes = der.slice(offset, offset + len);
    offset += len;
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    return v;
  }
  const r = readInt();
  const s = readInt();
  return { r, s };
}

const SECP256K1_N = secp256k1.CURVE.n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

function toHex32(v: bigint): string {
  return v.toString(16).padStart(64, "0");
}

/** Builds a viem-compatible 65-byte (r,s,v) signature from a raw DER ECDSA signature, trying both recovery ids against `expectedAddress`. KMS signatures are not canonicalized to low-s, so this also normalizes s (required for the recovery-id search to be exhaustive and for on-chain acceptance, matching secp256k1's standard convention). */
export async function derSignatureToEthSignature(
  der: Uint8Array,
  hash: Hex,
  expectedAddress: Address
): Promise<Hex> {
  let { r, s } = derToRS(der);
  if (s > SECP256K1_HALF_N) s = SECP256K1_N - s; // canonical low-s form

  for (const recId of [0, 1] as const) {
    const v = recId + 27;
    const candidate = (`0x${toHex32(r)}${toHex32(s)}${v.toString(16).padStart(2, "0")}`) as Hex;
    try {
      const recovered = await recoverAddress({ hash, signature: candidate });
      if (recovered.toLowerCase() === expectedAddress.toLowerCase()) {
        return candidate;
      }
    } catch {
      // wrong recovery id can produce an invalid point — try the other one
    }
  }
  throw new Error(
    `kms signature did not recover to expected address ${expectedAddress} for hash ${hash} — check the KMS key is secp256k1 and the public-key derivation matches`
  );
}
