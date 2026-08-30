// Dispatches Anchor's DecisionRelay messages via Hyperlane from an EVM
// chain Anchor's backend controls, to a destination DecisionRelay contract
// (EVM) or, once built, a Solana Sealevel recipient. See
// docs/hyperlane-integration.md for the full architecture and
// genlayer/README.md for why GenLayer itself can't be the origin chain
// (not a supported domain on Hyperlane or LayerZero — checked both).
//
// Mailbox interface verified against Hyperlane's own docs
// (docs.hyperlane.xyz) and confirmed live via `cast call` against the real
// Sepolia Mailbox (0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766).
// Addresses/domain IDs below are from Hyperlane's own registry
// (github.com/hyperlane-xyz/hyperlane-registry), not guessed.

import { createPublicClient, createWalletClient, http, encodeAbiParameters, pad, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, baseSepolia } from "viem/chains";

export const HYPERLANE_MAILBOX: Record<string, Address> = {
  sepolia: "0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766",
  baseSepolia: "0x6966b0E55883d49BFB24539356a2f8A673E02039",
};

export const HYPERLANE_DOMAIN: Record<string, number> = {
  sepolia: 11155111,
  baseSepolia: 84532,
  // Sealevel (protocol: sealevel) domains use the same numeric ID scheme
  // but the recipient is a Solana program, not an EVM contract — a
  // Sealevel-side dispatch needs the Solana SDK, not this viem-based path.
  // See chains/solana/README.md.
  solanaDevnet: 1399811151,
};

const MAILBOX_ABI = [
  {
    type: "function",
    name: "dispatch",
    stateMutability: "payable",
    inputs: [
      { name: "destinationDomain", type: "uint32" },
      { name: "recipientAddress", type: "bytes32" },
      { name: "messageBody", type: "bytes" },
    ],
    outputs: [{ name: "messageId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "quoteDispatch",
    stateMutability: "view",
    inputs: [
      { name: "destinationDomain", type: "uint32" },
      { name: "recipientAddress", type: "bytes32" },
      { name: "messageBody", type: "bytes" },
    ],
    outputs: [{ name: "fee", type: "uint256" }],
  },
] as const;

const CHAINS = { sepolia, baseSepolia };

export interface DecisionRelayPayload {
  caseId: string; // fits in bytes32 via keccak/pad — see encodeDecisionRelayBody
  outcome: string;
  claimantAmount: bigint;
  respondentAmount: bigint;
  escrowId: Hex; // bytes32
  proofHash: Hex; // bytes32
}

/** Matches DecisionRelay.sol's `handle()` abi.decode shape exactly. */
export function encodeDecisionRelayBody(payload: DecisionRelayPayload): Hex {
  const caseIdBytes32 = pad(`0x${Buffer.from(payload.caseId).toString("hex")}` as Hex, { size: 32 });
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "string" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [caseIdBytes32, payload.outcome, payload.claimantAmount, payload.respondentAmount, payload.escrowId, payload.proofHash]
  );
}

export interface DispatchConfig {
  originChain: "sepolia" | "baseSepolia";
  privateKey: `0x${string}`;
  rpcUrl?: string;
}

/**
 * Dispatches a DecisionRelay message from `config.originChain` to a
 * recipient contract on `destinationDomain`. Anchor's backend wallet pays
 * the quoted interchain fee directly (per your call: Anchor subsidizes gas
 * for now — no fee-recovery logic here yet).
 */
export async function dispatchDecisionRelay(
  config: DispatchConfig,
  destinationDomain: number,
  recipientAddress: Address,
  payload: DecisionRelayPayload
): Promise<{ txHash: Hex; messageId: Hex }> {
  const chain = CHAINS[config.originChain];
  const account = privateKeyToAccount(config.privateKey);
  const transport = http(config.rpcUrl);

  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });

  const mailbox = HYPERLANE_MAILBOX[config.originChain];
  const recipientBytes32 = pad(recipientAddress, { size: 32 });
  const body = encodeDecisionRelayBody(payload);

  const fee = (await publicClient.readContract({
    address: mailbox,
    abi: MAILBOX_ABI,
    functionName: "quoteDispatch",
    args: [destinationDomain, recipientBytes32, body],
  })) as bigint;

  const messageId = (await publicClient.simulateContract({
    address: mailbox,
    abi: MAILBOX_ABI,
    functionName: "dispatch",
    args: [destinationDomain, recipientBytes32, body],
    value: fee,
    account,
  })) as unknown as { result: Hex };

  const txHash = await walletClient.writeContract({
    address: mailbox,
    abi: MAILBOX_ABI,
    functionName: "dispatch",
    args: [destinationDomain, recipientBytes32, body],
    value: fee,
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, messageId: (messageId as any)?.result ?? txHash };
}
