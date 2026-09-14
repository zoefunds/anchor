// A single, shared place to construct block-explorer URLs — every
// tx hash/address shown anywhere in the UI or in a generated receipt
// should link out via one of these, not a hand-rolled URL, so a wrong
// cluster/network never gets duplicated across call sites.
//
// Real bug found and fixed here 2026-09-12: deposit-execution.ts's
// Solana explorerUrl hardcoded cluster=devnet while this project's
// actual SOLANA_RPC_URL was api.testnet.solana.com at the time —
// explorer.solana.com treats those as genuinely different clusters, so
// the old link pointed at a transaction that would never be found.
//
// Real bug #2 found and fixed here 2026-09-14: the fix for bug #1
// hardcoded cluster=testnet instead, which was correct for a few days
// but went stale the moment SOLANA_RPC_URL moved to Devnet during the
// 2026-09-14 migration (see docs/incidents/2026-09-14-solana-devnet-migration.md)
// — every Solana explorer link in the app pointed at the wrong cluster
// again, same failure mode as bug #1, just the opposite cluster. Fixed
// by deriving the cluster param from SOLANA_RPC_URL itself instead of a
// second hardcoded literal that can drift out of sync with the one
// that actually controls where transactions are submitted.
// This file is imported from a client component (cases/[id]/page.tsx),
// so it cannot read the server-only SOLANA_RPC_URL env var directly —
// only NEXT_PUBLIC_-prefixed vars are available in a browser bundle.
// NEXT_PUBLIC_SOLANA_CLUSTER is an optional explicit mirror for exactly
// this purpose; the literal fallback below is the single place left to
// update by hand on the next cluster migration, replacing the TWO
// separate hardcoded literals (bug #1's devnet, bug #2's testnet) this
// file used to carry.
function solanaExplorerCluster(): "devnet" | "testnet" | "mainnet-beta" {
  const configured = process.env.NEXT_PUBLIC_SOLANA_CLUSTER;
  if (configured === "devnet" || configured === "testnet" || configured === "mainnet-beta") return configured;
  return "devnet"; // update alongside SOLANA_RPC_URL — see docs/incidents/2026-09-14-solana-devnet-migration.md
}

export function sepoliaTxUrl(txHash: string): string {
  return `https://sepolia.etherscan.io/tx/${txHash}`;
}

export function sepoliaAddressUrl(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}

export function solanaTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${solanaExplorerCluster()}`;
}

export function solanaAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=${solanaExplorerCluster()}`;
}

// GenLayer's own hosted explorer for Studio Next (chain 61997) — base
// URL confirmed by the user; path convention (/address/, /tx/) follows
// the same convention as every other explorer wired in here (Etherscan,
// Solana Explorer) since GenLayer's explorer is itself EVM-shaped.
const GENLAYER_EXPLORER_BASE = "https://explorer-studio-dev.genlayer.com";

export function genlayerAddressUrl(address: string): string {
  return `${GENLAYER_EXPLORER_BASE}/address/${address}`;
}

export function genlayerTxUrl(txHash: string): string {
  return `${GENLAYER_EXPLORER_BASE}/tx/${txHash}`;
}

/** Picks the right EVM/Solana tx explorer by settlement chain — the one thing every settlement-chain-aware caller (case detail, receipts) actually needs. */
export function settlementTxUrl(chain: string, txHashOrSignature: string): string | null {
  if (chain === "sepolia") return sepoliaTxUrl(txHashOrSignature);
  if (chain === "solanatestnet") return solanaTxUrl(txHashOrSignature);
  return null;
}

export function settlementAddressUrl(chain: string, address: string): string | null {
  if (chain === "sepolia") return sepoliaAddressUrl(address);
  if (chain === "solanatestnet") return solanaAddressUrl(address);
  return null;
}
