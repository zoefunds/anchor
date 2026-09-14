"use client";

// Dedicated, non-embedded deposit page — the ONE place in this app that
// connects a real wallet and signs a real transaction. Deliberately
// separate from CasePanel.tsx (used by both the full case page and the
// embeddable widget), which has its own documented decision to stay
// wallet-connect-free — this page reverses that decision for itself
// only, not for the embed. Reown AppKit (WalletConnect) for connect/
// account UI, viem (this project's standard everywhere else, not
// ethers) for the actual signed transaction. Sepolia-only, matching
// this project's testnet-only scope everywhere else.
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useAppKitAccount, useAppKitProvider, useAppKitNetwork } from "@reown/appkit/react";
import { createWalletClient, createPublicClient, custom, http, getAddress, isAddressEqual, encodeFunctionData, type Address, type EIP1193Provider } from "viem";
import { sepolia } from "viem/chains";
import { ensureAppKitInitialized } from "@/lib/wallet-appkit";
import { usePublicCase } from "../usePublicCase";

const ESCROW_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "caseId", type: "bytes32" },
      { name: "escrowId", type: "bytes32" },
      { name: "claimant", type: "address" },
      { name: "respondent", type: "address" },
    ],
    outputs: [],
  },
] as const;

/** Matches caseIdToBytes32 in packages/hyperlane-relay/index.ts exactly — a plain UTF-8-to-hex left-padded bytes32, not a hash. Duplicated here (rather than imported) since this is a browser bundle and that package pulls in server-only dependencies. */
function caseIdToBytes32(caseId: string): `0x${string}` {
  const hex = Buffer.from(caseId, "utf-8").toString("hex");
  return `0x${hex.padStart(64, "0")}` as `0x${string}`;
}

const RPC_URL = "https://ethereum-sepolia.publicnode.com";

export default function DepositPage() {
  useEffect(() => {
    ensureAppKitInitialized();
  }, []);
  return <DepositPageInner />;
}

function DepositPageInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const token = searchParams.get("token");
  const { kase, error } = usePublicCase(id, token);

  const { address, isConnected } = useAppKitAccount();
  const { walletProvider } = useAppKitProvider<EIP1193Provider>("eip155");
  const { chainId, switchNetwork } = useAppKitNetwork();

  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Real bug found 2026-09-14: this page is EVM/viem-only throughout
  // (AppKit's EVM adapter, viem's Sepolia chain, getAddress() checksum
  // validation). kase.settlement.chain === "solanatestnet" carries a
  // base58 Solana pubkey, not a hex EVM address — getAddress() on one
  // throws synchronously, which without this guard would crash the
  // whole page (an uncaught error before any of the render-time checks
  // below even run) instead of showing a controlled message. Solana
  // doesn't have a wallet-connect deposit UI yet; this page only ever
  // supported Sepolia.
  const isSepolia = kase?.settlement ? kase.settlement.chain === "sepolia" : true;
  const expectedClaimant = kase?.settlement?.claimantAddress && isSepolia ? getAddress(kase.settlement.claimantAddress) : null;
  const connectedAddress = address ? getAddress(address) : null;
  const isCorrectWallet = !!connectedAddress && !!expectedClaimant && isAddressEqual(connectedAddress, expectedClaimant);
  const isOnSepolia = Number(chainId) === sepolia.id;
  const amountWei = kase?.settlement ? BigInt(kase.settlement.expectedAmountAtto) : null;
  const amountEth = amountWei ? Number(amountWei) / 1e18 : null;

  async function handleDeposit() {
    if (!kase?.settlement || !expectedClaimant || !walletProvider) return;
    setSubmitError(null);
    setIsSigning(true);
    try {
      const walletClient = createWalletClient({ chain: sepolia, transport: custom(walletProvider) });
      const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
      const escrowAddress = getAddress(kase.settlement.escrowContractAddress);
      const respondentAddress = getAddress(kase.settlement.respondentAddress!);
      const data = encodeFunctionData({
        abi: ESCROW_DEPOSIT_ABI,
        functionName: "deposit",
        args: [caseIdToBytes32(kase.id), kase.settlement.escrowId as `0x${string}`, expectedClaimant, respondentAddress],
      });
      const hash = await walletClient.sendTransaction({
        account: expectedClaimant,
        to: escrowAddress,
        data,
        value: BigInt(kase.settlement.expectedAmountAtto),
        chain: sepolia,
      });
      setTxHash(hash);
      setIsSigning(false);
      setIsConfirming(true);
      await publicClient.waitForTransactionReceipt({ hash });
      setIsConfirming(false);
      setIsConfirmed(true);
    } catch (err) {
      setIsSigning(false);
      setIsConfirming(false);
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) {
    return (
      <main className="mx-auto max-w-xl px-8 py-16">
        <p className="text-sm text-status-undetermined">{error}</p>
      </main>
    );
  }
  if (!kase) {
    return (
      <main className="mx-auto max-w-xl px-8 py-16">
        <p className="font-mono text-sm text-muted dark:text-muted-dark">Loading…</p>
      </main>
    );
  }
  if (kase.role !== "claimant") {
    return (
      <main className="mx-auto max-w-xl px-8 py-16">
        <p className="text-sm text-muted dark:text-muted-dark">
          Only the claimant deposits into escrow for this case. If you are the claimant, use the link sent to you.
        </p>
      </main>
    );
  }
  if (!kase.settlement) {
    return (
      <main className="mx-auto max-w-xl px-8 py-16">
        <p className="text-sm text-muted dark:text-muted-dark">This case has no on-chain settlement configured.</p>
      </main>
    );
  }
  if (!isSepolia) {
    return (
      <main className="mx-auto max-w-xl px-8 py-16">
        <p className="kicker mb-2 text-seal-500 dark:text-seal-400">Deposit</p>
        <h1 className="font-display text-2xl font-semibold text-ink-950 dark:text-ink">{kase.claim}</h1>
        <div className="dossier mt-8">
          <p className="text-sm text-muted dark:text-muted-dark">
            This wallet-connect deposit page only supports Sepolia — Solana deposits aren&apos;t available through
            this UI yet. Use the exact values below to deposit manually (e.g. via a Solana CLI script or the
            organization handling this case).
          </p>
          <div className="mt-4 flex flex-col gap-2 font-mono text-xs text-muted dark:text-muted-dark">
            <p>Escrow program: {kase.settlement.escrowContractAddress}</p>
            <p>Escrow case ID: {kase.settlement.escrowId}</p>
            <p>Claimant: {kase.settlement.claimantAddress ?? "not set yet"}</p>
            <p>
              Amount: {Number(kase.settlement.expectedAmountAtto) / 1e9} {kase.settlement.assetSymbol}
            </p>
          </div>
        </div>
      </main>
    );
  }
  if (kase.settlement.status !== "PENDING_DEPOSIT") {
    return (
      <main className="mx-auto max-w-xl px-8 py-16">
        <p className="text-sm text-muted dark:text-muted-dark">
          {kase.settlement.status === "DEPOSITED" && "A deposit has already been confirmed for this case."}
          {kase.settlement.status === "SETTLED" && "This case has already settled."}
          {kase.settlement.status === "MISMATCH_BLOCKED" && "This case's deposit is blocked — contact the organization handling it."}
        </p>
      </main>
    );
  }
  if (!expectedClaimant) {
    return (
      <main className="mx-auto max-w-xl px-8 py-16">
        <p className="text-sm text-muted dark:text-muted-dark">Set your payout address on the case page before depositing.</p>
      </main>
    );
  }
  // Real bug found 2026-09-14: without this check, a claimant who set
  // their own address before the respondent set theirs could get all the
  // way to a MetaMask confirmation prompt, only to have viem's
  // encodeFunctionData throw `Address "null" is invalid` on submit — the
  // deposit() call needs both addresses, but nothing stopped the button
  // from rendering with only one of them known.
  if (!kase.settlement.respondentAddress) {
    return (
      <main className="mx-auto max-w-xl px-8 py-16">
        <p className="text-sm text-muted dark:text-muted-dark">
          Waiting on the respondent to set their payout address before you can deposit — check back once they have.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-8 py-16">
      <p className="kicker mb-2 text-seal-500 dark:text-seal-400">Deposit</p>
      <h1 className="font-display text-2xl font-semibold text-ink-950 dark:text-ink">{kase.claim}</h1>
      <p className="mt-2 font-mono text-xs text-muted dark:text-muted-dark">{kase.id}</p>

      <div className="dossier mt-8">
        <p className="field-label">Amount due</p>
        <p className="mt-1 font-mono text-2xl tabular-nums text-ink-950 dark:text-ink">
          {amountEth} {kase.settlement.assetSymbol}
        </p>
        <p className="mt-1 font-mono text-xs text-muted dark:text-muted-dark">
          Sepolia · escrow {kase.settlement.escrowContractAddress}
        </p>
      </div>

      <div className="mt-6">
        {!isConnected ? (
          <appkit-button />
        ) : !isCorrectWallet ? (
          <div className="dossier">
            <p className="text-sm text-status-undetermined">
              Connected wallet ({connectedAddress}) does not match this case's claimant address ({expectedClaimant}). Connect the correct wallet to deposit.
            </p>
            <appkit-button />
          </div>
        ) : !isOnSepolia ? (
          <button className="btn-primary" onClick={() => switchNetwork(sepolia)}>
            Switch to Sepolia
          </button>
        ) : isConfirmed ? (
          <p className="text-sm text-muted dark:text-muted-dark">
            Deposit confirmed on-chain. This page will update once the app records it — you can also refresh the case page.
          </p>
        ) : (
          <button className="btn-primary" onClick={handleDeposit} disabled={isSigning || isConfirming}>
            {isSigning ? "Confirm in wallet…" : isConfirming ? "Waiting for confirmation…" : `Deposit ${amountEth} ${kase.settlement.assetSymbol}`}
          </button>
        )}
        {txHash && (
          <p className="mt-3 font-mono text-xs text-muted dark:text-muted-dark break-all">
            Tx: <a className="underline" href={`https://sepolia.etherscan.io/tx/${txHash}`} target="_blank" rel="noreferrer">{txHash}</a>
          </p>
        )}
        {submitError && <p className="mt-3 text-sm text-status-undetermined">{submitError}</p>}
      </div>
    </main>
  );
}
