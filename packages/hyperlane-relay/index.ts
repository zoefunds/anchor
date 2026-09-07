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

import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256, pad, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, baseSepolia } from "viem/chains";

export const HYPERLANE_MAILBOX: Record<string, Address> = {
  // Anchor's own Sepolia Mailbox (deployed 2026-09-07) -- NOT Hyperlane's
  // canonical shared registry Mailbox. That shared Mailbox's defaultHook/
  // requiredHook were found live to not route through any MerkleTreeHook
  // at all (orphaned from the one its own registry documents), meaning no
  // real multisig-ISM-based delivery could ever complete through it,
  // regardless of validator health -- see chains/solana/ISM_MIGRATION.md
  // and this session's investigation. This Mailbox's own MerkleTreeHook
  // (0xA32341dc796DB6C51c0D1695751aC9AA2Dd77aBB) is verified live-working,
  // and all 3 real validators (anc-hor-validator1/2/3) are reconfigured
  // to index it and have re-announced against its ValidatorAnnounce
  // (0x198A6ec048C665d7E4dc2b40Cb2c715Db1cEC6F5).
  sepolia: "0x345E7246631ceb0300427caB75eacA10c326BB09",
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
  /**
   * M-of-N: an array of 65-byte ECDSA signatures (r || s || v), one per
   * attestor key that signed, over exactly the fields DecisionRelay.sol's
   * handle() recomputes and checks via ecrecover — see
   * computeDecisionAttestationHash below and that contract's own doc
   * comment for why this exists (destination-side proof the decision
   * content itself is genuine, independent of who dispatched the
   * Hyperlane message) and why it's M-of-N rather than a single key.
   * DecisionRelay.sol requires at least `attestorThreshold` of these to
   * recover to DISTINCT registered attestor addresses; extra/invalid
   * entries are simply ignored, not a hard error, so this array can
   * safely include every signature Anchor's backend was ABLE to collect
   * even if not every configured attestor responded in time.
   */
  attestationSignatures: Hex[];
}

/**
 * The exact hash DecisionRelay.sol's handle() recomputes via
 * `keccak256(abi.encode("ANCHOR_DECISION_ATTESTATION_V2", _origin,
 * address(this), caseId, outcome, claimantAmount, respondentAmount,
 * escrowId, proofHash))` — must stay byte-for-byte identical to that
 * Solidity code (type order, the literal version-tag string, and
 * `address(this)` meaning "the deployed DecisionRelay contract's own
 * address" for `recipientAddress` here) or every real signature this
 * produces will fail verification on-chain.
 */
export function computeDecisionAttestationHash(params: {
  originDomain: number;
  recipientAddress: Address;
  caseIdBytes32: Hex;
  outcome: string;
  claimantAmount: bigint;
  respondentAmount: bigint;
  escrowId: Hex;
  proofHash: Hex;
}): Hex {
  const encoded = encodeAbiParameters(
    [
      { type: "string" },
      { type: "uint32" },
      { type: "address" },
      { type: "bytes32" },
      { type: "string" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      "ANCHOR_DECISION_ATTESTATION_V2",
      params.originDomain,
      params.recipientAddress,
      params.caseIdBytes32,
      params.outcome,
      params.claimantAmount,
      params.respondentAmount,
      params.escrowId,
      params.proofHash,
    ]
  );
  return keccak256(encoded);
}

export function caseIdToBytes32(caseId: string): Hex {
  return pad(`0x${Buffer.from(caseId).toString("hex")}` as Hex, { size: 32 });
}

/** Matches DecisionRelay.sol's `handle()` abi.decode shape exactly. */
export function encodeDecisionRelayBody(payload: DecisionRelayPayload): Hex {
  const caseIdBytes32 = caseIdToBytes32(payload.caseId);
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "string" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes[]" },
    ],
    [
      caseIdBytes32,
      payload.outcome,
      payload.claimantAmount,
      payload.respondentAmount,
      payload.escrowId,
      payload.proofHash,
      payload.attestationSignatures,
    ]
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
  /** sha256 fingerprint of the full decision (see adjudication-service.ts's computeDecisionHash), 32 raw bytes — the same value carried as EVM DecisionRelay's proofHash, so a Solana destination can bind settlement to the exact policy/outcome/proof bundle Anchor decided on, not just the shares. Must match decision-relay's Rust DecisionRelayBody struct exactly (chains/solana/programs/decision-relay/src/lib.rs). */
  decisionHash: Hex;
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

function decisionHashBytes(hash: Hex): Uint8Array {
  const hex = hash.startsWith("0x") ? hash.slice(2) : hash;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`decisionHash must be a 32-byte hex string (sha256 hex digest), got: ${hash}`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
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
    decisionHashBytes(payload.decisionHash),
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
 * decision-relay's Solana program on `destinationDomain` (solanaTestnet).
 * `decisionRelayProgramId` is that program's base58
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
