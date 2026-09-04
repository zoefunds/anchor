import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { parseEther, keccak256, encodeAbiParameters, pad, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import {
  startAnvil,
  stopAnvil,
  getTestClient,
  getPublicClient,
  getWalletClient,
  deploy,
  ARTIFACTS,
  ANVIL_RPC_URL,
  DEV_PRIVATE_KEYS,
} from "./anvil-harness";

// Priority 1 (settlement-readiness gaps): real Anvil-based integration
// tests. Every contract here is genuinely deployed and every read is a
// genuine ABI-decoded response from that real deployment — no
// `vi.mock("viem", ...)` anywhere in this file. This is deliberately
// the test class that would have caught the deposits() ABI-shape bug
// (case-settlement.ts/reconciliation.ts assuming a 5-output V2 shape
// against the real 4-output V1 contract) before production, since a
// mocked readContract call can't disagree with a real contract's
// actual bytecode.

process.env.HYPERLANE_RELAY_RPC_URL = ANVIL_RPC_URL;

const DEPLOYER = DEV_PRIVATE_KEYS[0];
const OWNER = DEV_PRIVATE_KEYS[1];
const ATTESTOR_1_KEY = DEV_PRIVATE_KEYS[2];
const ATTESTOR_2_KEY = DEV_PRIVATE_KEYS[3];
const STRANGER_KEY = DEV_PRIVATE_KEYS[4];
const CLAIMANT_KEY = DEV_PRIVATE_KEYS[5];
const CLAIMANT = privateKeyToAccount(CLAIMANT_KEY).address;
const RESPONDENT = privateKeyToAccount(DEV_PRIVATE_KEYS[6]).address;

// Real audit fix (finding #2): every V2 escrow deposit in this file
// now needs a prior authorizeDeposit() call (from DEPLOYER, the fixture's
// depositAuthorizer — see deploySystem()) before deposit() will accept
// anything for that escrowId, and the deposit call itself must come
// from the CLAIMANT wallet (finding #3's msg.sender == claimant check),
// never DEPLOYER directly as this file used to do throughout.
async function authorizeAndDeposit(params: {
  escrowV2: Address;
  caseId: Hex;
  escrowId: Hex;
  claimant?: Address;
  respondent?: Address;
  value: bigint;
}) {
  const claimant = params.claimant ?? CLAIMANT;
  const respondent = params.respondent ?? RESPONDENT;
  await getWalletClient(DEPLOYER).writeContract({
    address: params.escrowV2,
    abi: ARTIFACTS.escrowV2.abi as never,
    functionName: "authorizeDeposit",
    args: [params.caseId, params.escrowId, claimant, respondent, params.value],
  });
  const hash = await getWalletClient(CLAIMANT_KEY).writeContract({
    address: params.escrowV2,
    abi: ARTIFACTS.escrowV2.abi as never,
    functionName: "deposit",
    args: [params.caseId, params.escrowId, claimant, respondent],
    value: params.value,
  });
  return hash;
}

const ORIGIN_DOMAIN = 11155111; // matches HYPERLANE_DOMAIN.sepolia used throughout the app

const SettlementMode = { UNCONFIGURED: 0, SETTLEMENT: 1, NOTIFICATION_ONLY: 2 } as const;

async function signHash(privateKey: Hex, hash: Hex): Promise<Hex> {
  const sig = await sign({ hash, privateKey });
  const v = sig.v ?? (sig.yParity === 0 ? 27n : 28n);
  return (sig.r + sig.s.slice(2) + v.toString(16).padStart(2, "0")) as Hex;
}

/** Deploys a fresh, fully-wired system: FakeMailbox + DecisionRelay (2-of-2: attestor1/attestor2) + a V1 and a V2 Escrow, both bound to the same DecisionRelay. */
async function deploySystem() {
  const attestor1 = privateKeyToAccount(ATTESTOR_1_KEY).address;
  const attestor2 = privateKeyToAccount(ATTESTOR_2_KEY).address;
  const ownerAddress = privateKeyToAccount(OWNER).address;

  const mailbox = await deploy(DEPLOYER, ARTIFACTS.fakeMailbox);
  const decisionRelay = await deploy(DEPLOYER, ARTIFACTS.decisionRelay, [
    mailbox,
    ownerAddress,
    "0x0000000000000000000000000000000000000000",
    [attestor1, attestor2],
    2n,
  ]);
  const escrowV1 = await deploy(DEPLOYER, ARTIFACTS.escrowV1, [decisionRelay]);
  const THIRTY_DAYS = 30n * 24n * 60n * 60n;
  // depositAuthorizer: real audit fix (finding #2) — DEPLOYER doubles
  // as the trusted authorizer here, same as it already deploys and
  // configures everything else in this test's fixture.
  const depositAuthorizerAddress = privateKeyToAccount(DEPLOYER).address;
  const escrowV2 = await deploy(DEPLOYER, ARTIFACTS.escrowV2, [decisionRelay, depositAuthorizerAddress, THIRTY_DAYS]);

  const ownerWallet = getWalletClient(OWNER);
  await ownerWallet.writeContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "setTrustedSender", args: [ORIGIN_DOMAIN, pad(mailbox, { size: 32 })] });

  return { mailbox, decisionRelay, escrowV1, escrowV2, attestor1, attestor2, ownerAddress };
}

