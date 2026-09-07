import { KMSClient, GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { publicKeyToAddress } from "viem/utils";
import type { Address, Hex } from "viem";
import { derSignatureToEthSignature } from "./kms-signer";
import type { KmsSigner } from "./kms-signer";

/** Derives the Ethereum address for an AWS KMS ECC_SECG_P256K1 key from its SubjectPublicKeyInfo (DER, ASN.1) — the last 65 bytes of the SPKI's BIT STRING are the uncompressed EC point (0x04 || X || Y), which is exactly what viem's publicKeyToAddress expects. */
function spkiToEthAddress(spkiDer: Uint8Array): Address {
  // The uncompressed point always starts with 0x04 and is 65 bytes —
  // find it from the end rather than parsing full ASN.1 (KMS's SPKI
  // header length varies slightly by key type but the point is fixed).
  const point = spkiDer.slice(spkiDer.length - 65);
  if (point[0] !== 0x04) {
    throw new Error("aws kms public key: expected uncompressed EC point (0x04 prefix) in SPKI");
  }
  const pubKeyHex = `0x${Buffer.from(point).toString("hex")}` as Hex;
  return publicKeyToAddress(pubKeyHex);
}

export async function createAwsKmsSigner(params: { keyId: string; region?: string }): Promise<KmsSigner> {
  const client = new KMSClient({ region: params.region ?? process.env.AWS_REGION ?? "us-east-1" });

  const pub = await client.send(new GetPublicKeyCommand({ KeyId: params.keyId }));
  if (!pub.PublicKey) throw new Error(`aws kms: GetPublicKey returned no key material for ${params.keyId}`);
  const address = spkiToEthAddress(pub.PublicKey);

  return {
    address,
    async sign(hash: Hex): Promise<Hex> {
      const messageBytes = Buffer.from(hash.slice(2), "hex");
      const result = await client.send(
        new SignCommand({
          KeyId: params.keyId,
          Message: messageBytes,
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_256",
        })
      );
      if (!result.Signature) throw new Error(`aws kms: Sign returned no signature for ${params.keyId}`);
      return derSignatureToEthSignature(result.Signature, hash, address);
    },
  };
}
