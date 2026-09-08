// Solana counterpart to scripts/generate-deployment-manifest.ts (EVM).
// Reads the live cluster's genesis hash (the one thing that IS
// meaningfully checkable on-chain here) and writes
// deployment-manifest.solana.json — the committed file
// lib/deployment-manifest.ts's startup checks compare against.
//
// Real limitation, stated up front rather than glossed over: unlike
// EVM's DecisionRelay.sol (owner()/attestorThreshold()/isAttestor()
// live views), the Sealevel decision-relay program has NO on-chain
// governance account and NO enumerable attestor list — ATTESTOR_PUBKEYS
// and ATTESTOR_THRESHOLD are compiled-in Rust consts (see
// chains/solana/programs/decision-relay/src/lib.rs's own doc comment on
// ReplayGuard for the design rationale). This script cannot verify them
// against live chain state the way the EVM script does; it only
// verifies the RPC cluster itself is the expected one (genesis hash)
// and re-stamps the attestor set/threshold this repo's TypeScript
// mirrors (lib/solana-settle.ts's ATTESTOR_PUBKEYS/ATTESTOR_THRESHOLD)
// so the two files can never silently drift apart without a human
// noticing at generation time.
//
// Run: npx tsx scripts/generate-solana-deployment-manifest.ts
import { Connection } from "@solana/web3.js";
import { writeFileSync } from "fs";
import { ATTESTOR_PUBKEYS, getSolanaAttestorThreshold } from "../src/lib/solana-settle";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.testnet.solana.com";
const EXPECTED_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"; // Solana testnet

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const genesisHash = await connection.getGenesisHash();

  const flags: string[] = [];
  if (genesisHash !== EXPECTED_GENESIS_HASH) {
    flags.push(`RPC endpoint ${RPC_URL}'s genesis hash (${genesisHash}) does not match the expected testnet genesis hash (${EXPECTED_GENESIS_HASH}) — this RPC is pointed at a different cluster than intended.`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/generate-solana-deployment-manifest.ts",
    network: { cluster: "testnet", rpcHost: new URL(RPC_URL).hostname, genesisHash },
    decisionRelay: {
      attestors: {
        expected: ATTESTOR_PUBKEYS,
        threshold: getSolanaAttestorThreshold(),
        note: "Mirrors chains/solana/programs/decision-relay/src/lib.rs's ATTESTOR_PUBKEYS/ATTESTOR_THRESHOLD consts exactly — decision-relay has no on-chain enumerable attestor list or governance account the way EVM's DecisionRelay.sol does, so unlike the EVM manifest this cannot be verified against a live on-chain read; it is a source-controlled mirror of the deployed program's hardcoded consts, kept in sync by hand whenever the Rust consts are rotated and re-deployed.",
      },
    },
    flags,
  };

  writeFileSync("deployment-manifest.solana.json", JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
  if (flags.length > 0) {
    console.error(`\n${flags.length} flag(s) raised — see manifest's "flags" array above.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
