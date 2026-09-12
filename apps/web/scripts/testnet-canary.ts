// Phase 1, item 4: a periodic automated testnet canary for the
// signing/settlement/delivery path itself — deliberately does NOT run a
// real GenLayer adjudication (that's a separate, slower, already-tested
// path — see runAdjudicationJob); this exercises exactly the part Phase
// 1 is about hardening: a FINALIZED decision with a settlement target
// going through automatic 2-of-3 attestor signing, on-chain settlement,
// and (for the Solana leg) Hyperlane notification delivery, end to end,
// on a fixed SLA clock.
//
// Scheduled as a BullMQ repeatable job (see lib/worker.ts's
// ensureCanarySweepScheduled, which calls runTestnetCanary() below) when
// CANARY_ORGANIZATION_ID is configured on the worker process; also
// runnable standalone via `tsx scripts/testnet-canary.ts` for manual/CI
// use. Safe to run repeatedly: every row it creates is tagged
// Case.isCanary=true and is deleted in a `finally` block regardless of
// outcome, so a crashed or killed run never leaves synthetic data behind
// for a real dashboard query to trip over (the SettlementIntegration is
// the one exception — reused across runs, same as e2e-sepolia-live.ts,
// since it's an org-level "trust this escrow" record, not per-run
// synthetic data). On an SLA breach or a hard failure, the escalation
// (a ReconciliationFinding + an ops alert — see lib/signer-lifecycle.ts's
// escalateCanarySlaBreach) is recorded BEFORE cleanup runs, so the
// evidence trail outlives the deleted synthetic rows.
//
// Sepolia real-deposit fix (2026-09-12): dispatchSettlementForDecision's
// sepolia branch (lib/hyperlane.ts) now unconditionally requires a
// CaseSettlement proving a verified, matching on-chain escrow deposit —
// added by a real funds-correctness fix after this canary was first
// written. A synthetic FINALIZED decision with no CaseSettlement at all
// now fails dispatch immediately, every run, rather than exercising
// anything. This performs the same real deposit e2e-sepolia-live.ts
// does (CANARY_SEPOLIA_DEPOSITOR_PRIVATE_KEY deposits into
// CANARY_SEPOLIA_ESCROW_CONTRACT as both claimant and respondent — a
// self-dispute, so the funds return to the same wallet once the canary
// decision settles 100% to the claimant), then dispatches for real.
//
// Required env:
//   CANARY_ORGANIZATION_ID              an existing Organization to attach the synthetic case to
//   CANARY_CHAIN                        "sepolia" | "solanatestnet" (default "sepolia")
//   CANARY_SLA_MS                       default 15 minutes
//   For "sepolia":
//     CANARY_SEPOLIA_ESCROW_CONTRACT       deployed, operator-approved, DecisionRelay-bound Escrow.sol address
//                                           (NOT the DecisionRelay address itself — see assertEscrowBoundToDecisionRelay
//                                           below, which derives the live DecisionRelay from this contract, same as
//                                           e2e-sepolia-live.ts)
//     CANARY_SEPOLIA_DEPOSITOR_PRIVATE_KEY funded Sepolia EOA that deposits and plays both claimant and respondent
//     CANARY_SEPOLIA_DEPOSIT_AMOUNT_ETH    decimal ETH amount to deposit each run (default "0.0002")
//   For "solanatestnet" (no CaseSettlement required — lib/hyperlane.ts's Solana branch falls back to
//   dispatching straight from Case fields when none is bound, so this path is unaffected by the fix above):
//     CANARY_SOLANA_ESCROW_PROGRAM, CANARY_SOLANA_CLAIMANT,
//     CANARY_SOLANA_RESPONDENT, CANARY_SOLANA_CASE_ID
import { createHash, randomUUID } from "crypto";
import { getAddress, isAddress, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prisma } from "@/lib/prisma";
import { dispatchSettlementForDecision, computeDecisionHash } from "@/lib/adjudication-service";
import { escalateCanarySlaBreach } from "@/lib/signer-lifecycle";
import { isApprovedSettlementContract } from "@/lib/hyperlane";
import { assertEscrowBoundToDecisionRelay } from "@/lib/case-settlement";
import { executeEvmDeposit } from "@/lib/deposit-execution";
import { detectEscrowVersion } from "@/lib/escrow-version";

const POLL_INTERVAL_MS = 15_000;
const DEFAULT_SLA_MS = 15 * 60 * 1000;
const DEFAULT_SEPOLIA_DEPOSIT_AMOUNT_ETH = "0.0002";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * Sets up the real, verified on-chain state dispatchSettlementForDecision's
 * sepolia branch now requires: a SettlementIntegration bound to a live
 * DecisionRelay (reused across runs, same as e2e-sepolia-live.ts), a
 * CaseSettlement with both party addresses set (self-dispute — the
 * depositor plays both), and a real confirmed deposit. Returns the
 * caseSettlementId so the caller can clean it up in `finally`, and the
 * live DecisionRelay address to use as the Case's own settlementContract.
 */
