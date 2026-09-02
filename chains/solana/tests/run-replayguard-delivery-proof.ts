// Delivers a real DecisionRelay message from Sepolia to decision-relay's
// Solana Testnet handle() -- the real Hyperlane path, with ReplayGuard
// now live -- to prove ReplayGuard's ring-buffer state actually updates
// on real delivery. Reuses the real GenLayer decision + escrow case from
// the Solana settlement test case created earlier this session (case
// CASE-LIVE-TEST-SOL-1, decisionHash from real consensus, outcome
// REFUND_FULL -> claimant 100%/respondent 0%).
//
// Run: npx tsx tests/run-replayguard-delivery-proof.ts

import { dispatchDecisionRelayToSealevel, HYPERLANE_DOMAIN } from "../../../packages/hyperlane-relay/index.js";
import { readFileSync } from "fs";

async function main() {
  const envPath = `${process.env.HOME}/anchor-/apps/web/.env`;
  const envText = readFileSync(envPath, "utf-8");
  const match = envText.match(/^HYPERLANE_RELAY_PRIVATE_KEY=(.*)$/m);
  if (!match) throw new Error("HYPERLANE_RELAY_PRIVATE_KEY not found in apps/web/.env");
  const rawKey = match[1].trim().replace(/^"|"$/g, "");
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;

  const payload = {
    caseId: "CASE-LIVE-TEST-SOL-1",
    claimant: "8uxqqnAUCwn4LuFE3iQvXA4kr6cMhjZdqsSPHHRLUdmX",
    respondent: "BfCi6xAwxZUodBnU6gXNrPLHwMPbtXdDFWPivETyFj9u",
    escrowProgram: "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn",
    claimantShareBps: 10000, // REFUND_FULL -> claimant gets 100%
    respondentShareBps: 0,
    decisionHash: "0x059c9879d5b415c004f10298997ef897cbd0de6ff4cc0b9e2a2fbfe2ec46bee7" as `0x${string}`,
  };

  console.log("Dispatching real DecisionRelay message Sepolia -> decision-relay (Solana Testnet)...");
  console.log(`  caseId: ${payload.caseId}`);
  console.log(`  decisionHash: ${payload.decisionHash}`);

  const { txHash, messageId } = await dispatchDecisionRelayToSealevel(
    { originChain: "sepolia", privateKey },
    HYPERLANE_DOMAIN.solanaTestnet,
    "DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN",
    payload
  );

  console.log(`Dispatch tx (Sepolia): ${txHash}`);
  console.log(`Message ID: ${messageId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
