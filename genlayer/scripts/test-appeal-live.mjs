import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const privateKey = "0x7de029f33d0cb1738c69e16f3f89839a9d8630d9017e93050084c4d30b898bce";
const contractAddress = process.argv[2];

const account = createAccount(privateKey);
const client = createClient({ chain: studionet, account });

async function waitOk(txHash, label) {
  console.log(`${label} txHash:`, txHash);
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    status: TransactionStatus.ACCEPTED,
    retries: 60,
    interval: 3000,
  });
  const leader = (receipt.consensus_data?.leader_receipt ?? []).find((r) => r.mode === "leader");
  console.log(`${label} leader execution_result:`, leader?.execution_result, "result_name:", receipt.result_name);
  if (leader?.execution_result !== "SUCCESS") {
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
let tx = await client.writeContract({
  address: contractAddress,
  functionName: "adjudicate",
  args: ["escrow_release_v1", evidenceA],
  value: 0n,
});
await waitOk(tx, "adjudicate#1");

let decision = await client.readContract({ address: contractAddress, functionName: "get_decision", args: [] });
console.log("decision#1:", decision);

console.log("\n--- Appeal ---");
tx = await client.writeContract({ address: contractAddress, functionName: "appeal", args: [], value: 0n });
await waitOk(tx, "appeal");

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
tx = await client.writeContract({
  address: contractAddress,
  functionName: "adjudicate",
  args: ["escrow_release_v1", evidenceB],
  value: 0n,
});
await waitOk(tx, "adjudicate#2 (post-appeal)");

decision = await client.readContract({ address: contractAddress, functionName: "get_decision", args: [] });
console.log("\ndecision#2 (post-appeal):", decision);

console.log("\n--- Appeal again (should fail: limit reached) ---");
try {
  tx = await client.writeContract({ address: contractAddress, functionName: "appeal", args: [], value: 0n });
  await waitOk(tx, "appeal#2");
  console.log("UNEXPECTED: second appeal succeeded");
} catch (e) {
  console.log("appeal#2 rejected as expected:", e.message?.slice(0, 200));
}
