// Thin wrapper around GenLayer's JS SDK (`genlayer-js`) for Anchor's needs:
// deploy an Adjudicator instance per case, call adjudicate(), read the
// decision back.
//
// API verified against the installed `genlayer-js@1.1.8` package's own
// type definitions (node_modules/genlayer-js/dist/index.d.ts and
// index-C3Ul1Rte.d.ts) — not from memory or docs alone, the same discipline
// used for the Python contract and the Hyperlane Solidity interface. Key
// verified facts:
//   - createAccount(privateKeyHex?) takes the raw private key directly.
//   - deployContract({ code, args, account }) resolves to a tx hash; the
//     deployed address comes from the receipt's `data.contract_address`
//     (see docs: developers/intelligent-contracts/deploying/deploy-scripts),
//     NOT from the deploy call's return value.
//   - A transaction can be ACCEPTED/FINALIZED with failed execution — this
//     is exactly the trap that caused the deploy-header bug to look like
//     success on GenLayer's CLI too (see genlayer/README.md).
//   - The docs (api-references/genlayer-js, "Checking execution results")
//     say to check `receipt.txExecutionResultName === ExecutionResult
//     .FINISHED_WITH_RETURN`. Empirically, against real StudioNet with this
//     package version, that field is simply absent — `waitForTransactionReceipt`
//     returns the raw snake_case receipt (`status_name`, `consensus_data`,
//     no top-level `txExecutionResultName`) regardless of the documented
//     `fullTransaction: false` default. Verified with a standalone script
//     dumping the actual receipt JSON rather than trusting the type
//     declarations or docs. The reliable signal, confirmed against both the
//     JS client and the `genlayer` CLI's own receipt output, is
//     `consensus_data.leader_receipt[]` — find the entry with
//     `mode === "leader"` and check its `execution_result === "SUCCESS"`.

