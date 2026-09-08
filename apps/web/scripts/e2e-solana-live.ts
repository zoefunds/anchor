// Human-run, real-funds Solana testnet end-to-end confirmation test —
// see e2e-sepolia-live.ts's header for the general shape (not a canary,
// no auto-cleanup, real GenLayer adjudication via runAdjudicationJob,
// prints progress + a final evidence bundle). This is the Sealevel leg:
// deposit real SOL by calling the reference escrow program's
// initialize_case directly, then let the real decision-relay leg
// (submitAttestedSettle, lib/solana-settle.ts) settle it plus a
// separate Hyperlane notification dispatch on Sepolia.
//
// GAP this script had to fill itself (see final report): apps/web has
// no existing helper that calls escrow.initialize_case() — the app only
// ever READS the escrow's case PDA (lib/solana-escrow.ts) or SETTLES it
// (lib/solana-settle.ts); the actual deposit has always been a party's
// own out-of-band Anchor-client call. There is no Anchor IDL checked
// into apps/web to build this from, so the instruction below is
// hand-built from chains/solana/programs/escrow/src/lib.rs directly:
// Anchor's standard 8-byte sighash discriminator
// (sha256("global:initialize_case")[0:8]) followed by Borsh-encoded
// args (case_id: String, respondent: Pubkey, adjudicator: Pubkey,
// amount_lamports: u64-LE), against accounts [claimant(signer,w),
// case PDA seeds=["case", case_id](w), system_program]. If that Rust
// instruction signature ever changes, this encoding silently breaks —
// exactly the kind of drift a real Anchor TS client (typed from the
// program's own IDL) would catch at compile time and this cannot.
//
// Usage:
//   npx tsx apps/web/scripts/e2e-solana-live.ts --help
//   npx tsx apps/web/scripts/e2e-solana-live.ts --dry-run
//   npx tsx apps/web/scripts/e2e-solana-live.ts \
//     --organization-id <cuid> --escrow-program <base58> --decision-relay-program <base58> \
//     [--deposit-amount 0.01] [--timeout-ms 300000]
//
// Required env (names match apps/web/.env exactly):
//   DATABASE_URL                    via lib/prisma
//   SOLANA_RPC_URL                  same client setup as lib/solana-settle.ts
//   SOLANA_RELAY_PRIVATE_KEY        relay payer (JSON array secret key, same format as lib/solana-settle.ts)
//   SOLANA_ATTESTOR_PRIVATE_KEY     consumed internally by dispatchSettlementForDecision -> submitAttestedSettle
//   SOLANA_DECISION_RELAY_LOOKUP_TABLE  consumed internally by submitAttestedSettle
//   GENLAYER_STUDIO_URL / GENLAYER_CHAIN_ID / GENLAYER_PRIVATE_KEY / GENLAYER_REGISTRY_ADDRESS
//   HYPERLANE_RELAY_RPC_URL / HYPERLANE_RELAY_PRIVATE_KEY  the Solana leg still dispatches a Sepolia Hyperlane notification tx
//
// New, script-specific env (no existing "claimant test wallet" key in
// apps/web/.env — production never has this backend hold a claimant's
// key; a live human test needs its own funded keypair):
//   E2E_SOLANA_DEPOSITOR_SECRET_KEY   funded Solana keypair, same JSON-array format as SOLANA_RELAY_PRIVATE_KEY; plays "claimant"
//   E2E_SOLANA_RESPONDENT_PUBKEY      optional; defaults to the depositor's own pubkey (self-dispute, deposit-flow only cares that claimant == depositor)
//
// Never pass private keys as CLI flags — env only.
import { randomUUID, createHash } from "crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { prisma } from "@/lib/prisma";
import { runAdjudicationJob, dispatchSettlementForDecision, finalizeExpiredAppealWindows } from "@/lib/adjudication-service";
import { isApprovedSolanaEscrowProgram } from "@/lib/hyperlane";
import { normalizeSolanaAddress, assertSolanaEscrowBoundToDecisionRelay, checkAndConfirmSolanaDeposit } from "@/lib/solana-escrow";

