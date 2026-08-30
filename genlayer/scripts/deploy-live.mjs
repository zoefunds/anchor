import { readFileSync } from "fs";
import { createAccount, createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const privateKey = "0x7de029f33d0cb1738c69e16f3f89839a9d8630d9017e93050084c4d30b898bce";
const [caseId, claimantRef, respondentRef, attoAmount] = process.argv.slice(2);

const code = readFileSync(new URL("../contracts/adjudicator.py", import.meta.url), "utf-8");
const account = createAccount(privateKey);
const client = createClient({ chain: studionet, account });

console.log("Deploying adjudicator.py...");
const txHash = await client.deployContract({
  code,
  args: [caseId, claimantRef, respondentRef, BigInt(attoAmount)],
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

console.log("CONTRACT_ADDRESS:", receipt.data.contract_address);
