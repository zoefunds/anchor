// Human-run, real-funds Sepolia USDC end-to-end confirmation test —
// the USDC counterpart to e2e-sepolia-live.ts. Exercises the actual
// USDC settlement path: create case -> register/reuse a USDC_V1
// SettlementIntegration -> deposit real testnet USDC into the real
// EscrowUSDC.sol (approve + deposit, via executeUsdcDeposit) -> file
// evidence -> real GenLayer adjudication -> attestor co-signing ->
// Hyperlane settlement dispatch with the CORRECT 6-decimal atomic
// amount (see money.ts's toAtomicAmount — this is the exact path the
// 2026-09-12 funds-correctness fix touches; this script is the real,
// live proof that fix actually works end-to-end, not just at the unit
// level).
//
// Usage:
//   npx tsx apps/web/scripts/e2e-sepolia-usdc-live.ts --help
//   npx tsx apps/web/scripts/e2e-sepolia-usdc-live.ts --dry-run
//   npx tsx apps/web/scripts/e2e-sepolia-usdc-live.ts \
//     --organization-id <cuid> [--deposit-amount 5] [--timeout-ms 300000]
//
// Required env (same as e2e-sepolia-live.ts, plus):
//   E2E_SEPOLIA_DEPOSITOR_PRIVATE_KEY   funded Sepolia EOA holding real testnet USDC, plays "claimant"
//   E2E_SEPOLIA_RESPONDENT_ADDRESS      optional; defaults to the depositor's own address (self-dispute)
//
// Testnet USDC: https://faucet.circle.com (Ethereum Sepolia, 20 USDC per request, no login required).
import { randomUUID, createHash } from "crypto";
import { createPublicClient, http, isAddress, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { prisma } from "@/lib/prisma";
import { runAdjudicationJob, dispatchSettlementForDecision, finalizeExpiredAppealWindows } from "@/lib/adjudication-service";
import { normalizeEvmAddress, deriveEscrowId } from "@/lib/case-settlement";
import { executeUsdcDeposit } from "@/lib/deposit-execution";
import { detectEscrowVersion, probeUsdcTokenGetter } from "@/lib/escrow-version";
import { isApprovedSettlementContract } from "@/lib/hyperlane";
import { ANCHOR_ENVIRONMENTS } from "@/lib/environment-registry";
import { toAtomicAmount } from "@/lib/money";

interface Args {
  organizationId?: string;
  depositAmountUsdc: string;
  timeoutMs: number;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    organizationId: process.env.E2E_ORGANIZATION_ID,
    depositAmountUsdc: "5",
    timeoutMs: 300_000,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--organization-id") args.organizationId = argv[++i];
    else if (arg === "--deposit-amount") args.depositAmountUsdc = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`
e2e-sepolia-usdc-live.ts — real-funds Sepolia USDC E2E confirmation test

Usage:
  npx tsx apps/web/scripts/e2e-sepolia-usdc-live.ts --organization-id <cuid> [--deposit-amount <usdc>] [--timeout-ms <ms>]
  npx tsx apps/web/scripts/e2e-sepolia-usdc-live.ts --dry-run

Flags:
  --organization-id <cuid>    Org to create the test case under (or E2E_ORGANIZATION_ID)
  --deposit-amount <usdc>     Decimal USDC amount to deposit (default: 5)
  --timeout-ms <ms>           Poll timeout for deposit confirmation / settlement (default: 300000)
  --dry-run                   Validate args/env and exit without any network or DB call
`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required — see this script's own header comment`);
  return value;
}

function sha256Hex(input: string): string {
  return "0x" + createHash("sha256").update(input).digest("hex");
}

function logStep(n: number, msg: string) {
  console.log(`[e2e-sepolia-usdc] step ${n}: ${msg}`);
}

async function pollUntil<T>(label: string, timeoutMs: number, intervalMs: number, check: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const missing: string[] = [];
  if (!args.organizationId) missing.push("--organization-id / E2E_ORGANIZATION_ID");
  for (const name of ["HYPERLANE_RELAY_RPC_URL", "HYPERLANE_RELAY_PRIVATE_KEY", "E2E_SEPOLIA_DEPOSITOR_PRIVATE_KEY"]) {
    if (!process.env[name]) missing.push(name);
  }
  if (missing.length > 0) {
    console.error(`[e2e-sepolia-usdc] missing required config:\n  ${missing.join("\n  ")}\nRun with --help for usage.`);
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    console.log("[e2e-sepolia-usdc] dry-run: args/env look valid, exiting before any network or DB call");
    console.log(JSON.stringify({ organizationId: args.organizationId, depositAmountUsdc: args.depositAmountUsdc, timeoutMs: args.timeoutMs }, null, 2));
    return;
  }

  const runId = `e2e-sepolia-usdc-${randomUUID()}`;
  const startedAt = Date.now();
  const rpcUrl = requireEnv("HYPERLANE_RELAY_RPC_URL");
  const depositorPrivateKey = requireEnv("E2E_SEPOLIA_DEPOSITOR_PRIVATE_KEY");

  const escrowUsdcAddress = ANCHOR_ENVIRONMENTS.sepolia.addresses.escrowUsdc;
  if (!escrowUsdcAddress) {
    throw new Error("no USDC escrow bound in environment-registry.ts for sepolia — deploy EscrowUSDC and set escrowUsdc first (see DeployEscrowUSDC.s.sol)");
  }
  const settlementContract = getAddress(escrowUsdcAddress);

  const depositorAccount = privateKeyToAccount((depositorPrivateKey.startsWith("0x") ? depositorPrivateKey : `0x${depositorPrivateKey}`) as Hex);
  const respondentAddress = normalizeEvmAddress(process.env.E2E_SEPOLIA_RESPONDENT_ADDRESS) ?? depositorAccount.address;
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

  console.log(`[e2e-sepolia-usdc] ${runId}: starting — claimant=${depositorAccount.address}, respondent=${respondentAddress}, deposit=${args.depositAmountUsdc} USDC, escrow=${settlementContract}`);

  logStep(1, `verifying ${settlementContract} is a genuine EscrowUSDC (usdcToken()+code-identity), detecting version`);
  const escrowVersion = await detectEscrowVersion(settlementContract);
  if (escrowVersion !== "USDC_V1") {
    throw new Error(`expected escrow ${settlementContract} to detect as USDC_V1, got ${escrowVersion} — environment-registry.ts's escrowUsdc may be stale`);
  }
  const tokenAddress = await probeUsdcTokenGetter(settlementContract);
  console.log(`[e2e-sepolia-usdc] escrow version: ${escrowVersion}, usdcToken(): ${tokenAddress}`);

  const decisionRelayAddress = (await publicClient.readContract({
    address: settlementContract,
    abi: [{ type: "function", name: "decisionRelay", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const,
    functionName: "decisionRelay",
  })) as Address;
  console.log(`[e2e-sepolia-usdc] decisionRelay(): ${decisionRelayAddress}`);
  if (!isApprovedSettlementContract("sepolia", decisionRelayAddress)) {
    throw new Error(`decisionRelay ${decisionRelayAddress} is not on the operator-approved list (lib/hyperlane.ts's isApprovedSettlementContract) — refusing to create a case against it`);
  }

  const organizationId = args.organizationId!;
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId } });

  let integration = await prisma.settlementIntegration.findFirst({
    where: { organizationId, chain: "sepolia", escrowContractAddress: settlementContract, active: true },
  });
  if (!integration) {
    integration = await prisma.settlementIntegration.create({
      data: {
        organizationId,
        chain: "sepolia",
        escrowContractAddress: settlementContract,
        assetSymbol: "USDC",
        assetDecimals: 6,
        escrowVersion,
        createdByMemberId: member.id,
      },
    });
    console.log(`[e2e-sepolia-usdc] created SettlementIntegration ${integration.id} (assetDecimals=${integration.assetDecimals})`);
  } else {
    console.log(`[e2e-sepolia-usdc] reusing existing SettlementIntegration ${integration.id} (assetDecimals=${integration.assetDecimals})`);
  }
  if (integration.assetDecimals !== 6) {
    throw new Error(`existing SettlementIntegration ${integration.id} has assetDecimals=${integration.assetDecimals}, expected 6 for USDC — refusing to run against a misconfigured integration`);
  }

  logStep(2, "creating case");
  const kase = await prisma.case.create({
    data: {
      organizationId,
      status: "EVIDENCE_COLLECTION",
      claim: `[e2e-sepolia-usdc-live] manual confirmation run ${runId}`,
      amount: args.depositAmountUsdc,
      currency: "USDC",
      policyId: "agent_data_task_v1",
      policyVersion: "1.0.0",
      claimantRef: `e2e-claimant-${runId}`,
      respondentRef: `e2e-respondent-${runId}`,
      settlementChain: "sepolia",
      // Real bug found running this script live (2026-09-12): Case.settlementContract
      // must be the DecisionRelay address (what isDecisionSettledOnSepolia/
      // isApprovedSettlementContract check against), NOT the escrow's own
      // address — those are two distinct contracts. An earlier version of
      // this script conflated them, which surfaced as
      // "processedDecisions(bytes32) reverted" at dispatch time (the read
      // landed on EscrowUSDC, which has no such function) after a real
      // deposit and real adjudication had already succeeded.
      settlementContract: decisionRelayAddress,
    },
  });
  console.log(`[e2e-sepolia-usdc] case created: ${kase.id}`);

  const expectedAmountAtto = toAtomicAmount(args.depositAmountUsdc, 6);
  const escrowIdBytes32 = deriveEscrowId(kase.id);

  const caseSettlement = await prisma.caseSettlement.create({
    data: {
      caseId: kase.id,
      integrationId: integration.id,
      escrowId: escrowIdBytes32,
      claimantAddress: depositorAccount.address,
      claimantAddressSetAt: new Date(),
      respondentAddress,
      respondentAddressSetAt: new Date(),
      expectedAmountAtto: expectedAmountAtto.toString(),
    },
  });
  console.log(`[e2e-sepolia-usdc] CaseSettlement ${caseSettlement.id} created (escrowId=${escrowIdBytes32}, expectedAmountAtto=${expectedAmountAtto} — real 6-decimal USDC atomic units, not 18-decimal)`);

  logStep(3, `executing deposit of ${args.depositAmountUsdc} USDC into ${settlementContract} via executeUsdcDeposit (allowlist + approve + authorize + deposit + re-verify)`);
  const depositReceipt = await executeUsdcDeposit({
    caseSettlementId: caseSettlement.id,
    depositorPrivateKey,
    timeoutMs: args.timeoutMs,
  });
  const depositTxHash = depositReceipt.txHash as Hex;
  console.log(`[e2e-sepolia-usdc] deposit confirmed: ${JSON.stringify(depositReceipt)}`);

  logStep(4, "filing minimum required evidence for policy agent_data_task_v1");
  const evidenceContents: Record<string, string> = {
    task_spec: `[e2e-sepolia-usdc-live ${runId}] task spec: deliver a 500-word product description for SKU-4471 by the agreed deadline`,
    delivery_payload: `[e2e-sepolia-usdc-live ${runId}] delivery payload: no file, message, or deliverable of any kind was ever submitted by the respondent — the task deadline passed with zero delivery`,
    claimant_statement: `[e2e-sepolia-usdc-live ${runId}] claimant statement: nothing was delivered at all; requesting full release of escrowed funds`,
    respondent_statement: `[e2e-sepolia-usdc-live ${runId}] respondent statement: no counter-evidence submitted`,
  };
  for (const [type, content] of Object.entries(evidenceContents)) {
    await prisma.evidence.create({
      data: {
        caseId: kase.id,
        type,
        contentHash: sha256Hex(content),
        storageRef: content,
        submittedBy: type.startsWith("claimant") ? "claimant" : type.startsWith("respondent") ? "respondent" : null,
        attributionSource: "organization_asserted",
      },
    });
  }
  console.log(`[e2e-sepolia-usdc] filed ${Object.keys(evidenceContents).length} evidence rows`);

  logStep(5, "triggering real GenLayer adjudication via runAdjudicationJob");
  await prisma.case.update({ where: { id: kase.id }, data: { status: "ADJUDICATING" } });
  await runAdjudicationJob(kase.id, false);

  const decidedCase = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
  console.log(`[e2e-sepolia-usdc] adjudication complete — case status: ${decidedCase.status}`);
  if (decidedCase.status === "UNDETERMINED") {
    throw new Error("runAdjudicationJob left the case UNDETERMINED — see server logs above for the underlying error");
  }

  const decision = await prisma.decision.findFirstOrThrow({ where: { caseId: kase.id }, orderBy: { createdAt: "desc" } });
  console.log(`[e2e-sepolia-usdc] decision ${decision.id}: outcome=${decision.outcome} consensus=${decision.consensus}`);

  if (decidedCase.status === "APPEAL_WINDOW") {
    logStep(6, "fast-forwarding the 48h appeal window for this test run, then finalizing via the real sweep");
    await prisma.decision.update({ where: { id: decision.id }, data: { appealWindowClosesAt: new Date() } });
    const finalizedCount = await finalizeExpiredAppealWindows();
    console.log(`[e2e-sepolia-usdc] finalizeExpiredAppealWindows finalized ${finalizedCount} case(s)`);
  }

  logStep(7, "polling for attestor quorum + relay settlement (real 6-decimal USDC atomic amount, per the 2026-09-12 fix)");
  const settled = await pollUntil("relayTxHash", args.timeoutMs, 10_000, async () => {
    const current = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    if (current.relayTxHash) return current;
    const kaseNow = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
    await dispatchSettlementForDecision(kaseNow, current).catch((err) => {
      console.log(`[e2e-sepolia-usdc] dispatch attempt did not complete yet: ${err instanceof Error ? err.message : String(err)}`);
    });
    return null;
  });
  console.log(`[e2e-sepolia-usdc] settled: relayTxHash=${settled.relayTxHash}`);

  const finalCase = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
  const finalDecision = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
  const finalSettlement = await prisma.caseSettlement.findUniqueOrThrow({ where: { id: caseSettlement.id } });

  const evidenceBundle = {
    runId,
    caseId: kase.id,
    decisionId: decision.id,
    decisionHash: finalDecision.decisionHash,
    depositTxHash,
    relayTxHash: finalDecision.relayTxHash,
    relayMessageId: finalDecision.relayMessageId,
    finalCaseStatus: finalCase.status,
    finalSettlementStatus: finalSettlement.status,
    finalDecisionStatus: finalDecision.consensus,
    expectedAmountAtto: expectedAmountAtto.toString(),
    assetSymbol: "USDC",
    assetDecimals: 6,
    totalDurationMs: Date.now() - startedAt,
  };
  console.log("[e2e-sepolia-usdc] EVIDENCE BUNDLE: " + JSON.stringify(evidenceBundle, null, 2));
  console.log(`[e2e-sepolia-usdc] case ${kase.id} was NOT cleaned up — inspect it in the dashboard, then delete manually if desired`);
}

main().catch((err) => {
  console.error("[e2e-sepolia-usdc] FAILED:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
