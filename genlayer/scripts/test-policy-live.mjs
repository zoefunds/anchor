import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const privateKey = "0x7de029f33d0cb1738c69e16f3f89839a9d8630d9017e93050084c4d30b898bce";
const contractAddress = process.argv[2];
const policyId = process.argv[3];
const evidence = process.argv[4]; // already a JSON string

const account = createAccount(privateKey);
const client = createClient({ chain: studionet, account });

console.log(`Calling adjudicate(${policyId}, <evidence>) on ${contractAddress}...`);
const txHash = await client.writeContract({
  address: contractAddress,
  functionName: "adjudicate",
  args: [policyId, evidence],
  value: 0n,
});
console.log("txHash:", txHash);

const receipt = await client.waitForTransactionReceipt({
  hash: txHash,
  status: TransactionStatus.ACCEPTED,
  retries: 60,
  interval: 3000,
});

const leader = (receipt.consensus_data?.leader_receipt ?? []).find((r) => r.mode === "leader");
console.log("leader execution_result:", leader?.execution_result);
if (leader?.execution_result !== "SUCCESS") {
  console.log("stderr:", leader?.genvm_result?.stderr);
  process.exit(1);
}

const decision = await client.readContract({
  address: contractAddress,
  functionName: "get_decision",
  args: [],
});
console.log("DECISION:", decision);
