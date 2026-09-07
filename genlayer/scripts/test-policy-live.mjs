import { createAccount, createClient } from "genlayer-js";
import { studionet, studioDevnet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const privateKey = process.env.GENLAYER_PRIVATE_KEY;
if (!privateKey) throw new Error("GENLAYER_PRIVATE_KEY env var is required — see apps/web/.env.example. Never hardcode this key in a script again.");
const contractAddress = process.argv[2];
const policyId = process.argv[3];
const evidence = process.argv[4]; // already a JSON string

// Defaults to Studio Next / Studio-dev (61997) — GENLAYER_NETWORK=studionet for 61999.
const network = process.env.GENLAYER_NETWORK === "studionet" ? studionet : studioDevnet;

const account = createAccount(privateKey);
const client = createClient({ chain: network, account });

// See deploy-live.mjs's own comment: v0.6/Studio-dev requires a nonzero
// fee deposit; sim_getFeeConfig's defaultFees (boosted 6x on
// executionBudgetPerRound) is the empirically-confirmed reliable path.
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

console.log(`Calling adjudicate(${policyId}, <evidence>) on ${contractAddress} (chain ${network.id})...`);
const fees = await resolveFees();
const txHash = await client.writeContract({
  address: contractAddress,
  functionName: "adjudicate",
  args: [policyId, evidence],
  value: 0n,
  ...(fees ? { fees } : {}),
});
console.log("txHash:", txHash);

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

console.log("result_name:", receipt.result_name, "txExecutionResultName:", receipt.txExecutionResultName);
if (!executionOk) {
  const leader = (receipt.consensus_data?.leader_receipt ?? []).find((r) => r.mode === "leader");
  console.log("stderr:", leader?.genvm_result?.stderr);
  process.exit(1);
}

const decision = await client.readContract({
  address: contractAddress,
  functionName: "get_decision",
  args: [],
});
console.log("DECISION:", decision);
