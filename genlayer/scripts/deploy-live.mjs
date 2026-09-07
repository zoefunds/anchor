import { readFileSync } from "fs";
import { createAccount, createClient } from "genlayer-js";
import { studionet, studioDevnet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const privateKey = process.env.GENLAYER_PRIVATE_KEY;
if (!privateKey) throw new Error("GENLAYER_PRIVATE_KEY env var is required — see apps/web/.env.example. Never hardcode this key in a script again.");
const [caseId, claimantRef, respondentRef, attoAmount] = process.argv.slice(2);

// Defaults to Studio Next / Studio-dev (61997, the active migration
// target) — pass GENLAYER_NETWORK=studionet to deploy against the old
// 61999 network instead (kept working deliberately, not removed; see
// packages/genlayer-sdk/index.ts's own header comment on why 61999 and
// 61997 evidence must never be conflated).
const network = process.env.GENLAYER_NETWORK === "studionet" ? studionet : studioDevnet;

const code = readFileSync(new URL("../contracts/adjudicator.py", import.meta.url), "utf-8");
const account = createAccount(privateKey);
const client = createClient({ chain: network, account });

// v0.6/Studio-dev requires a nonzero fee deposit or the deploy reverts
// with FeeValueMustBeNonZero — confirmed via live testing this session.
// genlayer-js's own auto-estimation (fees omitted) also failed the same
// way in testing; sim_getFeeConfig's defaultFees is the reliable path,
// boosted 6x on executionBudgetPerRound (empirically the minimum that
// got a real adjudicate() call past `out_of receipt message`). No-op on
// studionet, which doesn't support sim_getFeeConfig.
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

console.log(`Deploying adjudicator.py to chain ${network.id}...`);
const fees = await resolveFees();
const txHash = await client.deployContract({
  code,
  args: [caseId, claimantRef, respondentRef, BigInt(attoAmount)],
  ...(fees ? { fees } : {}),
});
console.log("txHash:", txHash);

const receipt = await client.waitForTransactionReceipt({
  hash: txHash,
  status: TransactionStatus.ACCEPTED,
  retries: 60,
  interval: 3000,
});

// v0.6 receipts carry the official top-level txExecutionResultName
// ("FINISHED_WITH_RETURN" / "FINISHED_WITH_ERROR"); studionet receipts
// don't have this field, so fall back to the older consensus_data check.
const executionOk =
  typeof receipt.txExecutionResultName === "string"
    ? receipt.txExecutionResultName === "FINISHED_WITH_RETURN"
    : (receipt.consensus_data?.leader_receipt ?? []).find((r) => r.mode === "leader")?.execution_result === "SUCCESS";

console.log("status_name:", receipt.status_name, "result_name:", receipt.result_name, "txExecutionResultName:", receipt.txExecutionResultName);
if (!executionOk) {
  const leader = (receipt.consensus_data?.leader_receipt ?? []).find((r) => r.mode === "leader");
  console.log("stderr:", leader?.genvm_result?.stderr);
  process.exit(1);
}

console.log("CONTRACT_ADDRESS:", receipt.data.contract_address);
