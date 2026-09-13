import type { Connection } from "@solana/web3.js";

// Shared bounded transaction-confirmation helper — see the 2026-09-12
// Sepolia delivery incident's Phase G: connection.confirmTransaction's
// websocket subscription hung indefinitely (40+ minutes observed, no
// error, no progress) against a public Solana RPC that never pushed the
// subscription notification. Every production Solana confirmation path
// must poll with a bounded timeout instead of trusting that
// subscription to ever resolve.
export class SolanaConfirmationError extends Error {}
export class SolanaConfirmationTimeoutError extends SolanaConfirmationError {}
export class SolanaTransactionFailedError extends SolanaConfirmationError {
  constructor(public readonly signature: string, public readonly err: unknown) {
    super(`transaction ${signature} failed: ${JSON.stringify(err)}`);
  }
}
export class SolanaBlockhashExpiredError extends SolanaConfirmationError {
  constructor(public readonly signature: string) {
    super(`transaction ${signature} expired (blockhash no longer valid) before confirming`);
  }
}

/**
 * Polls getSignatureStatus with a bounded timeout instead of the
 * websocket-based connection.confirmTransaction, which has no timeout
 * of its own and can hang forever against an RPC that doesn't reliably
 * push subscription notifications. Throws a typed error distinguishing
 * "never confirmed in time" from "confirmed but the transaction itself
 * failed" from "blockhash expired first" — callers should not treat
 * these the same way (a caller retrying after a timeout must not
 * assume it's safe to resubmit without checking whether the original
 * transaction actually landed).
 */
export async function confirmTransactionBounded(params: {
  connection: Connection;
  signature: string;
  lastValidBlockHeight: number;
  commitment?: "confirmed" | "finalized";
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const { connection, signature, lastValidBlockHeight, commitment = "confirmed", timeoutMs = 60_000, pollIntervalMs = 2_000 } = params;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatus(signature);
    if (value?.err) throw new SolanaTransactionFailedError(signature, value.err);
    if (value?.confirmationStatus === commitment || value?.confirmationStatus === "finalized") return;
    const height = await connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) throw new SolanaBlockhashExpiredError(signature);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new SolanaConfirmationTimeoutError(`timed out after ${timeoutMs}ms waiting for transaction ${signature} to reach ${commitment}`);
}
