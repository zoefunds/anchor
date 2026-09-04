import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { parseEther, keccak256, toHex, pad, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { startAnvil, stopAnvil, getTestClient, getPublicClient, getWalletClient, deploy, ARTIFACTS, ANVIL_RPC_URL, DEV_PRIVATE_KEYS } from "./anvil-harness";

// Closes a real gap flagged in the settlement-readiness status report:
// Priority 1 covered Anvil + Postgres but never the real BullMQ/Redis
// worker queue — every other test in this suite calls
// dispatchSettlementForDecision (or lower-level functions) directly,
// in-process, never through a real enqueued job picked up by a real
// BullMQ Worker. This test does: a real Redis connection, a real
// Queue.add(), a real Worker consuming it, calling the actual
// retryFailedSettlements() function, which dispatches a real
// settlement against real Anvil contracts.
//
// Deliberately NOT using the shared ADJUDICATION_QUEUE_NAME/worker.ts's
// startAdjudicationWorker() — those are hardcoded to one shared queue
// name, and running this test against it risked a coincidentally-running
// real local dev worker (pointed at real Sepolia) picking up this
// test's fixture row instead of this test's own worker. A dedicated,
// randomly-suffixed queue name gets the same real BullMQ guarantees
// with zero chance of cross-talk with anything else on the machine.
//
// One real, structural limitation, stated rather than hidden: the
// actual cross-chain delivery step (a real Hyperlane relayer/validator
// network moving a dispatched message to its destination) cannot be
// exercised by a local Anvil test — there is no real Hyperlane network
// for a local chain. What IS proven end-to-end for real: the queue
// picks up the job, the real on-chain validation reads run against
// real Anvil state, the real M-of-N attestation is collected and
// verified, and a real dispatch transaction is sent and mined (against
// a FakeMailbox instance planted, via Anvil's real setCode, at the
// exact address @anchor/hyperlane-relay's dispatchRawMessage() has
// hardcoded for "sepolia" — this is real state injection, not a code
// mock: the resulting contract genuinely executes when called).

process.env.HYPERLANE_RELAY_RPC_URL = ANVIL_RPC_URL;
process.env.APP_ENV = "development";

const REAL_SEPOLIA_MAILBOX_ADDRESS = "0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766" as const;
const ORIGIN_DOMAIN = 11155111;
const QUEUE_NAME = `anchor-evm-worker-queue-test-${Date.now()}`;

const DEPLOYER = DEV_PRIVATE_KEYS[0];
const OWNER = DEV_PRIVATE_KEYS[1];
const ATTESTOR_KEY = DEV_PRIVATE_KEYS[2]; // 1-of-1 threshold — this key doubles as the backend's own ATTESTOR_PRIVATE_KEYS entry, so the real worker can reach threshold with no external cosigning step.
const CLAIMANT = privateKeyToAccount(DEV_PRIVATE_KEYS[5]).address;
const RESPONDENT = privateKeyToAccount(DEV_PRIVATE_KEYS[6]).address;

function caseIdBytes32(caseId: string): Hex {
  return pad(`0x${Buffer.from(caseId).toString("hex")}` as Hex, { size: 32 });
}

describe("Real BullMQ worker-queue integration (closes the Priority 1 gap)", () => {
  let redisConnection: IORedis;
  let queue: Queue;
  let worker: Worker | null = null;

  beforeAll(async () => {
    await startAnvil();

    const redisUrl = process.env.LOCAL_REDIS_URL_FOR_TESTS ?? "redis://127.0.0.1:6379";
    redisConnection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    await redisConnection.ping(); // fails loudly (not silently) if no local Redis is actually reachable
    queue = new Queue(QUEUE_NAME, { connection: redisConnection });
  }, 30_000);

  afterAll(async () => {
    await worker?.close();
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
    await redisConnection.quit();
    stopAnvil();
  });

  it("a real job, enqueued to a real Redis-backed BullMQ queue and picked up by a real Worker, dispatches a real settlement against real Anvil contracts", async () => {
    const { prisma } = await import("@/lib/prisma");
    let orgId: string | null = null;
    try {
      await runTest(prisma, (id) => (orgId = id));
    } finally {
      // Real hygiene fix found while writing this test: retryFailedSettlements()
      // queries GLOBALLY (not scoped to one organization — see its own
      // real production query), so a failed assertion leaving this
      // fixture's rows behind would silently inflate every future run's
      // "how many decisions did the sweep retry" count, exactly the
      // class of cross-test pollution already found once this session
      // in tests/integration/reconciliation.test.ts. try/finally makes
      // cleanup unconditional on the test's own outcome.
      if (orgId) {
        await prisma.decision.deleteMany({ where: { case: { organizationId: orgId } } });
        await prisma.caseSettlement.deleteMany({ where: { case: { organizationId: orgId } } });
        await prisma.case.deleteMany({ where: { organizationId: orgId } });
        await prisma.settlementIntegration.deleteMany({ where: { organizationId: orgId } });
        await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
        await prisma.organization.delete({ where: { id: orgId } });
      }
    }
  }, 30_000);

  async function runTest(prisma: typeof import("@/lib/prisma").prisma, setOrgId: (id: string) => void): Promise<void> {
    const attestorAddress = privateKeyToAccount(ATTESTOR_KEY).address;
    const ownerAddress = privateKeyToAccount(OWNER).address;
    const publicClient = getPublicClient();

    const decisionRelay = await deploy(DEPLOYER, ARTIFACTS.decisionRelay, [
      REAL_SEPOLIA_MAILBOX_ADDRESS,
      ownerAddress,
      "0x0000000000000000000000000000000000000000",
      [attestorAddress],
      1n,
    ]);
    const escrow = await deploy(DEPLOYER, ARTIFACTS.escrowV1, [decisionRelay]);

    const ownerWallet = getWalletClient(OWNER);
    await ownerWallet.writeContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "setSettlementTarget", args: [ORIGIN_DOMAIN, escrow] });
    await ownerWallet.writeContract({ address: decisionRelay, abi: ARTIFACTS.decisionRelay.abi as never, functionName: "setSettlementMode", args: [ORIGIN_DOMAIN, 1] });

    // Real state injection (Anvil's own setCode, not a code mock): the
    // shared @anchor/hyperlane-relay package hardcodes the real Sepolia
    // Mailbox address per chain name — planting FakeMailbox's real
    // deployed bytecode there means the app's OWN unmodified dispatch
    // path (dispatchDecisionRelay -> dispatchRawMessage) runs for real,
    // with no test-only branch anywhere in application code.
    const testClient = getTestClient();
    await testClient.setCode({ address: REAL_SEPOLIA_MAILBOX_ADDRESS, bytecode: ARTIFACTS.fakeMailbox.deployedBytecode });

    const caseIdStr = `worker-queue-test-${Date.now()}`;
    const escrowIdBytes32 = keccak256(toHex(`escrow-${caseIdStr}`));
    await getWalletClient(DEPLOYER).writeContract({
      address: escrow,
      abi: ARTIFACTS.escrowV1.abi as never,
      functionName: "deposit",
      args: [caseIdBytes32(caseIdStr), escrowIdBytes32, CLAIMANT, RESPONDENT],
      value: parseEther("0.25"),
    });

    // Real Postgres fixtures — a FINALIZED case with an ACCEPTED
    // decision whose relayError is set (simulating a decision that
    // failed to dispatch on a prior attempt and is now due for retry —
    // exactly retryFailedSettlements' own real query).
    const org = await prisma.organization.create({ data: { name: "worker-queue-evm-test-org" } });
    setOrgId(org.id);
    const kase = await prisma.case.create({
      data: {
        organizationId: org.id,
        claim: "worker queue evm test",
        amount: "0.25",
        claimantRef: "c",
        respondentRef: "r",
        policyId: "p",
        policyVersion: "v1",
        status: "FINALIZED",
        settlementChain: "sepolia",
        settlementContract: decisionRelay,
      },
    });
    const integration = await prisma.settlementIntegration.create({
      data: { organizationId: org.id, chain: "sepolia", escrowContractAddress: escrow, assetSymbol: "ETH", assetDecimals: 18, escrowVersion: "V1", createdByMemberId: "m" },
    });
    await prisma.caseSettlement.create({
      data: {
        caseId: kase.id,
        integrationId: integration.id,
        escrowId: escrowIdBytes32,
        expectedAmountAtto: parseEther("0.25").toString(),
        status: "DEPOSITED",
        claimantAddress: CLAIMANT,
        respondentAddress: RESPONDENT,
      },
    });
    const decisionHash = keccak256(toHex(`decision-${caseIdStr}`)).slice(2);
    const proofHash = keccak256(toHex(`evidence-${caseIdStr}`)).slice(2);
    const decision = await prisma.decision.create({
      data: {
        caseId: kase.id,
        policyId: "p",
        policyVersion: "v1",
        outcome: "RELEASE_FULL",
        claimantShareBps: 10000,
        respondentShareBps: 0,
        consensus: "ACCEPTED",
        decisionHash,
        proofHash,
        relayError: "simulated prior dispatch failure — due for retry",
        relayAttempts: 1,
      },
    });

    process.env.HYPERLANE_RELAY_PRIVATE_KEY = DEPLOYER;
    process.env.ATTESTOR_PRIVATE_KEYS = ATTESTOR_KEY;

    // The real worker: a genuine BullMQ Worker instance, consuming from
    // a genuine Redis-backed queue, invoking the real
    // retryFailedSettlements() function used by production (see
    // worker.ts's own processJob "retry_failed_settlements" branch —
    // this reuses the identical underlying function, just via a
    // dedicated queue/worker pair instead of the shared production one).
    const { retryFailedSettlements } = await import("@/lib/adjudication-service");
    const processed: number[] = [];
    worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        if (job.name === "retry_failed_settlements") {
          const count = await retryFailedSettlements();
          processed.push(count);
        }
      },
      { connection: redisConnection, concurrency: 1 }
    );

    const completion = new Promise<void>((resolve, reject) => {
      worker!.on("completed", () => resolve());
      worker!.on("failed", (_job, err) => reject(err));
    });

    await queue.add("retry_failed_settlements", {});
    await completion;

    // retryFailedSettlements() queries globally (see its own real
    // production query, not scoped to one org) — asserting on this
    // fixture's OWN decision, rather than the sweep's total retried
    // count, is what makes this test robust to any other real
    // ACCEPTED/FINALIZED/relayError-set row that happens to exist
    // elsewhere in this shared local Postgres.
    expect(processed.length).toBeGreaterThanOrEqual(1);

    const updatedDecision = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(updatedDecision.relayTxHash).toBeTruthy();
    expect(updatedDecision.relayError).toBeNull();

    // Real on-chain proof the dispatch transaction (sent through the
    // real queue -> real worker -> real dispatch path) actually landed.
    const receipt = await publicClient.getTransactionReceipt({ hash: updatedDecision.relayTxHash as Hex });
    expect(receipt.status).toBe("success");
  }
});