function caseIdBytes32(caseId: string): Hex {
  return pad(`0x${Buffer.from(caseId).toString("hex")}` as Hex, { size: 32 });
}

function decisionAttestationHash(params: {
  decisionRelay: Address;
  origin: number;
  caseId: Hex;
  outcome: string;
  claimantAmount: bigint;
  respondentAmount: bigint;
  escrowId: Hex;
  proofHash: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint32" }, { type: "address" }, { type: "bytes32" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
      [
        "ANCHOR_DECISION_ATTESTATION_V2",
        params.origin,
        params.decisionRelay,
        params.caseId,
        params.outcome,
        params.claimantAmount,
        params.respondentAmount,
        params.escrowId,
        params.proofHash,
      ]
    )
  );
}

function emergencyRefundHash(params: { decisionRelay: Address; target: Address; caseId: Hex; escrowId: Hex; proofHash: Hex }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      ["ANCHOR_EMERGENCY_REFUND_V1", params.decisionRelay, params.target, params.caseId, params.escrowId, params.proofHash]
    )
  );
}

/**
 * Real fix found while writing this suite: viem's `writeContract`
 * resolves as soon as the node ACCEPTS and broadcasts a transaction —
 * for a json-rpc (impersonated) account with no local simulation, that
 * resolution happens before the transaction is even mined, so it
 * resolves with a real tx hash regardless of whether execution
 * ultimately reverts. Asserting `.rejects.toThrow()` directly on such
 * a call proves nothing. `simulateContract` performs a real eth_call
 * against current state first and throws synchronously on revert —
 * this is the correct way to assert "this call reverts."
 */
async function expectHandleReverts(mailbox: Address, decisionRelay: Address, origin: number, sender: Hex, body: Hex): Promise<unknown> {
  const testClient = getTestClient();
  await testClient.impersonateAccount({ address: mailbox });
  await testClient.setBalance({ address: mailbox, value: parseEther("10") });
  const publicClient = getPublicClient();
  return publicClient.simulateContract({
    address: decisionRelay,
    abi: ARTIFACTS.decisionRelay.abi as never,
    functionName: "handle",
    args: [origin, sender, body],
    account: mailbox,
  });
}

async function callHandle(mailbox: Address, decisionRelay: Address, origin: number, sender: Hex, body: Hex) {
  const testClient = getTestClient();
  await testClient.impersonateAccount({ address: mailbox });
  await testClient.setBalance({ address: mailbox, value: parseEther("10") });
  const publicClient = getPublicClient();
  const { request } = await publicClient.simulateContract({
    address: decisionRelay,
    abi: ARTIFACTS.decisionRelay.abi as never,
    functionName: "handle",
    args: [origin, sender, body],
    account: mailbox,
  });
  const hash = await getWalletClient(DEPLOYER).writeContract({ ...request, account: mailbox } as never);
  return publicClient.waitForTransactionReceipt({ hash });
}

