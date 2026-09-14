import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

// Regression tests for two real bugs found via live E2E testnet testing
// (see solana-settle.ts's own inline comments at the fix sites):
//
// 1. validateExternalAttestations used to cap accepted external
//    attestations at ATTESTOR_PUBKEYS.length - 1 (total registered
//    attestors minus the backend's own slot) instead of
//    ATTESTOR_THRESHOLD - 1. With 3 attestors registered but a 2-of-3
//    threshold, that let an extra, unneeded Ed25519 instruction into the
//    transaction, overflowing a fixed-size serialization buffer.
//
// 2. submitAttestedSettle's Address Lookup Table extension was missing
//    casePda from the dynamic per-case addresses list (only
//    claimant/respondent), so real transactions could still exceed
//    Solana's 1232-byte legacy limit.

process.env.SOLANA_ATTESTOR_PRIVATE_KEY = JSON.stringify(Array.from(Keypair.generate().secretKey));
process.env.SOLANA_RELAY_PRIVATE_KEY = JSON.stringify(Array.from(Keypair.generate().secretKey));

const { validateExternalAttestations, ATTESTOR_PUBKEYS, getSolanaAttestorThreshold } = await import("@/lib/solana-settle");

function fakeExternalAttestation(publicKeyB58: string) {
  return {
    publicKey: new PublicKey(publicKeyB58).toBytes(),
    signature: new Uint8Array(64).fill(1),
  };
}

describe("validateExternalAttestations caps at ATTESTOR_THRESHOLD - 1, not ATTESTOR_PUBKEYS.length - 1", () => {
  it("never returns more than threshold - 1 entries even when every other registered attestor supplies one", () => {
    const threshold = getSolanaAttestorThreshold();
    // Real registered attestor pubkeys, excluding whichever one is the
    // backend's own key generated above (none of ATTESTOR_PUBKEYS match
    // it, since it's freshly generated) — simulates every other
    // registered attestor submitting a signature at once, which is
    // exactly the "3 attestors registered, 2-of-2 needed" scenario that
    // triggered the live bug.
    const externals = ATTESTOR_PUBKEYS.map(fakeExternalAttestation);
    const backendKeypair = Keypair.generate();

    const result = validateExternalAttestations(externals, backendKeypair.publicKey.toBytes());

    expect(result.length).toBeLessThanOrEqual(threshold - 1);
    // The historical bug: with ATTESTOR_PUBKEYS.length > threshold, the
    // old (buggy) cap of ATTESTOR_PUBKEYS.length - 1 would let through
    // more than threshold - 1 whenever more than threshold registered
    // attestors exist. Assert the two only coincide when there ISN'T
    // a spare attestor beyond the threshold, i.e. this assertion is only
    // meaningful (and was only ever violated) when there IS a spare.
    if (ATTESTOR_PUBKEYS.length > threshold) {
      expect(result.length).not.toBe(ATTESTOR_PUBKEYS.length - 1);
    }
  });

  it("still accepts exactly enough externals to reach the threshold when only that many are supplied", () => {
    const threshold = getSolanaAttestorThreshold();
    const externals = ATTESTOR_PUBKEYS.slice(0, threshold - 1).map(fakeExternalAttestation);
    const backendKeypair = Keypair.generate();

    const result = validateExternalAttestations(externals, backendKeypair.publicKey.toBytes());

    expect(result.length).toBe(threshold - 1);
  });
});

describe("submitAttestedSettle's Address Lookup Table extension includes casePda", () => {
  it("extends the lookup table with claimant, respondent, AND casePda — not just the two parties", async () => {
    vi.resetModules();
    const escrowProgramKeypair = Keypair.generate();
    const decisionRelayProgramKeypair = Keypair.generate();
    const claimant = Keypair.generate().publicKey;
    const respondent = Keypair.generate().publicKey;
    const lookupTableAddress = Keypair.generate().publicKey;

    process.env.SOLANA_DECISION_RELAY_LOOKUP_TABLE = lookupTableAddress.toBase58();
    process.env.SOLANA_ATTESTOR_PRIVATE_KEY = JSON.stringify(Array.from(Keypair.generate().secretKey));
    process.env.SOLANA_RELAY_PRIVATE_KEY = JSON.stringify(Array.from(Keypair.generate().secretKey));

    const extendedAddressSets: string[][] = [];

    const web3 = await import("@solana/web3.js");
    const realExtend = web3.AddressLookupTableProgram.extendLookupTable.bind(web3.AddressLookupTableProgram);
    vi.spyOn(web3.AddressLookupTableProgram, "extendLookupTable").mockImplementation((args: any) => {
      extendedAddressSets.push(args.addresses.map((a: InstanceType<typeof PublicKey>) => a.toBase58()));
      return realExtend(args);
    });

    const fakeConnection = {
      // Real Devnet genesis hash — submitAttestedSettle now verifies the
      // connected cluster's live identity before signing/submitting
      // anything (2026-09-14 fix, see solana-settle.ts's
      // assertConnectedToExpectedSolanaCluster); without this, the fake
      // connection's undefined getGenesisHash() throws before ever
      // reaching the ALT extension code this test actually covers.
      getGenesisHash: vi.fn().mockResolvedValue("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"),
      getAddressLookupTable: vi.fn().mockResolvedValue({ value: { state: { addresses: [] } } }),
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 }),
      sendTransaction: vi.fn().mockResolvedValue("fake-signature-1111111111111111111111111111111111111111111111111"),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    };

    vi.doMock("@solana/web3.js", async () => {
      const actual = await vi.importActual<typeof import("@solana/web3.js")>("@solana/web3.js");
      return { ...actual, Connection: vi.fn().mockImplementation(function () { return fakeConnection; }) };
    });

    const { submitAttestedSettle } = await import("@/lib/solana-settle");

    // The rest of the function (compiling/serializing a v0 message
    // against a lookup table whose local mock never actually reflects
    // the extension) isn't what this test is about — only that the ALT
    // extension call itself was made with the right addresses. Whatever
    // happens after that call is irrelevant here.
    await submitAttestedSettle(
      {
        decisionRelayProgramId: decisionRelayProgramKeypair.publicKey.toBase58(),
        caseId: "regression-test-case-id",
        claimant: claimant.toBase58(),
        respondent: respondent.toBase58(),
        escrowProgram: escrowProgramKeypair.publicKey.toBase58(),
        claimantShareBps: 10000,
        respondentShareBps: 0,
        decisionHash: Buffer.alloc(32, 7),
      },
      "http://127.0.0.1:8899",
      [fakeExternalAttestation(ATTESTOR_PUBKEYS[0])]
    ).catch(() => {});

    expect(extendedAddressSets.length).toBe(1);
    const extended = extendedAddressSets[0];
    expect(extended).toContain(claimant.toBase58());
    expect(extended).toContain(respondent.toBase58());
    // The actual historical bug: casePda used to be missing from this
    // list entirely, which meant a real transaction could still overflow
    // Solana's 1232-byte legacy-format limit.
    expect(extended.length).toBe(3);

    vi.restoreAllMocks();
    delete process.env.SOLANA_DECISION_RELAY_LOOKUP_TABLE;
  });
});
