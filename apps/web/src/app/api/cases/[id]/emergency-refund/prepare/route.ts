import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { type Address } from "viem";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess } from "@/lib/auth";
import { canAccessCase } from "@/lib/case-access";
import { getEvmPublicClient } from "@/lib/hyperlane";
import { depositsAbiForVersion, verifyEscrowVersionUnchanged, EscrowVersionMismatchError } from "@/lib/escrow-version";
import { emergencyRefundAttestationHash, caseIdToBytes32 } from "@/lib/emergency-refund";
import { logAction } from "@/lib/audit";

const DECISION_RELAY_EMERGENCY_ABI = [
  { type: "function", name: "attestorThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "attestorCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const ESCROW_TIMEOUT_ABI = [
  { type: "function", name: "emergencyRefundTimeoutSeconds", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// POST /api/cases/:id/emergency-refund/prepare — Priority 5, item 19.
// Prepares and DISPLAYS the real attestation payload an operator would
// need real M-of-N attestor signatures over to actually call
// DecisionRelay.emergencyRefund() — never signs, never broadcasts,
// never bypasses the Safe/M-of-N requirement in any way. The contract
// itself is what enforces every real safety property (timeout,
// threshold signatures, correct deposit state); this route only
// computes the same hash that contract would check and reports
// whether the on-chain state it reads suggests the case is actually
// eligible, as a convenience — the contract's own checks are the real
// authority, not this route's opinion.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;

  const kase = await prisma.case.findUnique({ where: { id: params.id }, include: { settlement: { include: { integration: true } } } });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  if (!kase.settlement) {
    return NextResponse.json({ error: "this case has no settlement binding" }, { status: 409 });
  }
  if (!kase.settlementContract) {
    return NextResponse.json({ error: "this case has no settlementContract (DecisionRelay) configured" }, { status: 409 });
  }
  const cs = kase.settlement;

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
      reason = status === 0 ? "no deposit found for this escrowId on-chain" : "this deposit is already SETTLED — nothing to refund";
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
    apiKeyId: auth.apiKeyId,
    action: "case.emergency_refund_prepared",
    targetType: "CaseSettlement",
    targetId: cs.id,
    metadata: { caseId: kase.id, escrowId: cs.escrowId, proofHash, eligible, reason },
  });

  return NextResponse.json({
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
