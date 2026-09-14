"use client";

// Solana wallet-connect for the same dedicated, non-embedded deposit
// page that already handles Sepolia via Reown AppKit (wallet-appkit.ts)
// — Solana has its own, unrelated wallet-connect stack (no shared
// account/provider abstraction with EVM), so this is a second, parallel
// provider rather than a shared one. @solana/wallet-adapter-react's
// standard-wallet detection auto-discovers any installed wallet
// (Phantom, Solflare, Backpack, ...) that implements the Wallet
// Standard, so no explicit adapter list is needed. Devnet only, matching
// SOLANA_RPC_URL server-side (see solana-settle.ts) — this project is
// testnet/devnet-only end to end.
import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";

export const SOLANA_DEVNET_RPC_URL = "https://api.devnet.solana.com";

export function SolanaWalletProvider({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={SOLANA_DEVNET_RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export { WalletMultiButton };
