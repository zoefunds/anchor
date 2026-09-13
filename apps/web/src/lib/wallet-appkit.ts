"use client";

// Reown AppKit (WalletConnect) config — deliberately scoped to ONE page
// (/public/cases/[id]/deposit), not the whole app. CasePanel.tsx and the
// embeddable widget stay wallet-connect-free by design (see that file's
// own header comment); this is the dedicated, non-embedded page where a
// real party connects a real wallet to submit a real deposit
// transaction. Sepolia only — this project is testnet-only end to end.
//
// Uses AppKit's Ethers adapter (not the Wagmi adapter) purely for
// dependency stability: at the time this was built, @reown/appkit-adapter-wagmi's
// latest release pulled in a broken chain of transitive dependencies
// (@wagmi/connectors' "tempo"/Coinbase Smart Wallet x402-payment code
// referencing several @x402/* packages that were never published, plus
// a wagmi-major/@wagmi-core-major mismatch when pinned to an older
// release) — confirmed by direct reproduction, not assumed. The actual
// on-chain write below uses viem (this project's standard everywhere
// else), not ethers — only AppKit's connect/account/provider plumbing
// comes from the ethers adapter; ethers itself is never used to sign or
// send anything here.
import { createAppKit } from "@reown/appkit/react";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { sepolia } from "@reown/appkit/networks";

// Public, not a secret — a WalletConnect/Reown projectId identifies the
// dApp to the WalletConnect relay network, it does not grant any signing
// authority or access to funds.
const PROJECT_ID = "58f30ed6f8129baf75e096bc9bef3d0f";

let appKitInitialized = false;

/** Idempotent — Next.js can re-render/re-mount the deposit page client component more than once per session; createAppKit itself is not safe to call twice. */
export function ensureAppKitInitialized() {
  if (appKitInitialized) return;
  createAppKit({
    adapters: [new EthersAdapter()],
    networks: [sepolia],
    projectId: PROJECT_ID,
    metadata: {
      name: "Anchor — Deposit",
      description: "Submit a real on-chain escrow deposit for an Anchor dispute case (Sepolia testnet).",
      url: typeof window !== "undefined" ? window.location.origin : "https://anchor.example",
      icons: [],
    },
    features: { analytics: false, email: false, socials: [] },
  });
  appKitInitialized = true;
}
