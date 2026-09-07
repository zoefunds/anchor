// Delivers a real DecisionRelay message from Sepolia to decision-relay's
// Solana Testnet handle() -- now gated by our own real
// hyperlane-sealevel-multisig-ism-message-id instance
// (5DLNSFtzEJBTipvvSvNPzvAFpx8uwf96qEjygAwT6ncY) instead of TRUSTED_ISM --
// to prove the self-hosted relayer can actually construct real multisig
// metadata and get process() accepted through the new ISM. Step 3-4 of
// chains/solana/ISM_MIGRATION.md's Testnet proof checklist.
//
// Run: npx tsx tests/run-multisig-ism-delivery-proof.ts

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
    caseId: `CASE-MULTISIG-ISM-PROOF-${Date.now()}`,
    claimant: "8uxqqnAUCwn4LuFE3iQvXA4kr6cMhjZdqsSPHHRLUdmX",
    respondent: "BfCi6xAwxZUodBnU6gXNrPLHwMPbtXdDFWPivETyFj9u",
    escrowProgram: "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn",
    claimantShareBps: 10000,
    respondentShareBps: 0,
    decisionHash: `0x${"ab".repeat(32)}` as `0x${string}`,
  };

  console.log("Dispatching real DecisionRelay message Sepolia -> decision-relay (Solana Testnet), gated by the new multisig ISM...");
  console.log(`  caseId: ${payload.caseId}`);

  const { txHash, messageId } = await dispatchDecisionRelayToSealevel(
    { originChain: "sepolia", privateKey },
    HYPERLANE_DOMAIN.solanaTestnet,
    "DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN",
    payload
  );

  console.log(`Dispatch tx (Sepolia): ${txHash}`);
  console.log(`Message ID: ${messageId}`);
  console.log(`\nWatch relayer logs for delivery: fly logs -a anc-hor-relayer --no-tail | grep -i "${messageId.slice(2, 10)}"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
