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
  // Sealevel (protocol: sealevel) domains use the same numeric ID scheme.
  // The recipient there is a Solana *program* (not a 20-byte EVM
  // address) — its 32-byte program ID is used directly as the bytes32
  // recipient, no padding needed (Solana pubkeys already are 32 bytes).
  // See dispatchDecisionRelayToSealevel below and chains/solana/README.md.
  solanaTestnet: 1399811150,
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
 * Dispatches an already-encoded message body from `config.originChain`'s
 * Mailbox to `recipientAddress` (bytes32, already in Hyperlane's padded
 * convention) on `destinationDomain`. The shared plumbing behind both
 * dispatchDecisionRelay (EVM recipient) and dispatchDecisionRelayToSealevel
 * (Solana recipient) — only the body encoding and recipient-address shape
 * differ between them. Anchor's backend wallet pays the quoted interchain
 * fee directly (Anchor subsidizes gas for now — no fee-recovery logic).
 */
export async function dispatchRawMessage(
  config: DispatchConfig,
  destinationDomain: number,
  recipientBytes32: Hex,
  body: Hex
): Promise<{ txHash: Hex; messageId: Hex }> {
  const chain = CHAINS[config.originChain];
  const account = privateKeyToAccount(config.privateKey);
  const transport = http(config.rpcUrl);

  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });

  const mailbox = HYPERLANE_MAILBOX[config.originChain];

  const fee = (await publicClient.readContract({
    address: mailbox,
    abi: MAILBOX_ABI,
    functionName: "quoteDispatch",
    args: [destinationDomain, recipientBytes32, body],
  })) as bigint;

  const { result: messageId } = await publicClient.simulateContract({
    address: mailbox,
    abi: MAILBOX_ABI,
    functionName: "dispatch",
    args: [destinationDomain, recipientBytes32, body],
    value: fee,
    account,
  });

  const txHash = await walletClient.writeContract({
    address: mailbox,
    abi: MAILBOX_ABI,
    functionName: "dispatch",
    args: [destinationDomain, recipientBytes32, body],
    value: fee,
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, messageId };
}

/**
 * Dispatches a DecisionRelay message from `config.originChain` to an EVM
 * recipient contract (a DecisionRelay.sol instance) on `destinationDomain`.
 */
export async function dispatchDecisionRelay(
  config: DispatchConfig,
  destinationDomain: number,
  recipientAddress: Address,
  payload: DecisionRelayPayload
): Promise<{ txHash: Hex; messageId: Hex }> {
  const recipientBytes32 = pad(recipientAddress, { size: 32 });
  const body = encodeDecisionRelayBody(payload);
  return dispatchRawMessage(config, destinationDomain, recipientBytes32, body);
}

// --- Sealevel (Solana) destination ---
// A Solana program's own 32-byte program ID *is* its Hyperlane recipient
// identity — no padding, unlike a 20-byte EVM address. The message body
// must be Borsh-encoded to exactly match decision-relay's Rust
// `DecisionRelayBody` struct (chains/solana/programs/decision-relay/src/lib.rs):
// case_id (String), claimant (Pubkey), respondent (Pubkey),
// escrow_program (Pubkey), claimant_share_bps (u16), respondent_share_bps (u16).

export interface SealevelDecisionRelayPayload {
  caseId: string;
  /** base58-encoded Solana pubkey of the claimant party on the escrow. */
  claimant: string;
  /** base58-encoded Solana pubkey of the respondent party on the escrow. */
  respondent: string;
  /** base58-encoded program ID of the escrow program decision-relay will CPI into. */
  escrowProgram: string;
  claimantShareBps: number;
  respondentShareBps: number;
}

function base58Decode(input: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const ALPHABET_MAP = new Map(ALPHABET.split("").map((c, i) => [c, i]));
  let bytes = [0];
  for (const char of input) {
    const value = ALPHABET_MAP.get(char);
    if (value === undefined) throw new Error(`invalid base58 character: ${char}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of input) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function pubkeyBytes(base58: string): Uint8Array {
  const bytes = base58Decode(base58);
  if (bytes.length !== 32) {
    throw new Error(`"${base58}" does not decode to a 32-byte Solana pubkey (got ${bytes.length} bytes)`);
  }
  return bytes;
}

/** Matches decision-relay's `DecisionRelayBody` Borsh layout exactly — see module comment above. */
export function encodeSealevelDecisionRelayBody(payload: SealevelDecisionRelayPayload): Hex {
  const caseIdBytes = new TextEncoder().encode(payload.caseId);
  const lenPrefix = new Uint8Array(4);
  new DataView(lenPrefix.buffer).setUint32(0, caseIdBytes.length, true);

  const claimantSharePrefix = new Uint8Array(2);
  new DataView(claimantSharePrefix.buffer).setUint16(0, payload.claimantShareBps, true);
  const respondentSharePrefix = new Uint8Array(2);
  new DataView(respondentSharePrefix.buffer).setUint16(0, payload.respondentShareBps, true);

  const parts = [
    lenPrefix,
    caseIdBytes,
    pubkeyBytes(payload.claimant),
    pubkeyBytes(payload.respondent),
    pubkeyBytes(payload.escrowProgram),
    claimantSharePrefix,
    respondentSharePrefix,
  ];
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return `0x${Buffer.from(out).toString("hex")}` as Hex;
}

/**
 * Dispatches a DecisionRelay message from an EVM chain Anchor controls to
 * decision-relay's Solana program on `destinationDomain` (solanaTestnet
 * or solanaDevnet). `decisionRelayProgramId` is that program's base58
 * address, used directly as the 32-byte recipient (Solana pubkeys are
 * already 32 bytes — no left-padding like an EVM address needs).
 */
export async function dispatchDecisionRelayToSealevel(
  config: DispatchConfig,
  destinationDomain: number,
  decisionRelayProgramId: string,
  payload: SealevelDecisionRelayPayload
): Promise<{ txHash: Hex; messageId: Hex }> {
  const recipientBytes32 = `0x${Buffer.from(pubkeyBytes(decisionRelayProgramId)).toString("hex")}` as Hex;
  const body = encodeSealevelDecisionRelayBody(payload);
  return dispatchRawMessage(config, destinationDomain, recipientBytes32, body);
}
