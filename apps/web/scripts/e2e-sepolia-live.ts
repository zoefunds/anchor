// Human-run, real-funds Sepolia end-to-end confirmation test — NOT a
// canary (contrast with testnet-canary.ts): this exercises the actual
// party-facing path (create case -> deposit real ETH into the real
// Escrow.sol -> file evidence -> real GenLayer adjudication via
// runAdjudicationJob -> attestor co-signing -> Hyperlane settlement),
// prints progress as it goes, and deliberately leaves the created case
// in the DB afterward (no cleanup) so a human can open it in the
// dashboard. Where testnet-canary.ts shortcuts straight to a synthetic
// FINALIZED decision, this script drives the real state machine,
// including the real 48h Decision.appealWindowClosesAt gate — see step
// 6 below for why, and how, this script fast-forwards past it.
//
// Usage:
//   npx tsx apps/web/scripts/e2e-sepolia-live.ts --help
//   npx tsx apps/web/scripts/e2e-sepolia-live.ts --dry-run
//   npx tsx apps/web/scripts/e2e-sepolia-live.ts \
//     --organization-id <cuid> --settlement-contract 0x... [--deposit-amount 0.001] [--timeout-ms 300000]
//
// Required env (read from apps/web/.env — see that file's own comments;
// names below match it exactly):
//   DATABASE_URL                     via lib/prisma
//   HYPERLANE_RELAY_RPC_URL          Sepolia RPC — same client setup as lib/hyperlane.ts
//   HYPERLANE_RELAY_PRIVATE_KEY      depositAuthorizer wallet (lib/case-settlement.ts's authorizeDepositOnChain)
//   ATTESTOR_PRIVATE_KEYS            consumed internally by dispatchSettlementForDecision (lib/hyperlane.ts)
//   GENLAYER_STUDIO_URL / GENLAYER_CHAIN_ID / GENLAYER_PRIVATE_KEY / GENLAYER_REGISTRY_ADDRESS
//                                    consumed internally by runAdjudicationJob (lib/genlayer.ts)
//
// New, script-specific env (there is no existing "claimant test wallet"
// key in apps/web/.env — production never has this backend hold a
// claimant's key, since Escrow.sol.deposit() requires msg.sender ===
// claimant; a live human test needs its own funded EOA):
//   E2E_SEPOLIA_DEPOSITOR_PRIVATE_KEY   funded Sepolia EOA that deposits and plays "claimant"
//   E2E_SEPOLIA_RESPONDENT_ADDRESS      optional; defaults to the depositor's own address (self-dispute, deposit-flow only cares that claimant == depositor)
//
// Never pass private keys as CLI flags — env only. --deposit-amount and
// the other flags below are non-secret config only.
import { randomUUID, createHash } from "crypto";
import { createPublicClient, http, parseEther, isAddress, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { prisma } from "@/lib/prisma";
import { runAdjudicationJob, dispatchSettlementForDecision, finalizeExpiredAppealWindows } from "@/lib/adjudication-service";
import { isApprovedSettlementContract } from "@/lib/hyperlane";
import { deriveEscrowId, assertEscrowBoundToDecisionRelay, normalizeEvmAddress } from "@/lib/case-settlement";
import { executeEvmDeposit } from "@/lib/deposit-execution";
import { detectEscrowVersion } from "@/lib/escrow-version";

interface Args {
  organizationId?: string;
  settlementContract?: string;
  depositAmountEth: string;
  timeoutMs: number;
  help: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    organizationId: process.env.E2E_ORGANIZATION_ID,
    settlementContract: process.env.E2E_SEPOLIA_SETTLEMENT_CONTRACT,
    depositAmountEth: "0.001",
    timeoutMs: 5 * 60 * 1000,
    help: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--organization-id") args.organizationId = argv[++i];
    else if (arg === "--settlement-contract") args.settlementContract = argv[++i];
    else if (arg === "--deposit-amount") args.depositAmountEth = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  return args;
}

function printHelp(): void {
  console.log(`e2e-sepolia-live.ts — human-run real-funds Sepolia E2E confirmation test

Usage:
  npx tsx apps/web/scripts/e2e-sepolia-live.ts --organization-id <cuid> --settlement-contract 0x... [options]

Options:
  --organization-id <cuid>     Organization to attach the case to (or env E2E_ORGANIZATION_ID)
  --settlement-contract <hex>  Deployed, operator-approved DecisionRelay-bound Escrow.sol address
                                (or env E2E_SEPOLIA_SETTLEMENT_CONTRACT)
  --deposit-amount <eth>       Decimal ETH amount to deposit (default: 0.001)
  --timeout-ms <n>             Max time to poll for each async stage (default: 300000)
  --dry-run                    Validate args/env and exit before any network or DB call
  --help                       Show this message and exit

Required env — see this file's header comment for the exact names and why.
Never pass private keys as flags; env only.`);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

function logStep(n: number, msg: string): void {
  console.log(`[e2e-sepolia] step ${n}: ${msg}`);
}

async function pollUntil<T>(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  check: () => Promise<T | null>
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const missing: string[] = [];
  if (!args.organizationId) missing.push("--organization-id / E2E_ORGANIZATION_ID");
  if (!args.settlementContract) missing.push("--settlement-contract / E2E_SEPOLIA_SETTLEMENT_CONTRACT");
  for (const name of ["HYPERLANE_RELAY_RPC_URL", "HYPERLANE_RELAY_PRIVATE_KEY", "E2E_SEPOLIA_DEPOSITOR_PRIVATE_KEY"]) {
    if (!process.env[name]) missing.push(name);
  }
  if (missing.length > 0) {
    console.error(`[e2e-sepolia] missing required config:\n  ${missing.join("\n  ")}\nRun with --help for usage.`);
    process.exitCode = 1;
    return;
  }
  if (!isAddress(args.settlementContract!)) {
    throw new Error(`--settlement-contract is not a valid EVM address: ${args.settlementContract}`);
  }

  if (args.dryRun) {
    console.log("[e2e-sepolia] dry-run: args/env look valid, exiting before any network or DB call");
    console.log(
      JSON.stringify(
        { organizationId: args.organizationId, settlementContract: args.settlementContract, depositAmountEth: args.depositAmountEth, timeoutMs: args.timeoutMs },
        null,
        2
      )
    );
    return;
  }

  const runId = `e2e-sepolia-${randomUUID()}`;
  const startedAt = Date.now();
  const rpcUrl = requireEnv("HYPERLANE_RELAY_RPC_URL");
  const relayPrivateKey = requireEnv("HYPERLANE_RELAY_PRIVATE_KEY");
  const depositorPrivateKey = requireEnv("E2E_SEPOLIA_DEPOSITOR_PRIVATE_KEY");
  const settlementContract = getAddress(args.settlementContract!);

  const depositorAccount = privateKeyToAccount((depositorPrivateKey.startsWith("0x") ? depositorPrivateKey : `0x${depositorPrivateKey}`) as Hex);
  const respondentAddress = normalizeEvmAddress(process.env.E2E_SEPOLIA_RESPONDENT_ADDRESS) ?? depositorAccount.address;
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

  console.log(`[e2e-sepolia] ${runId}: starting — claimant=${depositorAccount.address}, respondent=${respondentAddress}, deposit=${args.depositAmountEth} ETH`);

  logStep(1, `verifying escrow ${settlementContract} is bound to a DecisionRelay and detecting its ABI version`);
  const relayAddress = privateKeyToAccount((relayPrivateKey.startsWith("0x") ? relayPrivateKey : `0x${relayPrivateKey}`) as Hex).address;
  // The DecisionRelay address itself isn't a script input — assertEscrowBoundToDecisionRelay
  // exists to CATCH a wrong one, so this reads the escrow's own decisionRelay() and treats
  // that as ground truth for the rest of this run, matching how a real registration works.
  const liveDecisionRelay = (await publicClient.readContract({
    address: settlementContract,
    abi: [{ type: "function", name: "decisionRelay", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const,
    functionName: "decisionRelay",
  })) as Address;
  await assertEscrowBoundToDecisionRelay({ chain: "sepolia", escrowContractAddress: settlementContract, expectedDecisionRelayAddress: liveDecisionRelay });
  // Real bug found and fixed here 2026-09-12 (same class as the one found
  // wiring EscrowUSDC into settlement earlier): isApprovedSettlementContract
  // checks against the operator-approved DecisionRelay allowlist, not
  // escrow addresses — must run against liveDecisionRelay (resolved above),
  // never against the escrow address this CLI flag actually names.
  if (!isApprovedSettlementContract("sepolia", liveDecisionRelay)) {
    throw new Error(`decisionRelay ${liveDecisionRelay} is not on the operator-approved list (lib/hyperlane.ts's isApprovedSettlementContract)`);
  }
  const escrowVersion = await detectEscrowVersion(settlementContract);
  console.log(`[e2e-sepolia] escrow version detected: ${escrowVersion}`);

  let organizationId = args.organizationId!;
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
        assetSymbol: "ETH",
        assetDecimals: 18,
        escrowVersion,
        createdByMemberId: member.id,
      },
    });
    console.log(`[e2e-sepolia] created SettlementIntegration ${integration.id}`);
  } else {
    console.log(`[e2e-sepolia] reusing existing SettlementIntegration ${integration.id}`);
  }

  logStep(2, "creating case");
  const kase = await prisma.case.create({
    data: {
      organizationId,
      status: "EVIDENCE_COLLECTION",
      claim: "Freelance backend integration contract: Stripe payment API integration for an e-commerce checkout flow, agreed for delivery by the contracted milestone date",
      amount: args.depositAmountEth,
      currency: "ETH",
      policyId: "agent_data_task_v1",
      policyVersion: "1.0.0",
      claimantRef: `client-northwind-retail-${runId.slice(-8)}`,
      respondentRef: `dev-contractor-jt-${runId.slice(-8)}`,
      settlementChain: "sepolia",
      // Real bug fixed here: must be the DecisionRelay address (what
      // dispatchDecisionForCase's isDecisionSettledOnSepolia checks
      // processedDecisions() against), never the escrow's own address.
      settlementContract: liveDecisionRelay,
    },
  });
  console.log(`[e2e-sepolia] case created: ${kase.id}`);

  const depositAmountWei = parseEther(args.depositAmountEth);
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
      expectedAmountAtto: depositAmountWei.toString(),
    },
  });
  console.log(`[e2e-sepolia] CaseSettlement ${caseSettlement.id} created (escrowId=${escrowIdBytes32})`);

  logStep(3, `executing deposit of ${args.depositAmountEth} ETH into ${settlementContract} via the shared deposit-execution helper (authorize + deposit + re-verify)`);
  const depositReceipt = await executeEvmDeposit({
    caseSettlementId: caseSettlement.id,
    depositorPrivateKey: depositorPrivateKey,
    timeoutMs: args.timeoutMs,
  });
  const depositTxHash = depositReceipt.txHash as Hex;
  console.log(`[e2e-sepolia] deposit confirmed: ${JSON.stringify(depositReceipt)}`);

  logStep(6, "filing minimum required evidence for policy agent_data_task_v1");
  const evidenceContents: Record<string, string> = {
    task_spec: "Scope of work: integrate Stripe Checkout and webhook-based order fulfillment into the client's existing Next.js storefront, including test-mode verification, by the agreed milestone date. Deliverable was to include a working staging deployment and a short handoff document.",
    delivery_payload: "No staging deployment link, code repository access, or handoff document was ever provided by the contracted deadline. Two follow-up messages requesting a status update received no response.",
    claimant_statement: "The contracted integration was never delivered in any usable form by the agreed date. We are requesting full release of the escrowed funds back to us given the complete non-delivery.",
    respondent_statement: "No response was submitted by the respondent.",
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
  console.log(`[e2e-sepolia] filed ${Object.keys(evidenceContents).length} evidence rows`);

  logStep(7, "triggering real GenLayer adjudication via runAdjudicationJob");
  await prisma.case.update({ where: { id: kase.id }, data: { status: "ADJUDICATING" } });
  await runAdjudicationJob(kase.id, false);

  const decidedCase = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
  console.log(`[e2e-sepolia] adjudication complete — case status: ${decidedCase.status}`);
  if (decidedCase.status === "UNDETERMINED") {
    throw new Error("runAdjudicationJob left the case UNDETERMINED — see server logs above for the underlying error");
  }

  const decision = await prisma.decision.findFirstOrThrow({ where: { caseId: kase.id }, orderBy: { createdAt: "desc" } });
  console.log(`[e2e-sepolia] decision ${decision.id}: outcome=${decision.outcome} consensus=${decision.consensus}`);

  // A real, uncontested first decision only reaches FINALIZED/settlement
  // via finalizeExpiredAppealWindows' periodic sweep once
  // Decision.appealWindowClosesAt (APPEAL_WINDOW_MS, 48h) genuinely
  // elapses — infeasible for a human sitting at a terminal. This is the
  // one deliberate departure from "drive the real state machine
  // untouched": fast-forward the clock on THIS decision only, then call
  // the real finalizeExpiredAppealWindows() (not a reimplementation) so
  // every downstream effect (status transition, dispatchSettlementForDecision)
  // is the genuine production code path.
  if (decidedCase.status === "APPEAL_WINDOW") {
    logStep(8, "fast-forwarding the 48h appeal window for this test run, then finalizing via the real sweep");
    await prisma.decision.update({ where: { id: decision.id }, data: { appealWindowClosesAt: new Date() } });
    const finalizedCount = await finalizeExpiredAppealWindows();
    console.log(`[e2e-sepolia] finalizeExpiredAppealWindows finalized ${finalizedCount} case(s)`);
  }

  logStep(9, "polling for attestor quorum + relay settlement");
  const settled = await pollUntil("relayTxHash", args.timeoutMs, 10_000, async () => {
    const current = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    if (current.relayTxHash) return current;
    // Mirrors testnet-canary.ts's own re-drive pattern: the live
    // auto-attestor-sign*.ts pollers run on a schedule too slow for an
    // interactive human test, so re-drive the same idempotent,
    // claim-guarded dispatch path directly.
    const kaseNow = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
    await dispatchSettlementForDecision(kaseNow, current).catch((err) => {
      console.log(`[e2e-sepolia] dispatch attempt did not complete yet: ${err instanceof Error ? err.message : String(err)}`);
    });
    return null;
  });
  console.log(`[e2e-sepolia] settled: relayTxHash=${settled.relayTxHash}`);

  const finalCase = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
  const finalDecision = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });

  const evidenceBundle = {
    runId,
    caseId: kase.id,
    decisionId: decision.id,
    decisionHash: finalDecision.decisionHash,
    depositTxHash,
    relayTxHash: finalDecision.relayTxHash,
    relayMessageId: finalDecision.relayMessageId,
    finalCaseStatus: finalCase.status,
    finalDecisionStatus: finalDecision.consensus,
    totalDurationMs: Date.now() - startedAt,
  };
  console.log("[e2e-sepolia] EVIDENCE BUNDLE: " + JSON.stringify(evidenceBundle, null, 2));
  console.log(`[e2e-sepolia] case ${kase.id} was NOT cleaned up — inspect it in the dashboard, then delete manually if desired`);
}

main().catch((err) => {
  console.error("[e2e-sepolia] FAILED:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
