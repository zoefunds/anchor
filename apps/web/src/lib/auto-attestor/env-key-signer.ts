import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import type { KmsSigner } from "./kms-signer";

/**
 * A signer backed by a raw private key held in this process's own env —
 * same trust model as the existing backend attestor (ATTESTOR_PRIVATE_KEYS
 * in hyperlane.ts), NOT a KMS/HSM. Used for the two new automated signers
 * because, unlike a real KMS, this needs no new cloud account or billing
 * setup — the isolation it provides comes entirely from running as a
 * separate Fly app with its own secrets store, not from the key ever
 * leaving software custody. Naming this "Kms*"-shaped (implements the
 * same KmsSigner interface) so scripts/auto-attestor-sign.ts can treat
 * every backend identically regardless of custody model.
 */
export function createEnvKeySigner(params: { privateKey: Hex }): KmsSigner {
  const account = privateKeyToAccount(params.privateKey);
  return {
    address: account.address as Address,
    async sign(hash: Hex): Promise<Hex> {
      return account.sign({ hash });
    },
  };
}
