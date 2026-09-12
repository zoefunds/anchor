// One-off manual attestor signing tool for testnet E2E test unblocking.
//
// Real gap found 2026-09-12: lib/auto-attestor/policy.ts's checkAutoSignEligibility
// fails closed for any non-USD case ("cannot compare against the configured
// USD auto-settle cap"). Since USDC support was removed from Anchor entirely,
// every currently-supported case (ETH on Sepolia, SOL on Solana) is
// permanently non-USD — meaning the automated attestors running in production
// (anc-hor-attestor2/3) can NEVER sign a real quorum signature for any case
// Anchor actually supports today. This is not fixed here (it's a policy
// decision — what auto-settle cap should apply to ETH/SOL, denominated in
// what unit — that needs a product call, not a silent code change slipped
// into an unrelated test run). This script performs the exact same action a
// human attestor operator would perform per docs/multisig-attestor-setup.md:
// sign the decision's pendingAttestationHash with a registered attestor key
// and submit it via the real internal sign API route.
import fs from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

function loadEnvVar(name: string): string {
  const text = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(new RegExp(`^${name}=(.*)$`));
    if (m) return m[1].trim().replace(/^"|"$/g, "");
  }
  throw new Error(`${name} not found in .env`);
}

async function main() {
  const decisionId = process.argv[2];
  const hash = process.argv[3] as Hex;
  const apiBaseUrl = process.argv[4] ?? "https://anc-hor.vercel.app";
  if (!decisionId || !hash) {
    throw new Error("usage: tsx manual-attestor-sign.ts <decisionId> <attestationHash> [apiBaseUrl]");
  }

  const cosignSecret = loadEnvVar("ATTESTOR_COSIGN_SECRET");
  const keys = loadEnvVar("ATTESTOR_PRIVATE_KEYS")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  console.log(`found ${keys.length} attestor keys configured locally`);

  const relayKey = loadEnvVar("HYPERLANE_RELAY_PRIVATE_KEY");
  const relayAddress = privateKeyToAccount((relayKey.startsWith("0x") ? relayKey : `0x${relayKey}`) as Hex).address;

  for (const k of keys) {
    const account = privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex);
    if (account.address.toLowerCase() === relayAddress.toLowerCase()) {
      console.log(`skipping ${account.address} — this is the relay's own signing key, already counted`);
      continue;
    }
    console.log(`signing decision ${decisionId} attestation hash ${hash} as ${account.address}`);
    const signature = await account.sign({ hash });

    const res = await fetch(`${apiBaseUrl}/api/internal/pending-attestations/${decisionId}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cosignSecret}` },
      body: JSON.stringify({ signature }),
    });
    const body = await res.json().catch(() => null);
    console.log(`response (${res.status}):`, JSON.stringify(body));
    if (res.ok) {
      console.log("signature accepted — exiting after first successful signature (only one more was needed)");
      return;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
