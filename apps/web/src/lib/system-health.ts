import IORedis from "ioredis";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { Connection } from "@solana/web3.js";

// Phase 3's ops-console route and Phase 5's public /api/status route
// both need "is DB/Redis/EVM RPC/Solana RPC reachable" — pulled out
// here once so neither duplicates the other's connection logic. Kept
// deliberately dumb: each function reports ok/error, nothing about
// caller-specific business data (pending signatures, balances, etc.
// stays in ops-console/route.ts, which is platform-admin-only).

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number | null;
  error?: string;
}

export async function checkDb(): Promise<HealthCheckResult> {
  const { prisma } = await import("@/lib/prisma");
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function checkRedis(): Promise<HealthCheckResult> {
  const url = process.env.REDIS_URL;
  if (!url) return { ok: false, latencyMs: null, error: "REDIS_URL not set" };
  const client = new IORedis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true });
  const start = Date.now();
  try {
    await client.connect();
    await client.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.disconnect();
  }
}

export interface RpcCheckResult<T> {
  ok: boolean;
  value: T | null;
  error?: string;
}

export async function checkSepoliaRpc(): Promise<RpcCheckResult<string>> {
  try {
    const client = createPublicClient({ chain: sepolia, transport: http(process.env.HYPERLANE_RELAY_RPC_URL) });
    const block = await client.getBlockNumber();
    return { ok: true, value: block.toString() };
  } catch (err) {
    return { ok: false, value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function checkSolanaRpc(): Promise<RpcCheckResult<number>> {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) return { ok: false, value: null, error: "SOLANA_RPC_URL not set" };
  try {
    const connection = new Connection(rpcUrl, "confirmed");
    const slot = await connection.getSlot();
    return { ok: true, value: slot };
  } catch (err) {
    return { ok: false, value: null, error: err instanceof Error ? err.message : String(err) };
  }
}