describe("Real Anvil settlement integration (Priority 1)", () => {
  beforeAll(async () => {
    await startAnvil();
  }, 30_000);

  afterAll(() => {
    stopAnvil();
  });

  let snapshotId: Hex;
  afterEach(async () => {
    // no-op placeholder kept for symmetry — each test deploys its own
    // fresh system rather than relying on snapshot/revert, so state
    // never leaks between tests even if a later refactor adds shared
    // fixtures.
  });

  it("V1 Escrow: deposits() decodes as a real 4-field response, no caseId", async () => {
    const { escrowV1 } = await deploySystem();
    const publicClient = getPublicClient();
    const escrowId = keccak256(toHex("escrow-v1-decode-test"));

    const walletClient = getWalletClient(DEPLOYER);
    const hash = await walletClient.writeContract({
      address: escrowV1,
      abi: ARTIFACTS.escrowV1.abi as never,
      functionName: "deposit",
      args: [caseIdBytes32("case-1"), escrowId, CLAIMANT, RESPONDENT],
      value: parseEther("1"),
    });
    await publicClient.waitForTransactionReceipt({ hash });

    // Real V1 ABI (4 outputs) decodes cleanly.
    const result = await publicClient.readContract({
      address: escrowV1,
      abi: [{ type: "function", name: "deposits", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }] }],
      functionName: "deposits",
      args: [escrowId],
    });
    expect(result).toEqual([1, CLAIMANT, RESPONDENT, parseEther("1")]);

    // The real bug this suite exists to prevent: a 5-output ABI
    // (with caseId) against the real V1 contract fails to decode.
    await expect(
      publicClient.readContract({
        address: escrowV1,
        abi: [
          {
            type: "function",
            name: "deposits",
            stateMutability: "view",
            inputs: [{ type: "bytes32" }],
            outputs: [{ type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
          },
        ],
        functionName: "deposits",
        args: [escrowId],
      })
    ).rejects.toThrow();
  });

  it("V2 Escrow: deposits() decodes as a real 6-field response, including caseId and depositedAt", async () => {
    const { escrowV2 } = await deploySystem();
    const publicClient = getPublicClient();
    const escrowId = keccak256(toHex("escrow-v2-decode-test"));
    const caseId = caseIdBytes32("case-2");

    const hash = await authorizeAndDeposit({ escrowV2, caseId, escrowId, value: parseEther("2") });
    await publicClient.waitForTransactionReceipt({ hash });

    const result = await publicClient.readContract({
      address: escrowV2,
      abi: ARTIFACTS.escrowV2.abi as never,
      functionName: "deposits",
      args: [escrowId],
    });
    // status, claimant, respondent, amount, caseId, depositedAt — the
    // real live shape, which is why a hardcoded assumption about "the"
    // deposits() shape is exactly what Priority 2 (explicit,
    // verified contract-version detection) exists to replace.
    const [status, claimant, respondent, amount, returnedCaseId, depositedAt] = result as [number, string, string, bigint, string, bigint];
    expect(status).toBe(1);
    expect(claimant).toBe(CLAIMANT);
    expect(respondent).toBe(RESPONDENT);
    expect(amount).toBe(parseEther("2"));
    expect(returnedCaseId).toBe(caseId);
    expect(depositedAt).toBeGreaterThan(0n);
  });

  it("deposit confirmation: real app function checkAndConfirmDeposit reads live V1 state and confirms, using real Postgres", async () => {
    const { escrowV1, decisionRelay } = await deploySystem();
    const publicClient = getPublicClient();
    const escrowId = keccak256(toHex("escrow-confirm-test"));
    const caseId = caseIdBytes32("case-confirm");

    await getWalletClient(DEPLOYER).writeContract({
      address: escrowV1,
      abi: ARTIFACTS.escrowV1.abi as never,
      functionName: "deposit",
      args: [caseId, escrowId, CLAIMANT, RESPONDENT],
      value: parseEther("0.5"),
    });

    const { prisma } = await import("@/lib/prisma");
    const org = await prisma.organization.create({ data: { name: "evm-integration-test-org" } });
    const kase = await prisma.case.create({
      data: {
        organizationId: org.id,
        claim: "evm integration test",
        amount: "0.5",
        claimantRef: "c",
        respondentRef: "r",
        policyId: "p",
        policyVersion: "v1",
        settlementChain: "sepolia",
        settlementContract: decisionRelay,
      },
    });
    const integration = await prisma.settlementIntegration.create({
      data: { organizationId: org.id, chain: "sepolia", escrowContractAddress: escrowV1, assetSymbol: "ETH", assetDecimals: 18, createdByMemberId: "m" },
    });
    const cs = await prisma.caseSettlement.create({
      data: {
        caseId: kase.id,
        integrationId: integration.id,
        // deriveEscrowId is sha256(caseId) internally — for this real
        // on-chain test we bypass that and store the actual escrowId
        // used for the real on-chain deposit above.
        escrowId,
        expectedAmountAtto: parseEther("0.5").toString(),
        claimantAddress: CLAIMANT,
        respondentAddress: RESPONDENT,
      },
    });

    const { checkAndConfirmDeposit } = await import("@/lib/case-settlement");
    // checkAndConfirmDeposit internally re-derives escrowId from
    // caseId via deriveEscrowId — for this test to exercise the real
    // function against our real on-chain escrowId, monkey-patch by
    // instead calling assertEscrowDepositMatches directly, which is
    // what actually reads deposits().
    const { assertEscrowDepositMatches } = await import("@/lib/escrow");
    await expect(
      assertEscrowDepositMatches({
        escrowContractAddress: escrowV1,
        escrowIdBytes32: escrowId,
        expectedClaimant: CLAIMANT,
        expectedRespondent: RESPONDENT,
        expectedTotalAmountWei: parseEther("0.5"),
        integrationId: "test-integration",
        escrowVersion: "V1" as const,
      })
    ).resolves.toBeUndefined();

    // And the full app-level confirmation path, using the deterministic
    // escrowId it actually derives — deposit again under that ID.
    const { deriveEscrowId } = await import("@/lib/case-settlement");
    const realEscrowId = deriveEscrowId(kase.id);
    await getWalletClient(DEPLOYER).writeContract({
      address: escrowV1,
      abi: ARTIFACTS.escrowV1.abi as never,
      functionName: "deposit",
      args: [caseId, realEscrowId, CLAIMANT, RESPONDENT],
      value: parseEther("0.5"),
    });
    await prisma.caseSettlement.update({ where: { id: cs.id }, data: { escrowId: realEscrowId } });

    const result = await checkAndConfirmDeposit(cs.id);
    expect(result.outcome).toBe("confirmed");
    const updated = await prisma.caseSettlement.findUniqueOrThrow({ where: { id: cs.id } });
    expect(updated.status).toBe("DEPOSITED");

    await prisma.caseSettlement.deleteMany({ where: { caseId: kase.id } });
    await prisma.case.delete({ where: { id: kase.id } });
    await prisma.settlementIntegration.delete({ where: { id: integration.id } });
    await prisma.auditLog.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  }, 20_000);

  it("integration target mismatch: assertSettlementTargetMatchesIntegration rejects when settlementTarget points at a different escrow", async () => {
    const { decisionRelay, escrowV1 } = await deploySystem();
    const wrongEscrow = await deploy(DEPLOYER, ARTIFACTS.escrowV1, [decisionRelay]);

    const ownerWallet = getWalletClient(OWNER);
    await ownerWallet.writeContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "setSettlementTarget", args: [ORIGIN_DOMAIN, wrongEscrow] });

    const { assertSettlementTargetMatchesIntegration, TargetBindingError } = await import("@/lib/escrow");
    await expect(
      assertSettlementTargetMatchesIntegration({ decisionRelayAddress: decisionRelay, originDomain: ORIGIN_DOMAIN, expectedEscrowContractAddress: escrowV1 })
    ).rejects.toBeInstanceOf(TargetBindingError);
  });

  it("integration target mismatch: assertSettlementTargetMatchesIntegration rejects an unset (zero) settlementTarget", async () => {
    const { decisionRelay, escrowV1 } = await deploySystem();
    const { assertSettlementTargetMatchesIntegration, TargetBindingError } = await import("@/lib/escrow");
    await expect(
      assertSettlementTargetMatchesIntegration({ decisionRelayAddress: decisionRelay, originDomain: ORIGIN_DOMAIN, expectedEscrowContractAddress: escrowV1 })
    ).rejects.toBeInstanceOf(TargetBindingError);
  });

  it("inactive integration: bind-time check assertEscrowBoundToDecisionRelay passes on-chain check independent of DB active flag (DB gate is enforced by the API route, not this function)", async () => {
    const { decisionRelay, escrowV1 } = await deploySystem();
    const { assertEscrowBoundToDecisionRelay } = await import("@/lib/case-settlement");
    // This function's OWN job is only the on-chain decisionRelay()
    // binding check — real inactive-integration rejection is a DB-level
    // check in api/cases/[id]/settlement/route.ts (covered by that
    // route's own tests). Proving here that the on-chain check passes
    // correctly is what establishes the baseline the DB-level gate
    // then adds to.
    await expect(
      assertEscrowBoundToDecisionRelay({ chain: "sepolia", escrowContractAddress: escrowV1, expectedDecisionRelayAddress: decisionRelay })
    ).resolves.toBeUndefined();
  });

  it("invalid CaseSettlement state: assertEscrowDepositMatches rejects an escrow with no deposit at all", async () => {
    const { escrowV1 } = await deploySystem();
    const { assertEscrowDepositMatches, EscrowValidationError } = await import("@/lib/escrow");
    const neverDeposited = keccak256(toHex("never-deposited"));
    await expect(
      assertEscrowDepositMatches({
        escrowContractAddress: escrowV1,
        escrowIdBytes32: neverDeposited,
        expectedClaimant: CLAIMANT,
        expectedRespondent: RESPONDENT,
        expectedTotalAmountWei: parseEther("1"),
        integrationId: "test-integration",
        escrowVersion: "V1" as const,
      })
    ).rejects.toBeInstanceOf(EscrowValidationError);
  });

  it("exact settlement payout: real DecisionRelay.handle() -> real Escrow.settle() pays exact amounts and marks SETTLED", async () => {
    const { mailbox, decisionRelay, escrowV1, attestor1: _a1, attestor2: _a2 } = await deploySystem();
    const publicClient = getPublicClient();
    const escrowId = keccak256(toHex("escrow-payout-test"));
    const caseId = caseIdBytes32("case-payout");

    await getWalletClient(DEPLOYER).writeContract({
      address: escrowV1,
      abi: ARTIFACTS.escrowV1.abi as never,
      functionName: "deposit",
      args: [caseId, escrowId, CLAIMANT, RESPONDENT],
      value: parseEther("1"),
    });

    const ownerWallet = getWalletClient(OWNER);
    await ownerWallet.writeContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "setSettlementTarget", args: [ORIGIN_DOMAIN, escrowV1] });
    await ownerWallet.writeContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "setSettlementMode", args: [ORIGIN_DOMAIN, SettlementMode.SETTLEMENT] });

    const claimantAmount = parseEther("0.6");
    const respondentAmount = parseEther("0.4");
    const proofHash = keccak256(toHex("proof-payout-test"));
    const hash = decisionAttestationHash({ decisionRelay, origin: ORIGIN_DOMAIN, caseId, outcome: "SPLIT", claimantAmount, respondentAmount, escrowId, proofHash });
    const sig1 = await signHash(ATTESTOR_1_KEY, hash);
    const sig2 = await signHash(ATTESTOR_2_KEY, hash);

    const body = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes[]" }],
      [caseId, "SPLIT", claimantAmount, respondentAmount, escrowId, proofHash, [sig1, sig2]]
    );

    const claimantBefore = await publicClient.getBalance({ address: CLAIMANT });
    const respondentBefore = await publicClient.getBalance({ address: RESPONDENT });

    const receipt = await callHandle(mailbox, decisionRelay, ORIGIN_DOMAIN, pad(mailbox, { size: 32 }), body);
    expect(receipt.status).toBe("success");

    const claimantAfter = await publicClient.getBalance({ address: CLAIMANT });
    const respondentAfter = await publicClient.getBalance({ address: RESPONDENT });
    expect(claimantAfter - claimantBefore).toBe(claimantAmount);
    expect(respondentAfter - respondentBefore).toBe(respondentAmount);

    const deposit = await publicClient.readContract({ address: escrowV1, abi: ARTIFACTS.escrowV1.abi as never, functionName: "deposits", args: [escrowId] });
    expect((deposit as [number, string, string, bigint])[0]).toBe(2); // SETTLED

    const processed = await publicClient.readContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "processedDecisions", args: [proofHash] });
    expect(processed).toBe(true);
  }, 20_000);

  it("failed settlement leaves the relay message retryable: a reverting settlementTarget does not mark processedDecisions true", async () => {
    const { mailbox, decisionRelay } = await deploySystem();
    const publicClient = getPublicClient();
    // Real fix found while writing this exact test: an EOA (or any
    // address with no deployed code) does NOT revert a Solidity
    // interface call — the EVM treats a CALL to a codeless address as
    // a trivial success with empty returndata, so the original version
    // of this test asserted nothing real. A genuinely reverting
    // contract is required to prove this behavior.
    const brokenTarget = await deploy(DEPLOYER, ARTIFACTS.revertingSettlementTarget);

    const ownerWallet = getWalletClient(OWNER);
    await ownerWallet.writeContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "setSettlementTarget", args: [ORIGIN_DOMAIN, brokenTarget] });
    await ownerWallet.writeContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "setSettlementMode", args: [ORIGIN_DOMAIN, SettlementMode.SETTLEMENT] });

    const caseId = caseIdBytes32("case-retryable");
    const escrowId = keccak256(toHex("escrow-retryable"));
    const proofHash = keccak256(toHex("proof-retryable"));
    const claimantAmount = parseEther("0.1");
    const respondentAmount = 0n;
    const hash = decisionAttestationHash({ decisionRelay, origin: ORIGIN_DOMAIN, caseId, outcome: "RELEASE_FULL", claimantAmount, respondentAmount, escrowId, proofHash });
    const sig1 = await signHash(ATTESTOR_1_KEY, hash);
    const sig2 = await signHash(ATTESTOR_2_KEY, hash);
    const body = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes[]" }],
      [caseId, "RELEASE_FULL", claimantAmount, respondentAmount, escrowId, proofHash, [sig1, sig2]]
    );

    await expect(expectHandleReverts(mailbox, decisionRelay, ORIGIN_DOMAIN, pad(mailbox, { size: 32 }), body)).rejects.toThrow();

    const processed = await publicClient.readContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "processedDecisions", args: [proofHash] });
    expect(processed).toBe(false); // real retryability proof: nothing was marked processed on the failed attempt
  }, 20_000);

  it("unconfigured SettlementMode: handle() reverts and leaves processedDecisions false, retryable once configured", async () => {
    const { mailbox, decisionRelay, escrowV1 } = await deploySystem();
    // Deliberately never call setSettlementMode for ORIGIN_DOMAIN.
    const caseId = caseIdBytes32("case-unconfigured");
    const escrowId = keccak256(toHex("escrow-unconfigured"));
    const proofHash = keccak256(toHex("proof-unconfigured"));
    const claimantAmount = parseEther("0.1");
    const respondentAmount = 0n;
    const hash = decisionAttestationHash({ decisionRelay, origin: ORIGIN_DOMAIN, caseId, outcome: "RELEASE_FULL", claimantAmount, respondentAmount, escrowId, proofHash });
    const sig1 = await signHash(ATTESTOR_1_KEY, hash);
    const sig2 = await signHash(ATTESTOR_2_KEY, hash);
    const body = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes[]" }],
      [caseId, "RELEASE_FULL", claimantAmount, respondentAmount, escrowId, proofHash, [sig1, sig2]]
    );

    await expect(expectHandleReverts(mailbox, decisionRelay, ORIGIN_DOMAIN, pad(mailbox, { size: 32 }), body)).rejects.toThrow(/settlement mode not configured/);

    const publicClient = getPublicClient();
    let processed = await publicClient.readContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "processedDecisions", args: [proofHash] });
    expect(processed).toBe(false);

    // Configure it now and retry the exact same message — must succeed.
    const ownerWallet = getWalletClient(OWNER);
    await ownerWallet.writeContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "setSettlementTarget", args: [ORIGIN_DOMAIN, escrowV1] });
    await ownerWallet.writeContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "setSettlementMode", args: [ORIGIN_DOMAIN, SettlementMode.SETTLEMENT] });
    await getWalletClient(DEPLOYER).writeContract({
      address: escrowV1,
      abi: ARTIFACTS.escrowV1.abi as never,
      functionName: "deposit",
      args: [caseId, escrowId, CLAIMANT, RESPONDENT],
      value: parseEther("0.1"),
    });
    await getWalletClient(DEPLOYER).writeContract({
      address: decisionRelay,
      abi: ARTIFACTS.decisionRelay.abi as never,
      functionName: "handle",
      args: [ORIGIN_DOMAIN, pad(mailbox, { size: 32 }), body],
      account: mailbox,
    } as never);

    processed = await publicClient.readContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "processedDecisions", args: [proofHash] });
    expect(processed).toBe(true);
  }, 20_000);

  it("emergency refund: valid M-of-N signatures after the 30-day timeout pays the claimant in full", async () => {
    const { mailbox: _mailbox, decisionRelay, escrowV2 } = await deploySystem();
    const publicClient = getPublicClient();
    const escrowId = keccak256(toHex("escrow-emergency-refund"));
    const caseId = caseIdBytes32("case-emergency-refund");

    await authorizeAndDeposit({ escrowV2, caseId, escrowId, value: parseEther("1") });

    const testClient = getTestClient();
    await testClient.increaseTime({ seconds: 30 * 24 * 60 * 60 + 1 });
    await testClient.mine({ blocks: 1 });

    const proofHash = keccak256(toHex("proof-emergency-refund"));
    const hash = emergencyRefundHash({ decisionRelay, target: escrowV2, caseId, escrowId, proofHash });
    const sig1 = await signHash(ATTESTOR_1_KEY, hash);
    const sig2 = await signHash(ATTESTOR_2_KEY, hash);

    const claimantBefore = await publicClient.getBalance({ address: CLAIMANT });
    const walletClient = getWalletClient(DEPLOYER);
    const txHash = await walletClient.writeContract({
      address: decisionRelay,
      abi: ARTIFACTS.decisionRelay.abi as never,
      functionName: "emergencyRefund",
      args: [escrowV2, caseId, escrowId, proofHash, [sig1, sig2]],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    expect(receipt.status).toBe("success");

    const claimantAfter = await publicClient.getBalance({ address: CLAIMANT });
    expect(claimantAfter - claimantBefore).toBe(parseEther("1"));

    const deposit = await publicClient.readContract({ address: escrowV2, abi: ARTIFACTS.escrowV2.abi as never, functionName: "deposits", args: [escrowId] });
    expect((deposit as [number, string, string, bigint, Hex])[0]).toBe(2); // SETTLED
  }, 20_000);

  it("emergency refund: reverts before the 30-day timeout even with valid signatures", async () => {
    const { decisionRelay, escrowV2 } = await deploySystem();
    const escrowId = keccak256(toHex("escrow-refund-too-early"));
    const caseId = caseIdBytes32("case-refund-too-early");

    await authorizeAndDeposit({ escrowV2, caseId, escrowId, value: parseEther("1") });

    const proofHash = keccak256(toHex("proof-refund-too-early"));
    const hash = emergencyRefundHash({ decisionRelay, target: escrowV2, caseId, escrowId, proofHash });
    const sig1 = await signHash(ATTESTOR_1_KEY, hash);
    const sig2 = await signHash(ATTESTOR_2_KEY, hash);

    await expect(
      getWalletClient(DEPLOYER).writeContract({
        address: decisionRelay,
        abi: ARTIFACTS.decisionRelay.abi as never,
        functionName: "emergencyRefund",
        args: [escrowV2, caseId, escrowId, proofHash, [sig1, sig2]],
      })
    ).rejects.toThrow();
  });

  it("emergency refund: rejects an invalid (unregistered signer) attestation", async () => {
    const { decisionRelay, escrowV2 } = await deploySystem();
    const escrowId = keccak256(toHex("escrow-refund-invalid-sig"));
    const caseId = caseIdBytes32("case-refund-invalid-sig");
    await authorizeAndDeposit({ escrowV2, caseId, escrowId, value: parseEther("1") });
    const testClient = getTestClient();
    await testClient.increaseTime({ seconds: 30 * 24 * 60 * 60 + 1 });
    await testClient.mine({ blocks: 1 });

    const proofHash = keccak256(toHex("proof-refund-invalid-sig"));
    const hash = emergencyRefundHash({ decisionRelay, target: escrowV2, caseId, escrowId, proofHash });
    const sig1 = await signHash(ATTESTOR_1_KEY, hash);
    const sigStranger = await signHash(STRANGER_KEY, hash); // not a registered attestor

    await expect(
      getWalletClient(DEPLOYER).writeContract({
        address: decisionRelay,
        abi: ARTIFACTS.decisionRelay.abi as never,
        functionName: "emergencyRefund",
        args: [escrowV2, caseId, escrowId, proofHash, [sig1, sigStranger]],
      })
    ).rejects.toThrow(/insufficient valid attestations/);
  }, 20_000);

  it("emergency refund: rejects a duplicate (already-processed) proofHash", async () => {
    const { decisionRelay, escrowV2 } = await deploySystem();
    const escrowId = keccak256(toHex("escrow-refund-dup"));
    const caseId = caseIdBytes32("case-refund-dup");
    await authorizeAndDeposit({ escrowV2, caseId, escrowId, value: parseEther("1") });
    const testClient = getTestClient();
    await testClient.increaseTime({ seconds: 30 * 24 * 60 * 60 + 1 });
    await testClient.mine({ blocks: 1 });

    const proofHash = keccak256(toHex("proof-refund-dup"));
    const hash = emergencyRefundHash({ decisionRelay, target: escrowV2, caseId, escrowId, proofHash });
    const sig1 = await signHash(ATTESTOR_1_KEY, hash);
    const sig2 = await signHash(ATTESTOR_2_KEY, hash);

    await getWalletClient(DEPLOYER).writeContract({
      address: decisionRelay,
      abi: ARTIFACTS.decisionRelay.abi as never,
      functionName: "emergencyRefund",
      args: [escrowV2, caseId, escrowId, proofHash, [sig1, sig2]],
    });

    await expect(
      getWalletClient(DEPLOYER).writeContract({
        address: decisionRelay,
        abi: ARTIFACTS.decisionRelay.abi as never,
        functionName: "emergencyRefund",
        args: [escrowV2, caseId, escrowId, proofHash, [sig1, sig2]],
      })
    ).rejects.toThrow(/already processed/);
  }, 20_000);

  it("emergency refund: a stale attestation (signed before deposit existed, over an unrelated escrowId) is rejected by real state checks, not just signature validity", async () => {
    const { decisionRelay, escrowV2 } = await deploySystem();
    const neverDepositedEscrowId = keccak256(toHex("escrow-never-deposited"));
    const caseId = caseIdBytes32("case-stale-refund");
    const proofHash = keccak256(toHex("proof-stale-refund"));

    // Real, validly-threshold-signed attestation — but for an escrowId
    // that was never actually deposited into. Proves the signature
    // alone is not sufficient authorization; the target contract's own
    // on-chain state must independently agree.
    const hash = emergencyRefundHash({ decisionRelay, target: escrowV2, caseId, escrowId: neverDepositedEscrowId, proofHash });
    const sig1 = await signHash(ATTESTOR_1_KEY, hash);
    const sig2 = await signHash(ATTESTOR_2_KEY, hash);

    await expect(
      getWalletClient(DEPLOYER).writeContract({
        address: decisionRelay,
        abi: ARTIFACTS.decisionRelay.abi as never,
        functionName: "emergencyRefund",
        args: [escrowV2, caseId, neverDepositedEscrowId, proofHash, [sig1, sig2]],
      })
    ).rejects.toThrow();
  });

  describe("Priority 2: explicit contract-version detection", () => {
    it("detects V1 from the real live contract's raw deposits() return length", async () => {
      const { escrowV1 } = await deploySystem();
      const { detectEscrowVersion } = await import("@/lib/escrow-version");
      await expect(detectEscrowVersion(escrowV1)).resolves.toBe("V1");
    });

    it("detects V2 from the real live contract's raw deposits() return length", async () => {
      const { escrowV2 } = await deploySystem();
      const { detectEscrowVersion } = await import("@/lib/escrow-version");
      await expect(detectEscrowVersion(escrowV2)).resolves.toBe("V2");
    });

    it("fails closed on an address whose deposits()-shaped call doesn't match any known version", async () => {
      const { mailbox } = await deploySystem(); // FakeMailbox has no deposits() function at all
      const { detectEscrowVersion, UnknownEscrowVersionError } = await import("@/lib/escrow-version");
      await expect(detectEscrowVersion(mailbox)).rejects.toBeInstanceOf(UnknownEscrowVersionError);
    });

    it("verifyEscrowVersionUnchanged rejects and persists a real ESCROW_VERSION_MISMATCH finding when the live contract no longer matches the registered version", async () => {
      const { escrowV1, escrowV2 } = await deploySystem();
      const { prisma } = await import("@/lib/prisma");
      const org = await prisma.organization.create({ data: { name: "escrow-version-mismatch-test-org" } });
      const integration = await prisma.settlementIntegration.create({
        data: { organizationId: org.id, chain: "sepolia", escrowContractAddress: escrowV1, assetSymbol: "ETH", assetDecimals: 18, escrowVersion: "V1", createdByMemberId: "m" },
      });

      const { verifyEscrowVersionUnchanged, EscrowVersionMismatchError } = await import("@/lib/escrow-version");
      // Registered as V1, but check against escrowV2's real address —
      // stands in for "this address now behaves like a different
      // contract than what was registered" (e.g. a redeploy).
      await expect(
        verifyEscrowVersionUnchanged({ integrationId: integration.id, escrowContractAddress: escrowV2, expectedVersion: "V1" })
      ).rejects.toBeInstanceOf(EscrowVersionMismatchError);

      const finding = await prisma.reconciliationFinding.findUnique({
        where: { type_targetId: { type: "ESCROW_VERSION_MISMATCH", targetId: integration.id } },
      });
      expect(finding).not.toBeNull();
      expect(finding!.resolvedAt).toBeNull();

      await prisma.reconciliationFinding.deleteMany({ where: { targetId: integration.id } });
      await prisma.settlementIntegration.delete({ where: { id: integration.id } });
      await prisma.auditLog.deleteMany({ where: { organizationId: org.id } });
      await prisma.organization.delete({ where: { id: org.id } });
    }, 20_000);

    it("verifyEscrowVersionUnchanged passes silently when the live contract still matches the registered version", async () => {
      const { escrowV1 } = await deploySystem();
      const { verifyEscrowVersionUnchanged } = await import("@/lib/escrow-version");
      await expect(
        verifyEscrowVersionUnchanged({ integrationId: "irrelevant-on-match-path", escrowContractAddress: escrowV1, expectedVersion: "V1" })
      ).resolves.toBeUndefined();
    });
  });
});