async function prepareSepoliaDeposit(params: {
  organizationId: string;
  caseId: string;
  depositAmountEth: string;
}): Promise<{ caseSettlementId: string; liveDecisionRelay: Address; depositTxHash: string }> {
  const escrowContractRaw = requireEnv("CANARY_SEPOLIA_ESCROW_CONTRACT");
  if (!isAddress(escrowContractRaw)) {
    throw new Error(`CANARY_SEPOLIA_ESCROW_CONTRACT is not a valid EVM address: ${escrowContractRaw}`);
  }
  const escrowContract = getAddress(escrowContractRaw);
  const depositorPrivateKey = requireEnv("CANARY_SEPOLIA_DEPOSITOR_PRIVATE_KEY");
  const depositorKey = (depositorPrivateKey.startsWith("0x") ? depositorPrivateKey : `0x${depositorPrivateKey}`) as Hex;
  const depositorAccount = privateKeyToAccount(depositorKey);

  const { createPublicClient, http } = await import("viem");
  const { sepolia } = await import("viem/chains");
  const publicClient = createPublicClient({ chain: sepolia, transport: http(process.env.HYPERLANE_RELAY_RPC_URL) });
  const liveDecisionRelay = (await publicClient.readContract({
    address: escrowContract,
    abi: [{ type: "function", name: "decisionRelay", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const,
    functionName: "decisionRelay",
  })) as Address;
  await assertEscrowBoundToDecisionRelay({ chain: "sepolia", escrowContractAddress: escrowContract, expectedDecisionRelayAddress: liveDecisionRelay });
  if (!isApprovedSettlementContract("sepolia", liveDecisionRelay)) {
    throw new Error(`decisionRelay ${liveDecisionRelay} (derived from CANARY_SEPOLIA_ESCROW_CONTRACT) is not on the operator-approved list`);
  }
  const escrowVersion = await detectEscrowVersion(escrowContract);

  const member = await prisma.member.findFirstOrThrow({ where: { organizationId: params.organizationId } });
  let integration = await prisma.settlementIntegration.findFirst({
    where: { organizationId: params.organizationId, chain: "sepolia", escrowContractAddress: escrowContract, active: true },
  });
  if (!integration) {
    integration = await prisma.settlementIntegration.create({
      data: {
        organizationId: params.organizationId,
        chain: "sepolia",
        escrowContractAddress: escrowContract,
        assetSymbol: "ETH",
        assetDecimals: 18,
        escrowVersion,
        createdByMemberId: member.id,
      },
    });
  }

  const depositAmountWei = parseEther(params.depositAmountEth);
  const { deriveEscrowId } = await import("@/lib/case-settlement");
  const escrowIdBytes32 = deriveEscrowId(params.caseId);

  const caseSettlement = await prisma.caseSettlement.create({
    data: {
      caseId: params.caseId,
      integrationId: integration.id,
      escrowId: escrowIdBytes32,
      claimantAddress: depositorAccount.address,
      claimantAddressSetAt: new Date(),
      respondentAddress: depositorAccount.address,
      respondentAddressSetAt: new Date(),
      expectedAmountAtto: depositAmountWei.toString(),
    },
  });

  const depositReceipt = await executeEvmDeposit({
    caseSettlementId: caseSettlement.id,
    depositorPrivateKey,
    timeoutMs: DEFAULT_SLA_MS,
  });

  return { caseSettlementId: caseSettlement.id, liveDecisionRelay, depositTxHash: depositReceipt.txHash };
}

export async function runTestnetCanary(): Promise<void> {
  const organizationId = process.env.CANARY_ORGANIZATION_ID;
  if (!organizationId) throw new Error("CANARY_ORGANIZATION_ID is required");
  const chain = process.env.CANARY_CHAIN ?? "sepolia";
  const slaMs = Number(process.env.CANARY_SLA_MS ?? DEFAULT_SLA_MS);
  const runId = `canary-${randomUUID()}`;
  const startedAt = Date.now();

  console.log(`[canary] ${runId}: starting — chain=${chain}, sla=${slaMs}ms`);

  let caseId: string | null = null;
  let decisionId: string | null = null;
  let caseSettlementId: string | null = null;
  let outcome: "settled" | "sla_breach" | "error" = "error";
  let errorDetail = "";
  let depositTxHash: string | null = null;

  try {
    const depositAmountEth = process.env.CANARY_SEPOLIA_DEPOSIT_AMOUNT_ETH ?? DEFAULT_SEPOLIA_DEPOSIT_AMOUNT_ETH;
    const caseFields = await buildCaseFields(chain, depositAmountEth);
    const kase = await prisma.case.create({
      data: {
        organizationId,
        status: "FINALIZED",
        claim: `[canary] automated settlement probe ${runId}`,
        amount: chain === "sepolia" ? depositAmountEth : "0.01",
        currency: chain === "solanatestnet" ? "SOL" : "ETH",
        policyId: "canary",
        policyVersion: "1",
        claimantRef: "canary-claimant",
        respondentRef: "canary-respondent",
        isCanary: true,
        ...caseFields.caseData,
      },
    });
    caseId = kase.id;

    let dispatchCase = kase;
    if (chain === "sepolia") {
      console.log(`[canary] ${runId}: depositing ${depositAmountEth} ETH into ${process.env.CANARY_SEPOLIA_ESCROW_CONTRACT}`);
      const prepared = await prepareSepoliaDeposit({ organizationId, caseId: kase.id, depositAmountEth });
      caseSettlementId = prepared.caseSettlementId;
      depositTxHash = prepared.depositTxHash;
      console.log(`[canary] ${runId}: deposit confirmed, txHash=${depositTxHash}`);
      // Real DecisionRelay address, derived (not caller-supplied) from
      // CANARY_SEPOLIA_ESCROW_CONTRACT inside prepareSepoliaDeposit —
      // isDecisionSettledOnSepolia and dispatchSettlementForDecision both
      // key off Case.settlementContract, so the case must be updated
      // with it before dispatch, same as e2e-sepolia-live.ts.
      dispatchCase = await prisma.case.update({ where: { id: kase.id }, data: { settlementContract: prepared.liveDecisionRelay } });
    }

    const contractCodeHash = sha256Hex("canary");
    const proofHash = sha256Hex(`${runId}-evidence`);
    const decisionHash = computeDecisionHash({
      caseId: kase.id,
      policyId: kase.policyId,
      policyVersion: kase.policyVersion,
      outcome: "claimant",
      claimantShareBps: 10000,
      respondentShareBps: 0,
      reasonCodes: ["canary"],
      proofHash,
      contractCodeHash,
    });

    const decision = await prisma.decision.create({
      data: {
        caseId: kase.id,
        policyId: kase.policyId,
        policyVersion: kase.policyVersion,
        outcome: "claimant",
        claimantShareBps: 10000,
        respondentShareBps: 0,
        reasonCodes: ["canary"],
        evidenceUsed: [],
        consensus: "ACCEPTED",
        proofHash,
        contractCodeHash,
        decisionHash,
      },
    });
    decisionId = decision.id;

    // Kicks off the first real dispatch attempt (the backend's own key
    // signs immediately; if that alone doesn't reach threshold, this
    // records pendingAttestationHash/pendingSolanaAttestationMessage and
    // returns — the live auto-attestor-sign*.ts poller processes on
    // anc-hor-attestor2/3 pick it up from there, same as a real decision).
    await dispatchSettlementForDecision(dispatchCase, decision);

    const deadline = startedAt + slaMs;
    let settled = false;
    while (Date.now() < deadline) {
      const current = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
      if (current.relayTxHash) {
        settled = true;
        break;
      }
      // The retry sweep normally runs every 10 minutes (see
      // lib/worker.ts) — too slow for a canary with a tight SLA, so this
      // re-drives dispatch itself on a short interval, exercising the
      // exact same idempotent, claim-guarded code path a real retry
      // would.
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const refreshed = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
      if (!refreshed.relayTxHash) {
        await dispatchSettlementForDecision(dispatchCase, refreshed);
      }
    }

    outcome = settled ? "settled" : "sla_breach";
    const finalDecision = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    if (!settled) {
      errorDetail = `no relayTxHash within ${slaMs}ms — last relayError: ${finalDecision.relayError ?? "(none)"}`;
    } else {
      console.log(`[canary] ${runId}: settled within SLA (${Date.now() - startedAt}ms)`);
    }

    // Machine-readable evidence bundle — printed BEFORE cleanup deletes
    // the synthetic rows, so a caller (CI log, or a human piping this to
    // a file) has tx hashes/decision hash/final state on record even
    // though the DB rows themselves are transient by design.
    console.log(
      "[canary] evidence bundle: " +
        JSON.stringify({
          runId,
          chain,
          outcome,
          caseId,
          decisionId,
          depositTxHash,
          decisionHash: finalDecision.decisionHash,
          relayTxHash: finalDecision.relayTxHash,
          relayMessageId: finalDecision.relayMessageId,
          relayAttempts: finalDecision.relayAttempts,
          relayError: finalDecision.relayError,
          durationMs: Date.now() - startedAt,
        })
    );
  } catch (err) {
    outcome = "error";
    errorDetail = err instanceof Error ? err.message : String(err);
    console.error(`[canary] ${runId}: failed`, err);
  } finally {
    if (outcome !== "settled") {
      await escalateCanarySlaBreach(runId, `chain=${chain} outcome=${outcome} detail=${errorDetail}`).catch((err) =>
        console.error(`[canary] ${runId}: failed to escalate`, err)
      );
    }
    // Recorded BEFORE cleanup deletes the synthetic Case/Decision rows,
    // same ordering reasoning as the escalation call above — this is the
    // one durable trace of the run the ops console can read after the
    // fact (see prisma/schema.prisma's CanaryRun doc comment).
    let relayTxHash: string | null = null;
    if (decisionId) {
      const finalDecision = await prisma.decision.findUnique({ where: { id: decisionId } }).catch(() => null);
      relayTxHash = finalDecision?.relayTxHash ?? null;
    }
    await prisma.canaryRun
      .create({
        data: { runId, chain, outcome, durationMs: Date.now() - startedAt, relayTxHash, detail: errorDetail || null },
      })
      .catch((err) => console.error(`[canary] ${runId}: failed to persist CanaryRun record`, err));
    await cleanup(caseId, decisionId, caseSettlementId, runId);
  }

  if (outcome !== "settled") {
    throw new Error(`[canary] ${runId}: outcome=${outcome} detail=${errorDetail}`);
  }
}

async function buildCaseFields(chain: string, depositAmountEth: string): Promise<{ caseData: Record<string, string> }> {
  if (chain === "sepolia") {
    // settlementContract is set to the live DecisionRelay derived from
    // CANARY_SEPOLIA_ESCROW_CONTRACT inside prepareSepoliaDeposit — this
    // placeholder is a temporary value the case is created with before
    // prepareSepoliaDeposit runs (deposit setup needs kase.id first, to
    // derive escrowId), and is overwritten below in main() once the real
    // DecisionRelay address is known.
    void depositAmountEth;
    return { caseData: { settlementChain: "sepolia" } };
  }
  if (chain === "solanatestnet") {
    const settlementSolanaEscrowProgram = process.env.CANARY_SOLANA_ESCROW_PROGRAM;
    const settlementSolanaClaimant = process.env.CANARY_SOLANA_CLAIMANT;
    const settlementSolanaRespondent = process.env.CANARY_SOLANA_RESPONDENT;
    const settlementSolanaCaseId = process.env.CANARY_SOLANA_CASE_ID ?? `CANARY-${randomUUID()}`;
    if (!settlementSolanaEscrowProgram || !settlementSolanaClaimant || !settlementSolanaRespondent) {
      throw new Error("CANARY_SOLANA_ESCROW_PROGRAM, CANARY_SOLANA_CLAIMANT, CANARY_SOLANA_RESPONDENT are required when CANARY_CHAIN=solanatestnet");
    }
    return {
      caseData: {
        settlementChain: "solanatestnet",
        settlementContract: settlementSolanaEscrowProgram,
        settlementSolanaEscrowProgram,
        settlementSolanaClaimant,
        settlementSolanaRespondent,
        settlementSolanaCaseId,
      },
    };
  }
  throw new Error(`CANARY_CHAIN must be "sepolia" or "solanatestnet", got: ${chain}`);
}

/**
 * Idempotent, best-effort cleanup — runs even after a hard failure so a
 * crashed canary run never leaves synthetic isCanary rows behind for a
 * subsequent run (or a real ops dashboard query) to trip over. Deletes
 * child rows before parents to respect FK constraints (CaseSettlement
 * before Decision/Case); a partial failure here is logged, not thrown,
 * since escalation (if any) has already happened by the time this runs.
 * The SettlementIntegration itself is NOT deleted — it's reused across
 * runs, same as e2e-sepolia-live.ts.
 */
async function cleanup(caseId: string | null, decisionId: string | null, caseSettlementId: string | null, runId: string): Promise<void> {
  try {
    if (caseSettlementId) {
      await prisma.caseSettlement.delete({ where: { id: caseSettlementId } }).catch(() => undefined);
    }
    if (decisionId) {
      await prisma.signerLifecycleEvent.deleteMany({ where: { decisionId } });
      await prisma.decision.delete({ where: { id: decisionId } }).catch(() => undefined);
    }
    if (caseId) {
      await prisma.case.delete({ where: { id: caseId } }).catch(() => undefined);
    }
    console.log(`[canary] ${runId}: cleanup complete`);
  } catch (err) {
    console.error(`[canary] ${runId}: cleanup failed — synthetic rows may remain (isCanary=true, safe to manually remove)`, err);
  }
}

// CLI entrypoint (manual/CI use) — this import.meta.url check keeps it
// from running when lib/worker.ts imports runTestnetCanary for scheduling.
if (import.meta.url === `file://${process.argv[1]}`) {
  runTestnetCanary().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
