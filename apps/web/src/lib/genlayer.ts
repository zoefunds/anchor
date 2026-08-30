import { readFileSync } from "fs";
import path from "path";

import { createGenLayerClient, type GenLayerNetwork } from "@anchor/genlayer-sdk";

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

export function getGenLayerClient() {
  const rawKey = process.env.GENLAYER_PRIVATE_KEY;
  if (!rawKey) {
    throw new Error("GENLAYER_PRIVATE_KEY is not set — see apps/web/.env.example");
  }
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
  const network = (process.env.GENLAYER_NETWORK ?? "studionet") as GenLayerNetwork;

  return createGenLayerClient({ network, privateKey });
}

/** Converts a decimal currency amount (e.g. 1000.00) to atto-scale (value * 10^18) as used by the contract's u256 atto_amount field. */
export function toAttoAmount(amount: number): bigint {
  return BigInt(Math.round(amount * 1e18));
}
