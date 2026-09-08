// Phase 1, item 4: a periodic automated testnet canary for the
// signing/settlement/delivery path itself — deliberately does NOT run a
// real GenLayer adjudication (that's a separate, slower, already-tested
// path — see runAdjudicationJob); this exercises exactly the part Phase
// 1 is about hardening: a FINALIZED decision with a settlement target
// going through automatic 2-of-3 attestor signing, on-chain settlement,
// and (for the Solana leg) Hyperlane notification delivery, end to end,
// on a fixed SLA clock.
//
// Run via cron / a Fly scheduled machine (see house rules — no
// scheduling infra is wired up by this script itself). Safe to run
// repeatedly: every row it creates is tagged Case.isCanary=true and is
// deleted in a `finally` block regardless of outcome, so a crashed or
// killed run never leaves synthetic data behind for a real dashboard
// query to trip over. On an SLA breach or a hard failure, the escalation
// (a ReconciliationFinding + an ops alert — see lib/signer-lifecycle.ts's
// escalateCanarySlaBreach) is recorded BEFORE cleanup runs, so the
// evidence trail outlives the deleted synthetic rows.
//
// Required env:
//   CANARY_ORGANIZATION_ID           an existing Organization to attach the synthetic case to
//   CANARY_CHAIN                     "sepolia" | "solanatestnet" (default "sepolia")
//   CANARY_SLA_MS                    default 15 minutes
//   For "sepolia": CANARY_SEPOLIA_SETTLEMENT_CONTRACT (DecisionRelay address)
//   For "solanatestnet": CANARY_SOLANA_ESCROW_PROGRAM, CANARY_SOLANA_CLAIMANT,
//     CANARY_SOLANA_RESPONDENT, CANARY_SOLANA_CASE_ID
import { createHash, randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { dispatchSettlementForDecision, computeDecisionHash } from "@/lib/adjudication-service";
import { escalateCanarySlaBreach } from "@/lib/signer-lifecycle";

const POLL_INTERVAL_MS = 15_000;
const DEFAULT_SLA_MS = 15 * 60 * 1000;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function main() {
  const organizationId = process.env.CANARY_ORGANIZATION_ID;
  if (!organizationId) throw new Error("CANARY_ORGANIZATION_ID is required");
  const chain = process.env.CANARY_CHAIN ?? "sepolia";
  const slaMs = Number(process.env.CANARY_SLA_MS ?? DEFAULT_SLA_MS);
  const runId = `canary-${randomUUID()}`;
  const startedAt = Date.now();

  console.log(`[canary] ${runId}: starting — chain=${chain}, sla=${slaMs}ms`);

  let caseId: string | null = null;
  let decisionId: string | null = null;
  let outcome: "settled" | "sla_breach" | "error" = "error";
  let errorDetail = "";

  try {
    const caseFields = buildCaseFields(chain);
    const kase = await prisma.case.create({
      data: {
        organizationId,
        status: "FINALIZED",
        claim: `[canary] automated settlement probe ${runId}`,
        amount: "0.01",
        currency: "USD",
        policyId: "canary",
        policyVersion: "1",
        claimantRef: "canary-claimant",
        respondentRef: "canary-respondent",
        isCanary: true,
        ...caseFields,
      },
    });
    caseId = kase.id;

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
    await dispatchSettlementForDecision(kase, decision);

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
        await dispatchSettlementForDecision(kase, refreshed);
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
    await cleanup(caseId, decisionId, runId);
  }

  if (outcome !== "settled") {
    process.exitCode = 1;
  }
}

function buildCaseFields(chain: string): Record<string, string> {
  if (chain === "sepolia") {
    const settlementContract = process.env.CANARY_SEPOLIA_SETTLEMENT_CONTRACT;
    if (!settlementContract) throw new Error("CANARY_SEPOLIA_SETTLEMENT_CONTRACT is required when CANARY_CHAIN=sepolia");
    return { settlementChain: "sepolia", settlementContract };
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
      settlementChain: "solanatestnet",
      settlementContract: settlementSolanaEscrowProgram,
      settlementSolanaEscrowProgram,
      settlementSolanaClaimant,
      settlementSolanaRespondent,
      settlementSolanaCaseId,
    };
  }
  throw new Error(`CANARY_CHAIN must be "sepolia" or "solanatestnet", got: ${chain}`);
}

/**
 * Idempotent, best-effort cleanup — runs even after a hard failure so a
 * crashed canary run never leaves synthetic isCanary rows behind for a
 * subsequent run (or a real ops dashboard query) to trip over. Deletes
 * child rows before the Case itself to respect FK constraints; a
 * partial failure here is logged, not thrown, since escalation (if any)
 * has already happened by the time this runs.
 */
async function cleanup(caseId: string | null, decisionId: string | null, runId: string): Promise<void> {
  try {
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
