// Dispatches a real DecisionRelay message from Sepolia to decision-relay's
// Solana Testnet program, targeting a real escrow case already created
// (see chains/solana/tests/run-create-case-for-relay-test.ts) with
// decision-relay's escrow-authority PDA as its adjudicator. If this
// delivers, decision-relay's handle() CPIs into escrow.settle() for real —
// the strongest possible proof the Solana settlement destination works,
// not just that a message was dispatched.
// Run from repo root: node genlayer/scripts/test-solana-decision-relay-dispatch.mjs <caseId> <claimantPubkey> <respondentPubkey>

import { dispatchDecisionRelayToSealevel, HYPERLANE_DOMAIN } from "@anchor/hyperlane-relay";

const [caseId, claimant, respondent] = process.argv.slice(2);
const ESCROW_PROGRAM = "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn";
const DECISION_RELAY_PROGRAM = "DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN";

const config = {
  originChain: "sepolia",
  privateKey: "0x7de029f33d0cb1738c69e16f3f89839a9d8630d9017e93050084c4d30b898bce",
  rpcUrl: "https://ethereum-sepolia.publicnode.com",
};

console.log(`Dispatching DecisionRelay to Solana Testnet for case ${caseId}...`);
const { txHash, messageId } = await dispatchDecisionRelayToSealevel(
  config,
  HYPERLANE_DOMAIN.solanaTestnet,
  DECISION_RELAY_PROGRAM,
  {
    caseId,
    claimant,
    respondent,
    escrowProgram: ESCROW_PROGRAM,
    claimantShareBps: 6500,
    respondentShareBps: 3500,
  }
);

console.log("txHash:", txHash);
console.log("messageId:", messageId);
console.log(`\nView on Sepolia: https://sepolia.etherscan.io/tx/${txHash}`);