import { createAccount, createClient } from "genlayer-js";
import { localnet, studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";
import type { GenLayerClient, TransactionHash } from "genlayer-js/types";
import { TransactionStatus } from "genlayer-js/types";

import type { Decision, Outcome, ReasonCode } from "@anchor/types";

export type GenLayerNetwork = "localnet" | "studionet" | "testnetAsimov" | "testnetBradbury";

const CHAINS = {
  localnet,
  studionet,
  testnetAsimov,
  testnetBradbury,
} as const;

export interface GenLayerConfig {
  network: GenLayerNetwork;
  /** Hex-encoded private key, e.g. from GENLAYER_PRIVATE_KEY. Never log this. */
  privateKey: `0x${string}`;
}

export interface DeployCaseParams {
  /** Full Adjudicator contract source (read from genlayer/contracts/adjudicator.py by the caller). */
  code: string;
  caseId: string;
  claimantRef: string;
  respondentRef: string;
  attoAmount: bigint;
}

export interface AdjudicateParams {
  policyId: string;
  /** Evidence type -> content, per the selected policy's required evidence types. */
  evidence: Record<string, string>;
}

export interface AnchorGenLayerClient {
  deployCase(params: DeployCaseParams): Promise<{ contractAddress: `0x${string}`; txHash: `0x${string}` }>;
  runAdjudication(
    contractAddress: `0x${string}`,
    params: AdjudicateParams
  ): Promise<{ txHash: `0x${string}`; executionSucceeded: boolean }>;
  getDecision(contractAddress: `0x${string}`): Promise<Decision | null>;
  getStatus(contractAddress: `0x${string}`): Promise<string>;
}

class GenVMExecutionError extends Error {
  constructor(message: string, public readonly txHash: string) {
    super(message);
    this.name = "GenVMExecutionError";
  }
}

export function createGenLayerClient(config: GenLayerConfig): AnchorGenLayerClient {
  const account = createAccount(config.privateKey);
  const client: GenLayerClient<any> = createClient({
    chain: CHAINS[config.network],
    account,
  });

  // `execution_result: "SUCCESS"` on the leader entry means that
  // validator's OWN local run completed without crashing - it says
  // nothing about whether the network actually reached consensus on the
  // leader's answer. Confirmed empirically: a real adjudicate() call
  // returned `execution_result: SUCCESS` on all 5 validators while the
  // transaction's overall `result_name` was MAJORITY_DISAGREE (3-2 vote
  // across 4 rotation rounds, genuine model disagreement on ambiguous
  // evidence) - the state change never committed, self.status stayed
  // "PENDING", but a check on execution_result alone would have reported
  // success. Both conditions are required.
  const AGREED_RESULTS = new Set(["AGREE", "MAJORITY_AGREE"]);

  function leaderExecutionSucceeded(receipt: any): boolean {
    const leaderReceipts: any[] = receipt?.consensus_data?.leader_receipt ?? [];
    const leader = leaderReceipts.find((r) => r?.mode === "leader");
    return leader?.execution_result === "SUCCESS" && AGREED_RESULTS.has(receipt?.result_name);
  }

  async function assertExecutionSucceeded(txHash: `0x${string}`) {
    // Explicit target status + generous retries: real consensus (5
    // validators, LLM calls) takes ~1-2 minutes on StudioNet, confirmed by
    // the integration test timings in genlayer/README.md. Do not rely on
    // whatever this call's default status/retry count happens to be.
    const receipt: any = await client.waitForTransactionReceipt({
      hash: txHash as TransactionHash,
      status: TransactionStatus.ACCEPTED,
      retries: 60,
      interval: 3000,
    });
    if (!leaderExecutionSucceeded(receipt)) {
      // Mirrors the ACCEPTED/FINALIZED-but-failed trap documented in
      // genlayer/README.md — never trust status alone.
      const leader = (receipt?.consensus_data?.leader_receipt ?? []).find(
        (r: any) => r?.mode === "leader"
      );
      throw new GenVMExecutionError(
        `GenVM execution did not reach consensus (status=${receipt.status_name}, ` +
          `result_name=${receipt.result_name}, leader execution_result=${leader?.execution_result}, ` +
          `stderr=${leader?.genvm_result?.stderr}) for tx ${txHash}`,
        txHash
      );
    }
    return receipt;
  }

  return {
    async deployCase(params) {
      const txHash = (await client.deployContract({
        code: params.code,
        args: [params.caseId, params.claimantRef, params.respondentRef, params.attoAmount],
      })) as `0x${string}`;

      const receipt = await assertExecutionSucceeded(txHash);
      const contractAddress = (receipt.data as { contract_address?: string } | undefined)
        ?.contract_address as `0x${string}` | undefined;
      if (!contractAddress) {
        throw new GenVMExecutionError(
          `Deploy succeeded but no contract_address in receipt.data for tx ${txHash}`,
          txHash
        );
      }
      return { contractAddress, txHash };
    },

    async runAdjudication(contractAddress, params) {
      // The contract's adjudicate(policy_id, evidence_json) takes evidence
      // as a single JSON-encoded string, not named params — the policy
      // registry lives in the contract, evidence shape varies per policy.
      // (Passed as a JS string here, not a JS object — the `genlayer` CLI
      // auto-detects `{...}`-shaped args and converts them to a native
      // dict type instead of a string, which broke a manual test; this SDK
      // call goes through genlayer-js directly with an explicit string
      // arg, so it doesn't hit that CLI-specific behavior, but keep this
      // as a plain string on purpose.)
      const txHash = (await client.writeContract({
        address: contractAddress,
        functionName: "adjudicate",
        args: [params.policyId, JSON.stringify(params.evidence)],
        value: 0n,
      })) as `0x${string}`;

      const receipt = await assertExecutionSucceeded(txHash);
      return { txHash, executionSucceeded: leaderExecutionSucceeded(receipt) };
    },

    async getDecision(contractAddress) {
      const raw = (await client.readContract({
        address: contractAddress,
        functionName: "get_decision",
        args: [],
      })) as string;

      if (!raw) return null;

      const parsed = JSON.parse(raw) as {
        case_id: string;
        policy_id: string;
        policy_version: string;
        outcome: Outcome;
        claimant_share_bps?: number;
        respondent_share_bps?: number;
        reason_codes: ReasonCode[];
        consensus: "ACCEPTED" | "UNDETERMINED";
      };

      return {
        caseId: parsed.case_id,
        policyId: parsed.policy_id,
        policyVersion: parsed.policy_version,
        outcome: parsed.outcome,
        claimantShareBps: parsed.claimant_share_bps,
        respondentShareBps: parsed.respondent_share_bps,
        reasonCodes: parsed.reason_codes,
        evidenceUsed: [],
        consensus: parsed.consensus,
      };
    },

    async getStatus(contractAddress) {
      return (await client.readContract({
        address: contractAddress,
        functionName: "get_status",
        args: [],
      })) as string;
    },
  };
}
