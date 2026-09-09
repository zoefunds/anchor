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
    /** Track 2 — the ONE allowlisted USDC-settlement escrow contract for this environment, if any. Separate from decisionRelay (the notification/attestation contract) — this is the ISettlementTarget that actually moves USDC. */
    escrowUsdc?: string;
  };
  /**
   * Track 2 — the single, explicitly-bound USDC deployment this
   * environment accepts, if any. Deliberately not a list: this repo
   * supports exactly one testnet USDC deployment per environment, not
   * arbitrary ERC-20 tokens (see hyperlane.ts's isApprovedUsdcEscrow,
   * the only code path allowed to read this field for allowlisting).
   */
  usdc?: {
    tokenAddress: string;
    decimals: number;
    /** A human label for what this token actually is — surfaced in receipts/UI so nobody mistakes it for real USD-backed value. */
    label: string;
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
      decisionRelay: "0x1fc130416Dc09dff60e0Ea3C8dE8474e8428b3E2",
      interchainSecurityModule: "0xd916b90858B8bF7Cc7E111D3C7923ab4Fe0FCcf0",
      // Track 2 — deployed 2026-09-09 via
      // chains/evm/deploy/DeployEscrowUSDC.s.sol, tx
      // 0xb49c1002f9621ad258f3ef8cd69c48315cd5cd66c2a65e7a22a248e94cbbeb06,
      // confirmed on-chain (status: true). Constructor args: usdcToken
      // (the entry above), decisionRelay (this environment's own
      // decisionRelay address), depositAuthorizer =
      // 0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb (the same backend
      // dispatch wallet already trusted as decisionRelay's
      // trustedSender — see DeployEscrowUSDC.s.sol's own header for why).
      escrowUsdc: "0x87e94aac03f1a032b264e035fd41a76bcdc802e2",
    },
    // Circle's official Sepolia testnet USDC deployment. Verified live
    // via eth_call on 2026-09-09 against ethereum-sepolia.publicnode.com:
    // symbol() == "USDC", decimals() == 6, and eth_getCode confirms a
    // real EIP-1967 transparent proxy (matches Circle's real USDC
    // deployment pattern) — not merely trusted from a publicly
    // documented address.
    usdc: {
      tokenAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      decimals: 6,
      label: "USDC (Sepolia testnet — no real value)",
    },
    live: true,
    settlementPaused: false,
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

/**
 * The single asset key a Policy's `allowedAssets` must list before a
 * case may settle in Track 2's USDC path. A stable string (not the raw
 * token address) so policy documents stay readable and don't need
 * updating if this environment's `usdc.tokenAddress` ever legitimately
 * changes to a new deployment.
 */
export const USDC_SEPOLIA_ASSET_KEY = "USDC-sepolia";

/**
 * Track 2, item 1 — "reject arbitrary ERC-20 token addresses." Returns
 * the bound (tokenAddress, decimals) pair for an environment's ONE
 * allowlisted USDC deployment, or null if this environment has none
 * configured. The only legitimate way to widen what counts as USDC for
 * an environment is editing THIS registry entry — never an API
 * parameter, env var override, or caller-supplied address.
 */
export function getUsdcBinding(envId: AnchorEnvironmentId): { tokenAddress: string; decimals: number; label: string } | null {
  return getAnchorEnvironment(envId).usdc ?? null;
}
