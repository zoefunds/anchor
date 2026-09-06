import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { parseEscrowCaseAccount, normalizeSolanaAddress, toLamports, SolanaEscrowError } from "@/lib/solana-escrow";

// Regression coverage for the manual, from-source Borsh/Anchor account
// parser this module relies on (chains/solana/programs/escrow's Case
// struct has no generated TS decoder) -- built 2026-09-06 as part of
// real Solana deposit tracking (see docs/mainnet-readiness-runbook.md's
// history and lib/hyperlane.ts's dispatch-time gate). A layout mistake
// here would silently misread real on-chain deposit state, so this
// tests the exact byte layout chains/solana/programs/escrow/src/lib.rs
// actually produces, constructed by hand rather than via any shared
// encoder (there isn't one) -- if the two ever drift, this test and
// real on-chain reads should both start failing, not just one silently.

function caseDiscriminator(): Buffer {
  return createHash("sha256").update("account:Case").digest().subarray(0, 8);
}

function buildCaseAccountBytes(params: { caseId: string; claimant: string; respondent: string; adjudicator: string; amountLamports: bigint; status: 0 | 1 | 2; bump: number }): Buffer {
  const caseIdBytes = Buffer.from(params.caseId, "utf8");
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32LE(caseIdBytes.length, 0);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(params.amountLamports, 0);

  return Buffer.concat([
    caseDiscriminator(),
    lenPrefix,
    caseIdBytes,
    new PublicKey(params.claimant).toBuffer(),
    new PublicKey(params.respondent).toBuffer(),
    new PublicKey(params.adjudicator).toBuffer(),
    amountBuf,
    Buffer.from([params.status]),
    Buffer.from([params.bump]),
  ]);
}

const CLAIMANT = "GsNDQ4xViaQNNv9WWhF7siyqZFhqZdLi1yK4xEVfDpo9";
const RESPONDENT = "9W3gTBqgxua2bVZwFU4tgWkf3Tk3gj9JTa312SmEsV7F";
const ADJUDICATOR = "DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN";

describe("parseEscrowCaseAccount", () => {
  it("round-trips a real-shaped Case account (Active status)", () => {
    const data = buildCaseAccountBytes({
      caseId: "CASE-SOL-TEST-20260906",
      claimant: CLAIMANT,
      respondent: RESPONDENT,
      adjudicator: ADJUDICATOR,
      amountLamports: 10_000_000_000n,
      status: 0,
      bump: 254,
    });
    const parsed = parseEscrowCaseAccount(data);
    expect(parsed.caseId).toBe("CASE-SOL-TEST-20260906");
    expect(parsed.claimant).toBe(CLAIMANT);
    expect(parsed.respondent).toBe(RESPONDENT);
    expect(parsed.adjudicator).toBe(ADJUDICATOR);
    expect(parsed.amountLamports).toBe(10_000_000_000n);
    expect(parsed.status).toBe("Active");
  });

  it("decodes Disputed and Settled status tags correctly", () => {
    const disputed = parseEscrowCaseAccount(
      buildCaseAccountBytes({ caseId: "x", claimant: CLAIMANT, respondent: RESPONDENT, adjudicator: ADJUDICATOR, amountLamports: 1n, status: 1, bump: 0 })
    );
    expect(disputed.status).toBe("Disputed");
    const settled = parseEscrowCaseAccount(
      buildCaseAccountBytes({ caseId: "x", claimant: CLAIMANT, respondent: RESPONDENT, adjudicator: ADJUDICATOR, amountLamports: 1n, status: 2, bump: 0 })
    );
    expect(settled.status).toBe("Settled");
  });

  it("rejects data with the wrong discriminator (not actually a Case account)", () => {
    const data = buildCaseAccountBytes({ caseId: "x", claimant: CLAIMANT, respondent: RESPONDENT, adjudicator: ADJUDICATOR, amountLamports: 1n, status: 0, bump: 0 });
    data[0] = data[0] ^ 0xff; // corrupt the discriminator's first byte
    expect(() => parseEscrowCaseAccount(data)).toThrow(SolanaEscrowError);
  });

  it("rejects truncated data rather than reading past the buffer", () => {
    const data = buildCaseAccountBytes({ caseId: "CASE-1", claimant: CLAIMANT, respondent: RESPONDENT, adjudicator: ADJUDICATOR, amountLamports: 1n, status: 0, bump: 0 });
    expect(() => parseEscrowCaseAccount(data.subarray(0, 20))).toThrow(SolanaEscrowError);
  });
});

describe("normalizeSolanaAddress", () => {
  it("accepts a real base58 pubkey", () => {
    expect(normalizeSolanaAddress(CLAIMANT)).toBe(CLAIMANT);
  });
  it("rejects an EVM-style hex address", () => {
    expect(normalizeSolanaAddress("0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb")).toBeNull();
  });
  it("rejects garbage input", () => {
    expect(normalizeSolanaAddress("not-a-pubkey")).toBeNull();
    expect(normalizeSolanaAddress(null)).toBeNull();
    expect(normalizeSolanaAddress(undefined)).toBeNull();
  });
});

describe("toLamports", () => {
  it("converts whole SOL amounts", () => {
    expect(toLamports("10")).toBe(10_000_000_000n);
  });
  it("converts fractional SOL amounts to the exact lamport count", () => {
    expect(toLamports("0.000000001")).toBe(1n);
    expect(toLamports("1.5")).toBe(1_500_000_000n);
  });
  it("rejects more than 9 fractional digits (would lose precision)", () => {
    expect(() => toLamports("1.0000000001")).toThrow(SolanaEscrowError);
  });
  it("rejects negative amounts", () => {
    expect(() => toLamports("-1")).toThrow(SolanaEscrowError);
  });
});