const CASE_SEED_PREFIX = Buffer.from("case");
const ESCROW_AUTHORITY_SEEDS = [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")];
const LAMPORTS_PER_SOL = 1_000_000_000;

interface Args {
  organizationId?: string;
  escrowProgram?: string;
  decisionRelayProgram?: string;
  depositAmountSol: string;
  timeoutMs: number;
  help: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    organizationId: process.env.E2E_ORGANIZATION_ID,
    escrowProgram: process.env.E2E_SOLANA_ESCROW_PROGRAM,
    decisionRelayProgram: process.env.E2E_SOLANA_DECISION_RELAY_PROGRAM,
    depositAmountSol: "0.01",
    timeoutMs: 5 * 60 * 1000,
    help: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--organization-id") args.organizationId = argv[++i];
    else if (arg === "--escrow-program") args.escrowProgram = argv[++i];
    else if (arg === "--decision-relay-program") args.decisionRelayProgram = argv[++i];
    else if (arg === "--deposit-amount") args.depositAmountSol = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  return args;
}

function printHelp(): void {
  console.log(`e2e-solana-live.ts — human-run real-funds Solana testnet E2E confirmation test

Usage:
  npx tsx apps/web/scripts/e2e-solana-live.ts --organization-id <cuid> --escrow-program <base58> --decision-relay-program <base58> [options]

Options:
  --organization-id <cuid>          Organization to attach the case to (or env E2E_ORGANIZATION_ID)
  --escrow-program <base58>         Deployed reference escrow program id (or env E2E_SOLANA_ESCROW_PROGRAM)
  --decision-relay-program <base58> Deployed decision-relay program id (or env E2E_SOLANA_DECISION_RELAY_PROGRAM)
  --deposit-amount <sol>            Decimal SOL amount to deposit (default: 0.01)
  --timeout-ms <n>                  Max time to poll for each async stage (default: 300000)
  --dry-run                         Validate args/env and exit before any network or DB call
  --help                            Show this message and exit

Required env — see this file's header comment for the exact names and why.
Never pass private keys as flags; env only.`);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function borshU64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function deriveEscrowCasePda(escrowProgramId: PublicKey, onChainCaseId: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([CASE_SEED_PREFIX, Buffer.from(onChainCaseId, "utf8")], escrowProgramId);
  return pda;
}

function deriveDecisionRelayEscrowAuthority(decisionRelayProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(ESCROW_AUTHORITY_SEEDS, decisionRelayProgramId);
  return pda;
}

/**
 * Hand-built initialize_case instruction — see this file's header
 * comment for why apps/web has no existing helper for this and the
 * real risk of hand-encoding it this way.
 */
function buildInitializeCaseInstruction(params: {
  escrowProgramId: PublicKey;
  claimant: PublicKey;
  casePda: PublicKey;
  onChainCaseId: string;
  respondent: PublicKey;
  adjudicator: PublicKey;
  amountLamports: bigint;
}): TransactionInstruction {
  const data = Buffer.concat([
    anchorDiscriminator("initialize_case"),
    borshString(params.onChainCaseId),
    params.respondent.toBuffer(),
    params.adjudicator.toBuffer(),
    borshU64LE(params.amountLamports),
  ]);
  return new TransactionInstruction({
    programId: params.escrowProgramId,
    keys: [
      { pubkey: params.claimant, isSigner: true, isWritable: true },
      { pubkey: params.casePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

function keypairFromJsonSecret(raw: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function logStep(n: number, msg: string): void {
  console.log(`[e2e-solana] step ${n}: ${msg}`);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const missing: string[] = [];
  if (!args.organizationId) missing.push("--organization-id / E2E_ORGANIZATION_ID");
  if (!args.escrowProgram) missing.push("--escrow-program / E2E_SOLANA_ESCROW_PROGRAM");
  if (!args.decisionRelayProgram) missing.push("--decision-relay-program / E2E_SOLANA_DECISION_RELAY_PROGRAM");
  for (const name of ["SOLANA_RPC_URL", "SOLANA_RELAY_PRIVATE_KEY", "SOLANA_ATTESTOR_PRIVATE_KEY", "E2E_SOLANA_DEPOSITOR_SECRET_KEY"]) {
    if (!process.env[name]) missing.push(name);
  }
  if (missing.length > 0) {
    console.error(`[e2e-solana] missing required config:\n  ${missing.join("\n  ")}\nRun with --help for usage.`);
    process.exitCode = 1;
    return;
  }
  if (!normalizeSolanaAddress(args.escrowProgram)) throw new Error(`--escrow-program is not a valid base58 pubkey: ${args.escrowProgram}`);
  if (!normalizeSolanaAddress(args.decisionRelayProgram)) throw new Error(`--decision-relay-program is not a valid base58 pubkey: ${args.decisionRelayProgram}`);

  if (args.dryRun) {
    console.log("[e2e-solana] dry-run: args/env look valid, exiting before any network or DB call");
    console.log(
      JSON.stringify(
        {
          organizationId: args.organizationId,
          escrowProgram: args.escrowProgram,
          decisionRelayProgram: args.decisionRelayProgram,
          depositAmountSol: args.depositAmountSol,
          timeoutMs: args.timeoutMs,
        },
        null,
        2
      )
    );
    return;
  }

  const runId = `e2e-solana-${randomUUID()}`;
  const startedAt = Date.now();
  const rpcUrl = requireEnv("SOLANA_RPC_URL");
  const connection = new Connection(rpcUrl, "confirmed");

  const escrowProgramId = new PublicKey(args.escrowProgram!);
  const decisionRelayProgramId = new PublicKey(args.decisionRelayProgram!);
  const depositor = keypairFromJsonSecret(requireEnv("E2E_SOLANA_DEPOSITOR_SECRET_KEY"));
  const respondentPubkey = process.env.E2E_SOLANA_RESPONDENT_PUBKEY
    ? new PublicKey(process.env.E2E_SOLANA_RESPONDENT_PUBKEY)
    : depositor.publicKey;
  const adjudicatorPda = deriveDecisionRelayEscrowAuthority(decisionRelayProgramId);

  console.log(
    `[e2e-solana] ${runId}: starting — claimant=${depositor.publicKey.toBase58()}, respondent=${respondentPubkey.toBase58()}, deposit=${args.depositAmountSol} SOL`
  );

  if (!isApprovedSolanaEscrowProgram(escrowProgramId.toBase58())) {
    throw new Error(`escrow program ${escrowProgramId.toBase58()} is not on the operator-approved list (lib/hyperlane.ts's isApprovedSolanaEscrowProgram)`);
  }

  logStep(1, "verifying escrow program is bound to the given decision-relay program");
  await assertSolanaEscrowBoundToDecisionRelay({ escrowProgramId: escrowProgramId.toBase58(), decisionRelayProgramId: decisionRelayProgramId.toBase58() });

  const organizationId = args.organizationId!;
  const member = await prisma.member.findFirstOrThrow({ where: { organizationId } });

  let integration = await prisma.settlementIntegration.findFirst({
    where: { organizationId, chain: "solanatestnet", escrowContractAddress: escrowProgramId.toBase58(), active: true },
  });
  if (!integration) {
    integration = await prisma.settlementIntegration.create({
      data: {
        organizationId,
        chain: "solanatestnet",
        escrowContractAddress: escrowProgramId.toBase58(),
        assetSymbol: "SOL",
        assetDecimals: 9,
        escrowVersion: "SOLANA_V1",
        createdByMemberId: member.id,
      },
    });
    console.log(`[e2e-solana] created SettlementIntegration ${integration.id}`);
  } else {
    console.log(`[e2e-solana] reusing existing SettlementIntegration ${integration.id}`);
  }

  logStep(2, "creating case");
  const onChainCaseId = `E2E-${runId}`.slice(0, 32);
  const kase = await prisma.case.create({
    data: {
      organizationId,
      status: "EVIDENCE_COLLECTION",
      claim: `[e2e-solana-live] manual confirmation run ${runId}`,
      amount: args.depositAmountSol,
      currency: "SOL",
      policyId: "agent_data_task_v1",
      policyVersion: "1.0.0",
      claimantRef: `e2e-claimant-${runId}`,
      respondentRef: `e2e-respondent-${runId}`,
      settlementChain: "solanatestnet",
      settlementContract: decisionRelayProgramId.toBase58(),
      settlementSolanaClaimant: depositor.publicKey.toBase58(),
      settlementSolanaRespondent: respondentPubkey.toBase58(),
      settlementSolanaEscrowProgram: escrowProgramId.toBase58(),
      settlementSolanaCaseId: onChainCaseId,
    },
  });
  console.log(`[e2e-solana] case created: ${kase.id} (on-chain case_id=${onChainCaseId})`);

  const depositAmountLamports = BigInt(Math.round(Number(args.depositAmountSol) * LAMPORTS_PER_SOL));
  const casePda = deriveEscrowCasePda(escrowProgramId, onChainCaseId);

  const caseSettlement = await prisma.caseSettlement.create({
    data: {
      caseId: kase.id,
      integrationId: integration.id,
      escrowId: onChainCaseId,
      claimantAddress: depositor.publicKey.toBase58(),
      claimantAddressSetAt: new Date(),
      respondentAddress: respondentPubkey.toBase58(),
      respondentAddressSetAt: new Date(),
      expectedAmountAtto: depositAmountLamports.toString(),
    },
  });
  console.log(`[e2e-solana] CaseSettlement ${caseSettlement.id} created (casePda=${casePda.toBase58()})`);

  logStep(3, `depositing ${args.depositAmountSol} SOL via escrow.initialize_case (claimant=${depositor.publicKey.toBase58()})`);
  const initializeCaseIx = buildInitializeCaseInstruction({
    escrowProgramId,
    claimant: depositor.publicKey,
    casePda,
    onChainCaseId,
    respondent: respondentPubkey,
    adjudicator: adjudicatorPda,
    amountLamports: depositAmountLamports,
  });
  const tx = new Transaction().add(initializeCaseIx);
  const depositTxHash = await sendAndConfirmTransaction(connection, tx, [depositor], { commitment: "confirmed" });
  console.log(`[e2e-solana] deposit tx confirmed: ${depositTxHash}`);
  await prisma.caseSettlement.update({ where: { id: caseSettlement.id }, data: { depositTxHash } });

  logStep(4, "confirming deposit against the escrow's own on-chain case account");
  const confirmResult = await pollUntil("deposit confirmation", args.timeoutMs, 5_000, async () => {
    const result = await checkAndConfirmSolanaDeposit({
      escrowProgramId: escrowProgramId.toBase58(),
      onChainCaseId,
      expectedClaimant: depositor.publicKey.toBase58(),
      expectedRespondent: respondentPubkey.toBase58(),
      expectedAmountLamports: depositAmountLamports,
    });
    return result.outcome === "confirmed" ? result : null;
  });
  await prisma.caseSettlement.update({ where: { id: caseSettlement.id }, data: { status: "DEPOSITED", depositConfirmedAt: new Date() } });
  console.log(`[e2e-solana] deposit confirmed: ${JSON.stringify(confirmResult)}`);

  logStep(5, "filing minimum required evidence for policy agent_data_task_v1");
  const evidenceContents: Record<string, string> = {
    task_spec: `[e2e-solana-live ${runId}] task spec: deliver X by Y`,
    delivery_payload: `[e2e-solana-live ${runId}] delivery payload: X was delivered`,
    claimant_statement: `[e2e-solana-live ${runId}] claimant statement: delivery did not meet spec`,
    respondent_statement: `[e2e-solana-live ${runId}] respondent statement: delivery met spec`,
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
  console.log(`[e2e-solana] filed ${Object.keys(evidenceContents).length} evidence rows`);

  logStep(6, "triggering real GenLayer adjudication via runAdjudicationJob");
  await prisma.case.update({ where: { id: kase.id }, data: { status: "ADJUDICATING" } });
  await runAdjudicationJob(kase.id, false);

  const decidedCase = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
  console.log(`[e2e-solana] adjudication complete — case status: ${decidedCase.status}`);
  if (decidedCase.status === "UNDETERMINED") {
    throw new Error("runAdjudicationJob left the case UNDETERMINED — see server logs above for the underlying error");
  }

  const decision = await prisma.decision.findFirstOrThrow({ where: { caseId: kase.id }, orderBy: { createdAt: "desc" } });
  console.log(`[e2e-solana] decision ${decision.id}: outcome=${decision.outcome} consensus=${decision.consensus}`);

  // See e2e-sepolia-live.ts's identical step for why this fast-forward
  // (real production code, only the appeal-window CLOCK is a test
  // shortcut) is necessary for a human-run script to reach settlement.
  if (decidedCase.status === "APPEAL_WINDOW") {
    logStep(7, "fast-forwarding the 48h appeal window for this test run, then finalizing via the real sweep");
    await prisma.decision.update({ where: { id: decision.id }, data: { appealWindowClosesAt: new Date() } });
    const finalizedCount = await finalizeExpiredAppealWindows();
    console.log(`[e2e-solana] finalizeExpiredAppealWindows finalized ${finalizedCount} case(s)`);
  }

  logStep(8, "polling for attestor quorum + relay settlement (attested_settle) + Hyperlane notification");
  const settled = await pollUntil("relayTxHash", args.timeoutMs, 10_000, async () => {
    const current = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    if (current.relayTxHash) return current;
    const kaseNow = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
    await dispatchSettlementForDecision(kaseNow, current).catch((err) => {
      console.log(`[e2e-solana] dispatch attempt did not complete yet: ${err instanceof Error ? err.message : String(err)}`);
    });
    return null;
  });
  console.log(`[e2e-solana] settled: relayTxHash=${settled.relayTxHash}, relayNotificationTxHash=${settled.relayNotificationTxHash}`);

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
    relayNotificationTxHash: finalDecision.relayNotificationTxHash,
    finalCaseStatus: finalCase.status,
    finalDecisionStatus: finalDecision.consensus,
    totalDurationMs: Date.now() - startedAt,
  };
  console.log("[e2e-solana] EVIDENCE BUNDLE: " + JSON.stringify(evidenceBundle, null, 2));
  console.log(`[e2e-solana] case ${kase.id} was NOT cleaned up — inspect it in the dashboard, then delete manually if desired`);
}

main().catch((err) => {
  console.error("[e2e-solana] FAILED:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
