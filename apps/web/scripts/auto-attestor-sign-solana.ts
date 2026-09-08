// Automated Solana attestor signer — the Solana-side counterpart to
// scripts/auto-attestor-sign.ts (EVM). Added 2026-09-07 after a real
// Studio Next migration E2E test sat blocked for hours waiting on the
// old fully-offline second Solana attestor key — Solana settlements had
// no automation at all until this script, unlike the EVM side. Polls
// for decisions awaiting a Solana attestation, checks the same policy
// gate (amount cap) as the EVM signer, signs with a Node-native Ed25519
// key held in this process's own env (never a KMS/HSM — see
// lib/auto-attestor/env-key-signer.ts's own note on why that's an
// accepted tradeoff here), and submits via the same
// /api/internal/pending-solana-attestations/[decisionId]/sign route an
// offline human held previously used by hand.
//
// Required env (same ANCHOR_API_BASE_URL/ATTESTOR_COSIGN_SECRET/
// AUTO_ATTESTOR_MAX_AMOUNT_USD/DATABASE_URL/POLL_INTERVAL_MS as the EVM
// script — this runs as a SECOND process alongside it on the same Fly
// app, sharing those):
//   AUTO_ATTESTOR_SOLANA_PRIVATE_KEY   JSON array of the 64-byte secret
//                                      key (solana-keygen's own format,
//                                      same as SOLANA_ATTESTOR_PRIVATE_KEY)
import { createPrivateKey, createPublicKey, sign as cryptoSign } from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { prisma } from "@/lib/prisma";
import { checkAutoSignEligibility } from "@/lib/auto-attestor/policy";
import { assertSolanaSignerRegistered, StartupCheckError } from "@/lib/startup-checks";
import { sendOpsAlert } from "@/lib/alerts";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function loadKeypair(): { publicKeyBase58: string; sign: (messageHex: string) => string } {
  const raw = process.env.AUTO_ATTESTOR_SOLANA_PRIVATE_KEY;
  if (!raw) throw new Error("AUTO_ATTESTOR_SOLANA_PRIVATE_KEY is required — a JSON array of the 64-byte secret key");
  const secretKey = Uint8Array.from(JSON.parse(raw));
  const keypair = Keypair.fromSecretKey(secretKey);
  const seed = Buffer.from(secretKey.slice(0, 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  return {
    publicKeyBase58: keypair.publicKey.toBase58(),
    sign: (messageHex: string) => {
      const message = Buffer.from(messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex, "hex");
      return cryptoSign(null, message, privateKey).toString("hex");
    },
  };
}

async function processOnce(signer: ReturnType<typeof loadKeypair>, apiBaseUrl: string, cosignSecret: string) {
  const candidates = await prisma.decision.findMany({
    where: { pendingSolanaAttestationMessage: { not: null }, relayTxHash: null },
    select: { id: true, pendingSolanaAttestationMessage: true, pendingSolanaAttestations: true },
  });

  for (const decision of candidates) {
    const already = (decision.pendingSolanaAttestations as { publicKey: string }[] | null) ?? [];
    const publicKeyBuffer = new PublicKey(signer.publicKeyBase58).toBytes();
    const publicKeyBase64 = Buffer.from(publicKeyBuffer).toString("base64");
    if (already.some((a) => a.publicKey === publicKeyBase64)) continue;

    const eligibility = await checkAutoSignEligibility(decision.id);
    if (!eligibility.eligible) {
      console.log(`[auto-attestor-solana] skipping decision ${decision.id}: ${eligibility.reason}`);
      continue;
    }

    const signature = "0x" + signer.sign(decision.pendingSolanaAttestationMessage as string);

    const res = await fetch(`${apiBaseUrl}/api/internal/pending-solana-attestations/${decision.id}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cosignSecret}` },
      body: JSON.stringify({ publicKey: signer.publicKeyBase58, signature }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`[auto-attestor-solana] decision ${decision.id}: sign submission failed (${res.status}):`, body);
      continue;
    }
    console.log(`[auto-attestor-solana] decision ${decision.id}: signed as ${signer.publicKeyBase58} — ${JSON.stringify(body)}`);
  }
}

async function main() {
  const apiBaseUrl = process.env.ANCHOR_API_BASE_URL;
  const cosignSecret = process.env.ATTESTOR_COSIGN_SECRET;
  if (!apiBaseUrl) throw new Error("ANCHOR_API_BASE_URL is required");
  if (!cosignSecret) throw new Error("ATTESTOR_COSIGN_SECRET is required");

  const signer = loadKeypair();

  // Phase 1, item 1 — see lib/startup-checks.ts.
  assertSolanaSignerRegistered(signer.publicKeyBase58);

  console.log(`[auto-attestor-solana] started — signing as ${signer.publicKeyBase58}`);

  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? 60000);
  for (;;) {
    try {
      await processOnce(signer, apiBaseUrl, cosignSecret);
    } catch (err) {
      console.error("[auto-attestor-solana] poll iteration failed:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

main().catch(async (err) => {
  console.error(err);
  if (err instanceof StartupCheckError) {
    await sendOpsAlert({
      severity: "critical",
      title: "Solana attestor refused to start: signer/quorum invariant violated",
      detail: `${err.message}\nSee docs/runbooks/signer-failure.md.`,
    }).catch((alertErr) => console.error("[auto-attestor-solana] failed to deliver startup-check-failure alert", alertErr));
  }
  process.exit(1);
});
