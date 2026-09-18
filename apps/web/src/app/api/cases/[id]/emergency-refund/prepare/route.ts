import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { type Address } from "viem";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { canAccessCase } from "@/lib/case-access";
import { getEvmPublicClient } from "@/lib/hyperlane";
import { depositsAbiForVersion, verifyEscrowVersionUnchanged, EscrowVersionMismatchError } from "@/lib/escrow-version";
import { emergencyRefundAttestationHash, caseIdToBytes32 } from "@/lib/emergency-refund";
import { emergencyRefundAttestationMessage, getSolanaAttestorThreshold } from "@/lib/solana-settle";
import { getEscrowProgram, keypairWallet, deriveCasePda, deriveConfigPda, fetchCaseDepositedAt, fetchEmergencyRefundConfig } from "@anchor/solana-escrow-client";
import { logAction } from "@/lib/audit";
import { dispatchWebhookEvent } from "@/lib/webhooks";

const DECISION_RELAY_EMERGENCY_ABI = [
  { type: "function", name: "attestorThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "attestorCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const ESCROW_TIMEOUT_ABI = [
  { type: "function", name: "emergencyRefundTimeoutSeconds", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// POST /api/cases/:id/emergency-refund/prepare — Priority 5, item 19.
// Prepares and DISPLAYS the real attestation payload an operator would
// need real M-of-N attestor signatures over to actually authorize an
// emergency refund — never signs, never broadcasts on the EVM branch,
// never bypasses the Safe/M-of-N requirement in any way. Every real
// safety property (timeout, threshold signatures, correct deposit
// state) is enforced on-chain, by the Escrow/decision-relay programs
// themselves, not by this route; this route only computes the same
// hash/message those programs would check and reports whether the
// on-chain state it reads suggests the case is actually eligible, as a
// convenience.
//
// EVM and Solana are genuinely asymmetric here, not just a different
// encoding of the same flow: EVM's emergencyRefund() is a plain
// contract call anyone can submit with their own wallet paying gas, so
// this route only ever prepares a payload for the org to broadcast
// itself. Solana's decision-relay emergency_refund is, by design, the
// same "Anchor's backend submits this directly, never via a third
// party" pattern as attested_settle (see solana-settle.ts's
// submitEmergencyRefund) — it needs the backend's own held payer/
// attestor keys, which nobody outside Anchor's infrastructure has. So
// for Solana, this route still never broadcasts, but actual submission
// happens through a separate, dedicated route
// (emergency-refund/submit-solana) once external signatures are
// collected, not through a CLI command the org runs themselves.
//
// Security-audit fix: OWNER-only (was requireWriteAccess, which any
// MEMBER or API key passed) — preparing an emergency refund exposes
// the real signing hash/message for a real fund-releasing multisig
// action; this is the same real financial authority level as binding a
// settlement integration, not routine case management.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.error === "forbidden" ? 403 : 401 });
  }

  const kase = await prisma.case.findUnique({ where: { id: (await params).id }, include: { settlement: { include: { integration: true } } } });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  if (kase.settlementChain === "solanatestnet") {
    return prepareSolanaEmergencyRefund(kase, auth);
  }
  return prepareEvmEmergencyRefund(kase, auth);
}

async function prepareEvmEmergencyRefund(
  kase: NonNullable<Awaited<ReturnType<typeof prisma.case.findUnique>>>,
  auth: { organizationId: string; memberId?: string | null }
) {
  const cs = await prisma.caseSettlement.findUnique({ where: { caseId: kase.id }, include: { integration: true } });
  if (!cs) {
    return NextResponse.json({ error: "this case has no settlement binding" }, { status: 409 });
  }
  if (!kase.settlementContract) {
    return NextResponse.json({ error: "this case has no settlementContract (DecisionRelay) configured" }, { status: 409 });
  }

  // The real, deployed emergencyRefund() mechanism only exists on V2
  // Escrow (see Escrow.sol's own header — added in Item E). V1 has no
  // such function at all; calling it would simply revert with no
  // matching selector. Reject clearly rather than preparing a payload
  // that could never actually be used.
  if (cs.integration.escrowVersion !== "V2") {
    return NextResponse.json(
      { error: `this case's escrow is ${cs.integration.escrowVersion} — emergencyRefund() only exists on V2 Escrow contracts (see Item E). There is no way to prepare a real refund request for a V1 escrow.` },
      { status: 422 }
    );
  }

  try {
    await verifyEscrowVersionUnchanged({
      integrationId: cs.integrationId,
      escrowContractAddress: cs.integration.escrowContractAddress as Address,
      expectedVersion: cs.integration.escrowVersion,
    });
  } catch (err) {
    if (err instanceof EscrowVersionMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json({ error: `could not verify escrow version: ${(err as Error).message}` }, { status: 502 });
  }

  const client = getEvmPublicClient();
  const escrowIdBytes32 = `0x${cs.escrowId.replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`;
  const caseIdBytes32 = caseIdToBytes32(kase.id);

  // Real on-chain eligibility read — the deposit's actual depositedAt
  // and the contract's own immutable timeout, not a DB approximation.
  let eligible = false;
  let reason: string | null = null;
  let readyAt: string | null = null;
  try {
    const deposit = (await client.readContract({
      address: cs.integration.escrowContractAddress as Address,
      abi: depositsAbiForVersion("V2"),
      functionName: "deposits",
      args: [escrowIdBytes32],
    })) as readonly [number, Address, Address, bigint, `0x${string}`, bigint];
    const [status, , , , , depositedAt] = deposit;
    if (status !== 1) {
      reason = status === 0 ? "no deposit found for this escrowId on-chain" : "this deposit is already SETTLED, nothing to refund";
    } else {
      const timeoutSeconds = await client.readContract({ address: cs.integration.escrowContractAddress as Address, abi: ESCROW_TIMEOUT_ABI, functionName: "emergencyRefundTimeoutSeconds" });
      const readyAtSeconds = depositedAt + timeoutSeconds;
      readyAt = new Date(Number(readyAtSeconds) * 1000).toISOString();
      const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
      eligible = nowSeconds >= readyAtSeconds;
      if (!eligible) reason = `emergency refund timeout has not yet elapsed (ready at ${readyAt})`;
    }
  } catch (err) {
    reason = `could not read on-chain deposit state: ${err instanceof Error ? err.message : String(err)}`;
  }

  const [attestorThreshold, attestorCount] = await Promise.all([
    client.readContract({ address: kase.settlementContract as Address, abi: DECISION_RELAY_EMERGENCY_ABI, functionName: "attestorThreshold" }),
    client.readContract({ address: kase.settlementContract as Address, abi: DECISION_RELAY_EMERGENCY_ABI, functionName: "attestorCount" }),
  ]);

  // A fresh, explicitly-labeled proof hash — never a decision's own
  // proofHash (processedDecisions is a shared namespace between
  // handle() and emergencyRefund(); reusing one would either collide
  // with a real settlement or let this be replayed as one — see Item
  // E's own tests). Deterministic per (case, escrow) pair but distinct
  // per preparation request via a timestamp, so re-running this after
  // a first attempt didn't complete doesn't require guessing a new
  // label.
  const proofHash = `0x${createHash("sha256").update(`emergency-refund:${cs.id}:${Date.now()}`).digest("hex")}` as `0x${string}`;

  const hashToSign = emergencyRefundAttestationHash({
    decisionRelayAddress: kase.settlementContract as Address,
    settlementTargetAddress: cs.integration.escrowContractAddress as Address,
    caseIdBytes32,
    escrowIdBytes32,
    proofHashBytes32: proofHash,
  });

  await logAction({
    organizationId: auth.organizationId,
    memberId: auth.memberId,
    action: "case.emergency_refund_prepared",
    targetType: "CaseSettlement",
    targetId: cs.id,
    metadata: { caseId: kase.id, escrowId: cs.escrowId, proofHash, eligible, reason },
  });

  // Priority 3, item 9 (respondent notification): the org's own
  // registered webhook subscribers, not a direct email to the
  // respondent — Anchor doesn't hold party email addresses. Fires on
  // every prepare call, not just eligible ones, so an org can see a
  // refund attempt was even considered.
  dispatchWebhookEvent({
    organizationId: auth.organizationId,
    event: "case.emergency_refund_prepared",
    data: { caseId: kase.id, caseSettlementId: cs.id, escrowId: cs.escrowId, proofHash, eligible, reason, readyAt },
  });

  return NextResponse.json({
    chain: "sepolia",
    decisionRelayAddress: kase.settlementContract,
    settlementTargetAddress: cs.integration.escrowContractAddress,
    caseIdBytes32,
    escrowIdBytes32,
    proofHash,
    hashToSign,
    attestorThreshold: Number(attestorThreshold),
    attestorCount: Number(attestorCount),
    eligible,
    reason,
    readyAt,
  });
}

async function prepareSolanaEmergencyRefund(
  kase: NonNullable<Awaited<ReturnType<typeof prisma.case.findUnique>>>,
  auth: { organizationId: string; memberId?: string | null }
) {
  if (!kase.settlementContract || !kase.settlementSolanaEscrowProgram || !kase.settlementSolanaClaimant || !kase.settlementSolanaCaseId) {
    return NextResponse.json({ error: "this case has no complete Solana settlement configuration" }, { status: 409 });
  }
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    return NextResponse.json({ error: "SOLANA_RPC_URL is not configured" }, { status: 500 });
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const escrowProgramId = new PublicKey(kase.settlementSolanaEscrowProgram);
  // A read-only wallet stand-in — never signs anything, only used to
  // build the typed Program client for reading account state. Same
  // pattern as reconciliation.ts's checkSolanaDispatchedButStale.
  const program = getEscrowProgram(connection, keypairWallet(Keypair.generate()), escrowProgramId.toBase58());
  const casePda = deriveCasePda(escrowProgramId, kase.settlementSolanaCaseId);
  const configPda = deriveConfigPda(escrowProgramId);

  let eligible = false;
  let reason: string | null = null;
  let readyAt: string | null = null;
  try {
    const depositedAt = await fetchCaseDepositedAt(program, casePda);
    if (depositedAt === null) {
      reason = "no deposit found for this case on-chain";
    } else {
      const config = await fetchEmergencyRefundConfig(program, configPda);
      if (!config) {
        reason = "escrow's emergency-refund config has not been initialized on this program deployment yet (initialize_config was never called)";
      } else {
        const readyAtSeconds = depositedAt + config.emergencyRefundTimeoutSeconds;
        readyAt = new Date(Number(readyAtSeconds) * 1000).toISOString();
        const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
        eligible = nowSeconds >= readyAtSeconds;
        if (!eligible) reason = `emergency refund timeout has not yet elapsed (ready at ${readyAt})`;
      }
    }
  } catch (err) {
    reason = `could not read on-chain deposit state: ${err instanceof Error ? err.message : String(err)}`;
  }

  const message = emergencyRefundAttestationMessage({
    decisionRelayProgramId: kase.settlementContract,
    caseId: kase.settlementSolanaCaseId,
    claimant: kase.settlementSolanaClaimant,
    escrowProgram: kase.settlementSolanaEscrowProgram,
  });
  const messageHex = `0x${message.toString("hex")}`;

  await logAction({
    organizationId: auth.organizationId,
    memberId: auth.memberId,
    action: "case.emergency_refund_prepared",
    targetType: "Case",
    targetId: kase.id,
    metadata: { caseId: kase.id, chain: "solanatestnet", eligible, reason },
  });

  dispatchWebhookEvent({
    organizationId: auth.organizationId,
    event: "case.emergency_refund_prepared",
    data: { caseId: kase.id, chain: "solanatestnet", eligible, reason, readyAt },
  });

  return NextResponse.json({
    chain: "solanatestnet",
    decisionRelayAddress: kase.settlementContract,
    settlementTargetAddress: kase.settlementSolanaEscrowProgram,
    // Solana attestors sign the raw message directly (Ed25519 has no
    // separate "hash first" step the way EVM's ecrecover-based scheme
    // does) — this is the exact byte string to sign, not a digest of it.
    messageHex,
    attestorThreshold: getSolanaAttestorThreshold(),
    attestorCount: 3,
    eligible,
    reason,
    readyAt,
  });
}
