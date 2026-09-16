"use client";

// Solana counterpart to this directory's main page.tsx (Sepolia/viem).
// Builds the exact same `initializeCase` instruction the operator's own
// scripts/claimant-deposit-solana-devnet.ts signs from a local keypair
// file — see @anchor/solana-escrow-client's own header comment — but
// signs it with the party's own connected browser wallet instead.
import { useCallback, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import type { Wallet } from "@coral-xyz/anchor";
import { getEscrowProgram, buildInitializeCaseInstruction } from "@anchor/solana-escrow-client";
import { confirmTransactionBounded } from "@/lib/solana-confirm";
import { WalletMultiButton } from "@/lib/wallet-solana";
import type { PublicSettlement } from "../usePublicCase";

const STORAGE_SEED_PARTS = [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")];

function deriveEscrowAuthorityPda(decisionRelayProgramId: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(STORAGE_SEED_PARTS, new PublicKey(decisionRelayProgramId));
  return pda;
}

export function SolanaDeposit({ settlement }: { settlement: PublicSettlement }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, signTransaction, connected } = wallet;

  const [txSignature, setTxSignature] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const amountSol = Number(settlement.expectedAmountAtto) / 1e9;
  const expectedClaimant = settlement.claimantAddress;
  const connectedBase58 = publicKey?.toBase58() ?? null;
  const isCorrectWallet = !!connectedBase58 && !!expectedClaimant && connectedBase58 === expectedClaimant;

  // Read-only wallet stand-in — only used to build the instruction via
  // anchor's typed program.methods, never to sign or send anything (the
  // real send below goes through the party's own connected wallet).
  // `payer` is required by anchor's Wallet type but never touched here —
  // any keypair works since it's never used to sign.
  const readonlyWallet = useMemo<Wallet>(
    () => ({
      publicKey: publicKey ?? PublicKey.default,
      payer: Keypair.generate(),
      // eslint-disable-next-line @typescript-eslint/require-await
      signTransaction: async <T,>(tx: T) => tx,
      // eslint-disable-next-line @typescript-eslint/require-await
      signAllTransactions: async <T,>(txs: T[]) => txs,
    }),
    [publicKey]
  );

  const handleDeposit = useCallback(async () => {
    if (!publicKey || !signTransaction || !settlement.decisionRelayProgramId || !settlement.respondentAddress) return;
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const program = getEscrowProgram(connection, readonlyWallet, settlement.escrowContractAddress);
      const escrowAuthorityPda = deriveEscrowAuthorityPda(settlement.decisionRelayProgramId);
      const { instruction } = await buildInitializeCaseInstruction({
        program,
        claimant: publicKey,
        onChainCaseId: settlement.escrowId,
        respondent: new PublicKey(settlement.respondentAddress),
        adjudicator: escrowAuthorityPda,
        amountLamports: BigInt(settlement.expectedAmountAtto),
      });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: publicKey }).add(instruction);

      const signed = await signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize());
      setTxSignature(signature);
      setIsSubmitting(false);
      setIsConfirming(true);
      // Bounded polling, not connection.confirmTransaction's websocket
      // subscription — the 2026-09-12 Sepolia delivery incident found
      // that subscription can hang indefinitely (40+ minutes observed)
      // against a public RPC that never pushes the notification; a
      // wallet-connected browser tab is exactly where a silent hang
      // would be worst (the user has no server log to check).
      await confirmTransactionBounded({ connection, signature, lastValidBlockHeight, commitment: "confirmed" });
      setIsConfirming(false);
      setIsConfirmed(true);
    } catch (err) {
      setIsSubmitting(false);
      setIsConfirming(false);
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }, [publicKey, signTransaction, settlement, connection, readonlyWallet]);

  return (
    <div className="mt-6">
      <p className="mt-1 font-mono text-xs text-muted dark:text-muted-dark">
        Solana Devnet · escrow {settlement.escrowContractAddress} · case {settlement.escrowId}
      </p>
      <div className="mt-4">
        {!connected ? (
          <WalletMultiButton />
        ) : !isCorrectWallet ? (
          <div className="dossier">
            <p className="text-sm text-status-undetermined">
              Connected wallet ({connectedBase58}) does not match this case&apos;s claimant address ({expectedClaimant}). Connect the
              correct wallet to deposit.
            </p>
            <WalletMultiButton />
          </div>
        ) : isConfirmed ? (
          <p className="text-sm text-muted dark:text-muted-dark">
            Deposit confirmed on-chain. This page will update once the app records it. You can also refresh the case page.
          </p>
        ) : (
          <button className="btn-primary" onClick={handleDeposit} disabled={isSubmitting || isConfirming}>
            {isSubmitting ? "Confirm in wallet…" : isConfirming ? "Waiting for confirmation…" : `Deposit ${amountSol} SOL`}
          </button>
        )}
        {txSignature && (
          <p className="mt-3 font-mono text-xs text-muted dark:text-muted-dark break-all">
            Tx:{" "}
            <a className="underline" href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`} target="_blank" rel="noreferrer">
              {txSignature}
            </a>
          </p>
        )}
        {submitError && <p className="mt-3 text-sm text-status-undetermined">{submitError}</p>}
      </div>
    </div>
  );
}
