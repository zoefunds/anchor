import { KeyManagementServiceClient } from "@google-cloud/kms";
import { createPublicKey } from "crypto";
import { publicKeyToAddress } from "viem/utils";
import type { Address, Hex } from "viem";
import { derSignatureToEthSignature } from "./kms-signer";
import type { KmsSigner } from "./kms-signer";

/** Same SPKI-to-address derivation as the AWS signer — GCP's exported public key is PEM, converted to DER SPKI via Node's crypto, then the trailing 65-byte uncompressed point is read off exactly like the AWS case. */
function pemToEthAddress(pem: string): Address {
  const spkiDer = createPublicKey(pem).export({ type: "spki", format: "der" });
  const point = spkiDer.subarray(spkiDer.length - 65);
  if (point[0] !== 0x04) {
    throw new Error("gcp kms public key: expected uncompressed EC point (0x04 prefix) in SPKI");
  }
  const pubKeyHex = `0x${Buffer.from(point).toString("hex")}` as Hex;
  return publicKeyToAddress(pubKeyHex);
}

export async function createGcpKmsSigner(params: {
  /** Full resource name, e.g. projects/P/locations/L/keyRings/R/cryptoKeys/K/cryptoKeyVersions/1 */
  keyVersionName: string;
}): Promise<KmsSigner> {
  const client = new KeyManagementServiceClient();

  const [publicKey] = await client.getPublicKey({ name: params.keyVersionName });
  if (!publicKey.pem) throw new Error(`gcp kms: getPublicKey returned no PEM for ${params.keyVersionName}`);
  const address = pemToEthAddress(publicKey.pem);

  return {
    address,
    async sign(hash: Hex): Promise<Hex> {
      const digest = Buffer.from(hash.slice(2), "hex");
      // GCP's digest field is a passthrough for the raw 32 bytes to sign —
      // it does not re-hash them, regardless of the field name (see e.g.
      // established GCP-KMS-for-Ethereum signing patterns). Our digest is
      // keccak256, not literally SHA-256, but the key's algorithm
      // (EC_SIGN_SECP256K1_SHA256) only fixes the curve for this purpose.
      const [signResponse] = await client.asymmetricSign({
        name: params.keyVersionName,
        digest: { sha256: digest },
      });
      if (!signResponse.signature) throw new Error(`gcp kms: asymmetricSign returned no signature for ${params.keyVersionName}`);
      return derSignatureToEthSignature(signResponse.signature as Uint8Array, hash, address);
    },
  };
}
