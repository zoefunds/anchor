import { readFileSync } from "fs";
import path from "path";

import { createGenLayerClient, type AnchorGenLayerClient, type GenLayerNetwork } from "@anchor/genlayer-sdk";
import { acquireGenLayerSlot } from "@/lib/genlayer-rate-limit";

// Repo layout: apps/web/src/lib -> ../../../.. -> repo root -> genlayer/contracts
const ADJUDICATOR_CONTRACT_PATH = path.resolve(
  process.cwd(),
  "../../genlayer/contracts/adjudicator.py"
);

let cachedContractCode: string | null = null;

export function getAdjudicatorContractCode(): string {
  if (!cachedContractCode) {
    cachedContractCode = readFileSync(ADJUDICATOR_CONTRACT_PATH, "utf-8");
  }
  return cachedContractCode;
}

/**
 * Every method on the returned client acquires a global (Redis-backed,
 * cross-process) rate-limit slot before making its real GenLayer network
 * call — see lib/genlayer-rate-limit.ts for why this has to be
 * cross-process rather than a simple in-memory guard.
 */
export function getGenLayerClient(): AnchorGenLayerClient {
  const rawKey = process.env.GENLAYER_PRIVATE_KEY;
  if (!rawKey) {
    throw new Error("GENLAYER_PRIVATE_KEY is not set — see apps/web/.env.example");
  }
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
  const network = (process.env.GENLAYER_NETWORK ?? "studionet") as GenLayerNetwork;

  const client = createGenLayerClient({ network, privateKey });

  return {
    async deployCase(params) {
      await acquireGenLayerSlot();
      return client.deployCase(params);
    },
    async runAdjudication(contractAddress, params) {
      await acquireGenLayerSlot();
      return client.runAdjudication(contractAddress, params);
    },
    async appealCase(contractAddress) {
      await acquireGenLayerSlot();
      return client.appealCase(contractAddress);
    },
    async getDecision(contractAddress) {
      await acquireGenLayerSlot();
      return client.getDecision(contractAddress);
    },
    async getStatus(contractAddress) {
      await acquireGenLayerSlot();
      return client.getStatus(contractAddress);
    },
  };
}

/** Converts a decimal currency amount (e.g. 1000.00) to atto-scale (value * 10^18) as used by the contract's u256 atto_amount field. */
export function toAttoAmount(amount: number): bigint {
  return BigInt(Math.round(amount * 1e18));
}
