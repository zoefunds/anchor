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

/**
 * Converts a decimal currency amount to atto-scale (value * 10^18) as used
 * by the contract's u256 atto_amount field. Takes the exact decimal
 * string (e.g. Prisma's Decimal.toString(), not Number(decimal)) and
 * scales it with BigInt arithmetic — `Number(amount) * 1e18` loses real
 * precision the moment the amount has enough digits to exceed
 * Number.MAX_SAFE_INTEGER once multiplied by 1e18 (any amount with a
 * fractional part already does, since 1e18 alone exceeds it), silently
 * settling a slightly wrong sum. Rejects negative amounts — a case's
 * disputed amount is never meaningfully negative, and letting one
 * through would flow into a u256 field the contract can't represent
 * negative values in anyway.
 */
export function toAttoAmount(amount: number | string): bigint {
  const str = typeof amount === "number" ? amount.toString() : amount;
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`toAttoAmount: not a valid decimal string: ${str}`);
  }
  if (str.startsWith("-")) {
    throw new Error(`toAttoAmount: amount must not be negative: ${str}`);
  }
  const [whole, frac = ""] = str.split(".");
  // Real P1 fixed here (external audit finding): this used to silently
  // slice off any fractional digits beyond 18 (`(frac + "0"*18).slice(0,
  // 18)` discards excess digits instead of rejecting them) — a caller
  // sending e.g. "1.1234567890123456789" (19 fractional digits) would
  // have that final digit silently dropped rather than the request
  // failing, which is exactly the kind of silent precision loss that's
  // unacceptable for a financial amount. Reject instead.
  if (frac.length > 18) {
    throw new Error(`toAttoAmount: amount has more than 18 fractional digits, would lose precision: ${str}`);
  }
  const fracPadded = frac.padEnd(18, "0");
  return BigInt(whole) * 10n ** 18n + BigInt(fracPadded || "0");
}
