// Automated attestor signer — polls for decisions awaiting attestor
// signatures, checks policy (see lib/auto-attestor/policy.ts), signs
// with a cloud-KMS-held key (never a raw private key in this process's
// env), and submits the signature via the same
// /api/internal/pending-attestations/[decisionId]/sign route an offline
// human attestor previously used by hand.
//
// Run as its OWN deployment (a separate Fly app / GCP Cloud Run job —
// see docs/mainnet-readiness-runbook.md's automated-attestor section),
// never co-located with the main worker or web app: the whole point is
// that this key lives in a different blast radius than
// ATTESTOR_PRIVATE_KEYS on anc-hor-worker.
//
// Required env:
//   ANCHOR_API_BASE_URL          e.g. https://anc-hor.vercel.app
//   ATTESTOR_COSIGN_SECRET       shared secret (see lib/internal-auth.ts)
//   AUTO_ATTESTOR_MAX_AMOUNT_USD policy cap — see lib/auto-attestor/policy.ts
//   AUTO_ATTESTOR_BACKEND        "aws" | "gcp"
//   AUTO_ATTESTOR_AWS_KMS_KEY_ID   (when AUTO_ATTESTOR_BACKEND=aws)
//   AUTO_ATTESTOR_GCP_KMS_KEY_VERSION_NAME (when AUTO_ATTESTOR_BACKEND=gcp)
//   DATABASE_URL                 read-only access is sufficient
//   POLL_INTERVAL_MS             default 60000
import { prisma } from "@/lib/prisma";
import { checkAutoSignEligibility } from "@/lib/auto-attestor/policy";
import { createAwsKmsSigner } from "@/lib/auto-attestor/aws-kms-signer";
import { createGcpKmsSigner } from "@/lib/auto-attestor/gcp-kms-signer";
import { createEnvKeySigner } from "@/lib/auto-attestor/env-key-signer";
import type { KmsSigner } from "@/lib/auto-attestor/kms-signer";
import { recoverAddress, isHex, type Hex } from "viem";

async function createSigner(): Promise<KmsSigner> {
  const backend = process.env.AUTO_ATTESTOR_BACKEND;
  if (backend === "aws") {
    const keyId = process.env.AUTO_ATTESTOR_AWS_KMS_KEY_ID;
    if (!keyId) throw new Error("AUTO_ATTESTOR_AWS_KMS_KEY_ID is required when AUTO_ATTESTOR_BACKEND=aws");
    return createAwsKmsSigner({ keyId });
  }
  if (backend === "gcp") {
    const keyVersionName = process.env.AUTO_ATTESTOR_GCP_KMS_KEY_VERSION_NAME;
    if (!keyVersionName) throw new Error("AUTO_ATTESTOR_GCP_KMS_KEY_VERSION_NAME is required when AUTO_ATTESTOR_BACKEND=gcp");
    return createGcpKmsSigner({ keyVersionName });
  }
  if (backend === "env") {
    const privateKey = process.env.AUTO_ATTESTOR_PRIVATE_KEY;
    if (!privateKey || !isHex(privateKey)) throw new Error("AUTO_ATTESTOR_PRIVATE_KEY is required (0x-prefixed hex) when AUTO_ATTESTOR_BACKEND=env");
    return createEnvKeySigner({ privateKey });
  }
  throw new Error(`AUTO_ATTESTOR_BACKEND must be "aws", "gcp", or "env", got: ${backend}`);
}

async function processOnce(signer: KmsSigner, apiBaseUrl: string, cosignSecret: string) {
  // Candidates: attestation pending, not yet settled, not already signed
  // by this signer (checked below by recovering each stored signature —
  // mirrors the sign route's own dedup, done here too so this process
  // doesn't keep retrying and logging noise for decisions it already
  // signed).
  const candidates = await prisma.decision.findMany({
    where: { pendingAttestationHash: { not: null }, relayTxHash: null },
    select: { id: true, pendingAttestationHash: true, pendingAttestationSignatures: true },
  });

  for (const decision of candidates) {
    const hash = decision.pendingAttestationHash as Hex;

    const alreadySigned = await Promise.all(
      decision.pendingAttestationSignatures.map(async (sig) => {
        try {
          return (await recoverAddress({ hash, signature: sig as Hex })).toLowerCase() === signer.address.toLowerCase();
        } catch {
          return false;
        }
      })
    );
    if (alreadySigned.some(Boolean)) continue;

    const eligibility = await checkAutoSignEligibility(decision.id);
    if (!eligibility.eligible) {
      console.log(`[auto-attestor] skipping decision ${decision.id}: ${eligibility.reason}`);
      continue;
    }

    const signature = await signer.sign(hash);

    const res = await fetch(`${apiBaseUrl}/api/internal/pending-attestations/${decision.id}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cosignSecret}` },
      body: JSON.stringify({ signature }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`[auto-attestor] decision ${decision.id}: sign submission failed (${res.status}):`, body);
      continue;
    }
    console.log(`[auto-attestor] decision ${decision.id}: signed as ${signer.address} — ${JSON.stringify(body)}`);
  }
}

async function main() {
  const apiBaseUrl = process.env.ANCHOR_API_BASE_URL;
  const cosignSecret = process.env.ATTESTOR_COSIGN_SECRET;
  if (!apiBaseUrl) throw new Error("ANCHOR_API_BASE_URL is required");
  if (!cosignSecret) throw new Error("ATTESTOR_COSIGN_SECRET is required");

  const signer = await createSigner();
  console.log(`[auto-attestor] started — signing as ${signer.address} (backend: ${process.env.AUTO_ATTESTOR_BACKEND})`);

  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 60000);
  for (;;) {
    try {
      await processOnce(signer, apiBaseUrl, cosignSecret);
    } catch (err) {
      console.error("[auto-attestor] poll iteration failed:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
