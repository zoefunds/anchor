// A single, shared place to construct block-explorer URLs — every
// tx hash/address shown anywhere in the UI or in a generated receipt
// should link out via one of these, not a hand-rolled URL, so a wrong
// cluster/network never gets duplicated across call sites (real bug
// found and fixed here 2026-09-12: deposit-execution.ts's Solana
// explorerUrl hardcoded cluster=devnet while this project's actual
// SOLANA_RPC_URL is api.testnet.solana.com — testnet, not devnet;
// explorer.solana.com treats those as genuinely different clusters, so
// the old link pointed at a transaction that would never be found).

export function sepoliaTxUrl(txHash: string): string {
  return `https://sepolia.etherscan.io/tx/${txHash}`;
}

export function sepoliaAddressUrl(address: string): string {
  return `https://sepolia.etherscan.io/address/${address}`;
}

export function solanaTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=testnet`;
}

export function solanaAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=testnet`;
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
