import { createAccount, createClient } from "genlayer-js";
import { studionet, studioDevnet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const privateKey = process.env.GENLAYER_PRIVATE_KEY;
if (!privateKey) throw new Error("GENLAYER_PRIVATE_KEY env var is required — see apps/web/.env.example. Never hardcode this key in a script again.");
const contractAddress = process.argv[2];

// Defaults to Studio Next / Studio-dev (61997) — GENLAYER_NETWORK=studionet for 61999.
const network = process.env.GENLAYER_NETWORK === "studionet" ? studionet : studioDevnet;

const account = createAccount(privateKey);
const client = createClient({ chain: network, account });

// See deploy-live.mjs's own comment: v0.6/Studio-dev requires a nonzero
// fee deposit; sim_getFeeConfig's defaultFees (boosted 6x on
// executionBudgetPerRound) is the empirically-confirmed reliable path.
// No-op on studionet.
async function resolveFees() {
  let config;
  try {
    config = await client.request({ method: "sim_getFeeConfig", params: [] });
  } catch {
    return undefined;
  }
  if (!config?.defaultFees) return undefined;
  const original = BigInt(config.defaultFees.distribution.executionBudgetPerRound);
  const boosted = original * 6n;
  return {
    ...config.defaultFees,
    distribution: { ...config.defaultFees.distribution, executionBudgetPerRound: boosted.toString() },
    feeValue: (BigInt(config.defaultFees.feeValue) + (boosted - original)).toString(),
  };
}

async function writeAndWait(functionName, args, label) {
  const fees = await resolveFees();
  const txHash = await client.writeContract({ address: contractAddress, functionName, args, value: 0n, ...(fees ? { fees } : {}) });
  return waitOk(txHash, label);
}

async function waitOk(txHash, label) {
  console.log(`${label} txHash:`, txHash);
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.ACCEPTED,
    retries: 60,
    interval: 3000,
  });
  // v0.6 receipts carry the official top-level txExecutionResultName;
  // studionet receipts don't, so fall back to the older consensus_data check.
  const executionOk =
    typeof receipt.txExecutionResultName === "string"
      ? receipt.txExecutionResultName === "FINISHED_WITH_RETURN"
      : (receipt.consensus_data?.leader_receipt ?? []).find((r) => r.mode === "leader")?.execution_result === "SUCCESS";
  console.log(`${label} result_name:`, receipt.result_name, "txExecutionResultName:", receipt.txExecutionResultName);
  if (!executionOk) {
    const leader = (receipt.consensus_data?.leader_receipt ?? []).find((r) => r.mode === "leader");
    console.log("stderr:", leader?.genvm_result?.stderr);
    process.exit(1);
  }
  return receipt;
}

const evidenceA = JSON.stringify({
  milestone_spec: "The deliverable must be a photograph that clearly shows a cat (feline).",
  deliverable: "https://upload.wikimedia.org/wikipedia/commons/6/6e/Golde33443.jpg",
  claimant_statement: "This is a dog, not a cat. Does not meet spec.",
  respondent_statement: "I delivered a fine photo.",
});

console.log("--- Initial adjudicate (dog image vs cat spec) ---");
await writeAndWait("adjudicate", ["escrow_release_v1", evidenceA], "adjudicate#1");

let decision = await client.readContract({ address: contractAddress, functionName: "get_decision", args: [] });
console.log("decision#1:", decision);

console.log("\n--- Appeal ---");
await writeAndWait("appeal", [], "appeal");

const status = await client.readContract({ address: contractAddress, functionName: "get_status", args: [] });
const appealCount = await client.readContract({ address: contractAddress, functionName: "get_appeal_count", args: [] });
console.log("status after appeal:", status, "appeal_count:", appealCount);

console.log("\n--- Re-adjudicate with corrected evidence (cat image) ---");
const evidenceB = JSON.stringify({
  milestone_spec: "The deliverable must be a photograph that clearly shows a cat (feline).",
  deliverable: "https://upload.wikimedia.org/wikipedia/commons/3/3a/Cat03.jpg",
  claimant_statement: "On appeal, the corrected deliverable photo is attached and is genuinely a cat.",
  respondent_statement: "Confirmed - this is the correct photo.",
});
await writeAndWait("adjudicate", ["escrow_release_v1", evidenceB], "adjudicate#2 (post-appeal)");

decision = await client.readContract({ address: contractAddress, functionName: "get_decision", args: [] });
console.log("\ndecision#2 (post-appeal):", decision);

console.log("\n--- Appeal again (should fail: limit reached) ---");
try {
  await writeAndWait("appeal", [], "appeal#2");
  console.log("UNEXPECTED: second appeal succeeded");
} catch (e) {
  console.log("appeal#2 rejected as expected:", e.message?.slice(0, 200));
}
