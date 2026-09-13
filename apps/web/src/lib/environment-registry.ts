// Phase 6, item 2: a typed registry that makes "which chain/network am I
// talking to" a single source of truth, instead of the current reality
// where chain/network selection is scattered across env vars read
// ad-hoc in genlayer.ts (GENLAYER_NETWORK), hyperlane.ts
// (APPROVED_*_SETTLEMENT_CONTRACTS / APPROVED_SOLANA_ESCROW_PROGRAMS),
// and solana-settle.ts (cluster assumed from RPC URL). None of those
// call sites currently cross-check against each other, so nothing today
// stops a process from being configured with a Sepolia signer key while
// its RPC env var points at Ethereum mainnet. This registry does not
// yet replace those call sites (that migration is real, follow-up work
// — see docs/mainnet-readiness-gate.md item 2) but it is the concrete
// shape that migration would bind into, and startup-checks.ts already
// enforces its single most load-bearing invariant today: a live
// (non-testnet) environment can never boot with settlement unpaused.

import { ACTIVE_SEPOLIA_TOPOLOGY } from "@/lib/deployment-registry";

export type AnchorEnvironmentId =
  | "studio-next-testnet"
  | "sepolia"
  | "solana-testnet"
  | "genlayer-mainnet"
  | "ethereum-mainnet"
  | "solana-mainnet";

export type ChainFamily = "genlayer" | "evm" | "solana";

export interface AnchorEnvironment {
  id: AnchorEnvironmentId;
  chainFamily: ChainFamily;
  displayName: string;
  /** EVM chain ID, Solana genesis hash, or GenLayer chain ID — whichever applies to this chainFamily. Used to detect env/RPC mismatches once call sites are migrated to read from here. */
  chainIdentifier: string | number;
  /** Contract/program addresses this environment is allowed to interact with. Deliberately empty for every placeholder entry below — there is nothing real to bind to yet. */
  addresses: {
    mailbox?: string;
    interchainSecurityModule?: string;
    decisionRelay?: string;
    escrowProgram?: string;
  };
  /**
   * Whether this environment corresponds to a real, live, already-deployed
   * network Anchor actually talks to today. false for every mainnet
   * candidate: these are placeholder rows describing an environment this
   * repo has NOT deployed to, NOT connected to, and NOT tested against —
   * present so the registry's shape is complete and so
   * assertEnvironmentSafeToBoot has something concrete to validate
   * against, not because mainnet readiness has been achieved.
   */
  live: boolean;
  /**
   * Settlement dispatch must be paused for every non-testnet environment
   * until Phase 6's mainnet-readiness gate (docs/mainnet-readiness-gate.md)
   * is satisfied and an operator explicitly flips this — never as a side
   * effect of code changes alone. Testnet environments default to false
   * (unpaused) because that is this repo's actual current, intentional,
   * live-testnet operating mode.
   */
  settlementPaused: boolean;
}

export const ANCHOR_ENVIRONMENTS: Record<AnchorEnvironmentId, AnchorEnvironment> = {
  "studio-next-testnet": {
    id: "studio-next-testnet",
    chainFamily: "genlayer",
    displayName: "GenLayer Studio Next (testnet, chain 61997)",
    chainIdentifier: 61997,
    addresses: {},
    live: true,
    settlementPaused: false,
  },
  sepolia: {
    id: "sepolia",
    chainFamily: "evm",
    displayName: "Ethereum Sepolia testnet",
    chainIdentifier: 11155111,
    addresses: {
      decisionRelay: ACTIVE_SEPOLIA_TOPOLOGY.decisionRelay,
      interchainSecurityModule: ACTIVE_SEPOLIA_TOPOLOGY.ism,
    },
    live: true,
    // Incident recovery (2026-09-13, auditor directive): live delivery
    // through the active Sepolia route has not been proven end-to-end
    // (dispatch succeeds; Mailbox.delivered/DecisionRelay.processedDecisions/
    // Escrow settlement has not). Paused here AND via the real runtime
    // gate (SETTLEMENT_PAUSED env var on the worker — see
    // adjudication-service.ts's isSettlementPaused/dispatchSettlementForDecision,
    // which is what actually blocks dispatch; this registry field alone
    // is not yet wired into that check, see the incident doc). Do not
    // flip this back to false until Phase 3's delivery-proof verifier
    // and a real end-to-end settlement both pass.
    settlementPaused: true,
  },
  "solana-testnet": {
    id: "solana-testnet",
    chainFamily: "solana",
    displayName: "Solana testnet",
    chainIdentifier: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    addresses: {
      escrowProgram: "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn",
    },
    live: true,
    settlementPaused: false,
  },
  // --- Everything below is a PLACEHOLDER. live: false. No contract has
  // been deployed, no Safe/attestor/validator set exists, no RPC provider
  // is configured. These rows exist only so the registry's type and the
  // startup-check fail-closed property below are exercised against a
  // realistic future shape, per Phase 6's prepare-don't-execute mandate.
  "genlayer-mainnet": {
    id: "genlayer-mainnet",
    chainFamily: "genlayer",
    displayName: "GenLayer mainnet (NOT LIVE — placeholder)",
    chainIdentifier: "unassigned",
    addresses: {},
    live: false,
    settlementPaused: true,
  },
  "ethereum-mainnet": {
    id: "ethereum-mainnet",
    chainFamily: "evm",
    displayName: "Ethereum mainnet (NOT LIVE — placeholder)",
    chainIdentifier: 1,
    addresses: {},
    live: false,
    settlementPaused: true,
  },
  "solana-mainnet": {
    id: "solana-mainnet",
    chainFamily: "solana",
    displayName: "Solana mainnet-beta (NOT LIVE — placeholder)",
    chainIdentifier: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    addresses: {},
    live: false,
    settlementPaused: true,
  },
};

export function getAnchorEnvironment(id: AnchorEnvironmentId): AnchorEnvironment {
  const env = ANCHOR_ENVIRONMENTS[id];
  if (!env) throw new Error(`unknown Anchor environment id: ${id}`);
  return env;
}

const TESTNET_ENVIRONMENTS: ReadonlySet<AnchorEnvironmentId> = new Set([
  "studio-next-testnet",
  "sepolia",
  "solana-testnet",
]);

export function isTestnetEnvironment(id: AnchorEnvironmentId): boolean {
  return TESTNET_ENVIRONMENTS.has(id);
}

/**
 * Environment-specific settlement-contract allowlist, keyed by
 * AnchorEnvironmentId rather than a single flat list. This is the
 * property that prevents a Sepolia-approved address from ever being
 * mistaken for a mainnet-approved one: ethereum-mainnet's set is empty
 * by construction (see ANCHOR_ENVIRONMENTS above — its `addresses` are
 * all undefined) until a real mainnet deployment fills it in, at which
 * point that new address is added ONLY here, never to sepolia's set.
 */
export function isApprovedForEnvironment(envId: AnchorEnvironmentId, address: string): boolean {
  const env = getAnchorEnvironment(envId);
  const candidates = Object.values(env.addresses).filter((a): a is string => Boolean(a));
  const normalize = env.chainFamily === "solana" ? (s: string) => s : (s: string) => s.toLowerCase();
  return candidates.map(normalize).includes(normalize(address));
}
