import { type Address, keccak256 } from "viem";
import { getEvmPublicClient } from "@/lib/hyperlane";
import { prisma } from "@/lib/prisma";
import { sendOpsAlert, sendNtfyAlert } from "@/lib/alerts";

// Re-audit response (Phase 1, item 3 — reliability monitoring
// infrastructure). Ports the core, continuously-meaningful checks from
// chains/hyperlane-validator/scripts/verify-deployment.ts (a manual,
// point-in-time script whose results were previously recorded by hand
// as markdown "Log Snapshot N" entries — see 24H_OBSERVATION_LOG.md)
// into a real periodic sweep with durable, queryable storage
// (ReliabilityObservation) — so a genuine 30-day reliability window
// has actual accumulated evidence behind it, not manual snapshots.
//
// Deliberately NOT a full port: file-based checks (relayer whitelist
// contents, deployment.json drift) and one-time-per-deploy checks
// don't need re-running every 15 minutes and stay in the manual
// script. This covers what actually changes moment to moment:
// checkpoint currency, recent delivery, and live contract wiring.
//
// chains/hyperlane-validator isn't an npm workspace and isn't shipped
// in the worker's Docker image (see apps/web/Dockerfile.worker) — this
// module is intentionally self-contained rather than shelling out to
// that script, so it works in the deployed worker with zero extra
// packaging.

const MAILBOX = "0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766" as Address;
const VALIDATOR_ANNOUNCE = "0xE6105C59480a1B7DD3E4f28153aFdbE12F4CfCD9" as Address;
const DECISION_RELAY = "0xdddc52e9D20957Fb3Afe0dbee165857Cd6ADE968" as Address;
const ISM = "0xf9Ceb195C295c496952649574A78B2Da6dD7b05f" as Address;
const TRUSTED_SENDER_ADDRESS = "0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb" as Address;
const SEPOLIA_DOMAIN = 11155111;
const MAX_CHECKPOINT_LAG_LEAVES = 100;

const VALIDATORS = [
  { address: "0x2ffFd80d446835214EF87Eb3753B48935550f73f" as Address, label: "validator1" },
  { address: "0x0eD86FBF8cb56622BB3094FeCde2872018e0f4B3" as Address, label: "validator2" },
] as const;

type CheckStatus = "pass" | "warn" | "fail";
interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

const VALIDATOR_ANNOUNCE_ABI = [
  { type: "function", name: "getAnnouncedStorageLocations", stateMutability: "view", inputs: [{ type: "address[]" }], outputs: [{ type: "string[][]" }] },
] as const;
const MAILBOX_ABI = [{ type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] }] as const;
const ISM_ABI = [
  { type: "function", name: "validatorsAndThreshold", stateMutability: "view", inputs: [{ type: "bytes" }], outputs: [{ type: "address[]" }, { type: "uint8" }] },
] as const;
const DECISION_RELAY_ABI = [
  { type: "function", name: "settlementTarget", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "settlementMode", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "trustedSender", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "bytes32" }] },
] as const;
const MAILBOX_DISPATCH_EVENT = {
  type: "event",
  name: "Dispatch",
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "destination", type: "uint32", indexed: true },
    { name: "recipient", type: "bytes32", indexed: true },
    { name: "message", type: "bytes", indexed: false },
  ],
} as const;
const MAILBOX_DELIVERED_ABI = [{ type: "function", name: "delivered", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] }] as const;
const DISPATCH_LOOKBACK_BLOCKS = 9000n; // ~30h of Sepolia blocks — same window verify-deployment.ts uses, kept under common free-tier eth_getLogs range caps

/** Hyperlane message header: version(1) + nonce(4) + origin(4) + sender(32) + destination(4) + recipient(32) + body. Nonce is bytes 1..5. Same decode verify-deployment.ts uses. */
function decodeMessageNonce(message: `0x${string}`): number {
  const hex = message.slice(2);
  return parseInt(hex.slice(2, 10), 16);
}

/** Same literal URL convention Hyperlane's own S3 checkpoint syncer uses — see verify-deployment.ts's s3ObjectUrl for the real bug this fixed (region is a hostname selector, not a path segment). */
function s3ObjectUrl(loc: string, key: string): string {
  const [, , bucket, region, ...folderParts] = loc.split("/");
  const folder = folderParts.join("/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${folder}/${key}`;
}

async function getValidatorS3Locations(): Promise<Record<string, readonly string[]>> {
  const client = getEvmPublicClient();
  const locations = await client.readContract({
    address: VALIDATOR_ANNOUNCE,
    abi: VALIDATOR_ANNOUNCE_ABI,
    functionName: "getAnnouncedStorageLocations",
    args: [VALIDATORS.map((v) => v.address)],
  });
  const byValidator: Record<string, readonly string[]> = {};
  VALIDATORS.forEach((v, i) => {
    byValidator[v.address] = (locations as readonly (readonly string[])[])[i] ?? [];
  });
  return byValidator;
}

async function checkCheckpointCurrency(byValidator: Record<string, readonly string[]>): Promise<{ results: CheckResult[]; maxLag: number | null }> {
  const client = getEvmPublicClient();
  const results: CheckResult[] = [];
  let maxLag: number | null = null;

  const mailboxNonce = await client.readContract({ address: MAILBOX, abi: MAILBOX_ABI, functionName: "nonce" });

  for (const v of VALIDATORS) {
    const locs = byValidator[v.address] ?? [];
    const s3Loc = locs.find((l) => l.startsWith("s3://"));
    if (!s3Loc) {
      results.push({ name: `checkpoint-currency:${v.label}`, status: "fail", detail: "no announced S3 storage location" });
      continue;
    }
    try {
      const res = await fetch(s3ObjectUrl(s3Loc, "checkpoint_latest_index.json"));
      if (!res.ok) {
        results.push({ name: `checkpoint-currency:${v.label}`, status: "warn", detail: `checkpoint_latest_index.json -> HTTP ${res.status} (not independently verifiable over HTTPS)` });
        continue;
      }
      // Hyperlane's own format wraps the index as {"value": N}; accept a
      // bare number too rather than assume one shape and crash on the
      // other (same defensiveness as verify-deployment.ts's own check).
      const body = (await res.json()) as unknown;
      const latestIndex = typeof body === "number" ? body : Number((body as { value?: number })?.value);
      if (!Number.isFinite(latestIndex)) {
        results.push({ name: `checkpoint-currency:${v.label}`, status: "warn", detail: `checkpoint_latest_index.json reachable but unparseable: ${JSON.stringify(body)}` });
        continue;
      }
      const lag = Number(mailboxNonce) - latestIndex;
      maxLag = maxLag === null ? lag : Math.max(maxLag, lag);
      results.push({
        name: `checkpoint-currency:${v.label}`,
        status: lag > MAX_CHECKPOINT_LAG_LEAVES ? "fail" : "pass",
        detail: `latest signed index: ${latestIndex}, mailbox nonce: ${mailboxNonce}, lag: ${lag} leaves`,
      });
    } catch (err) {
      results.push({ name: `checkpoint-currency:${v.label}`, status: "fail", detail: `could not read checkpoint: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { results, maxLag };
}

/**
 * Real audit finding (2026-09-05): a message can be genuinely
 * undeliverable — no valid attestor signature exists for it yet on
 * either validator — while the confirmed-delivered check above still
 * passes, because that check can pick an OLDER dispatch already safely
 * within the completed backfill range. This checks the actual most
 * recent dispatch specifically, which is the one that matters: if it's
 * ahead of the sequential checkpoint frontier (see checkCheckpointCurrency)
 * with no per-message checkpoint covering it either, it cannot be
 * delivered right now, full stop — this is not a cosmetic metric.
 */
async function checkRecentDeliveryAndCoverage(byValidator: Record<string, readonly string[]>): Promise<CheckResult[]> {
  const client = getEvmPublicClient();
  const results: CheckResult[] = [];

  const currentBlock = await client.getBlockNumber();
  const fromBlock = currentBlock > DISPATCH_LOOKBACK_BLOCKS ? currentBlock - DISPATCH_LOOKBACK_BLOCKS : 0n;
  const logs = await client.getLogs({
    address: MAILBOX,
    event: MAILBOX_DISPATCH_EVENT,
    args: { sender: TRUSTED_SENDER_ADDRESS },
    fromBlock,
    toBlock: currentBlock,
  });

  if (logs.length === 0) {
    results.push({ name: "delivery:recent", status: "warn", detail: `no Dispatch events from ${TRUSTED_SENDER_ADDRESS} in the last ${DISPATCH_LOOKBACK_BLOCKS} blocks` });
    return results;
  }

  const latest = logs[logs.length - 1];
  const message = latest.args.message as `0x${string}`;
  const destinationDomain = latest.args.destination as number;
  const nonce = decodeMessageNonce(message);

  if (destinationDomain === SEPOLIA_DOMAIN) {
    const delivered = await client.readContract({ address: MAILBOX, abi: MAILBOX_DELIVERED_ABI, functionName: "delivered", args: [keccak256(message)] }).catch(() => null);
    results.push({
      name: "delivery:most-recent-dispatch",
      status: delivered ? "pass" : "warn",
      detail: `most recent dispatch (nonce ${nonce}, tx ${latest.transactionHash}) is ${delivered ? "" : "NOT yet "}delivered`,
    });
  }

  for (const v of VALIDATORS) {
    const locs = byValidator[v.address] ?? [];
    let found = false;
    for (const loc of locs) {
      if (!loc.startsWith("s3://") || found) continue;
      const res = await fetch(s3ObjectUrl(loc, `checkpoint_${nonce}_with_id.json`)).catch(() => null);
      if (res?.ok) found = true;
    }
    results.push({
      name: `message-checkpoint-coverage:${v.label}`,
      // "warn", not "fail" — confirmed live (2026-09-05) that a message
      // can read as genuinely delivered() on-chain (see delivery check
      // above) while this specific per-nonce object lookup finds
      // nothing, for a reason not yet understood (a since-pruned
      // individual checkpoint, a coverage path this naming convention
      // doesn't capture, or something else). Treat this as informative
      // context alongside the delivery check's ground truth, not as an
      // independent failure signal until that discrepancy is explained.
      status: found ? "pass" : "warn",
      detail: found
        ? `covers the most recent dispatch's leaf (nonce ${nonce}) — deliverable by this validator's own attestation regardless of sequential backfill lag`
        : `no published checkpoint for the most recent dispatch's leaf (nonce ${nonce}) — informative only; a real dispatch has been confirmed delivered despite this same "no checkpoint found" result, so absence here is not proof of undeliverability`,
    });
  }

  return results;
}

async function checkWiring(): Promise<CheckResult[]> {
  const client = getEvmPublicClient();
  const results: CheckResult[] = [];

  const [target, mode, trustedSender, ismValidatorsAndThreshold] = await Promise.all([
    client.readContract({ address: DECISION_RELAY, abi: DECISION_RELAY_ABI, functionName: "settlementTarget", args: [SEPOLIA_DOMAIN] }),
    client.readContract({ address: DECISION_RELAY, abi: DECISION_RELAY_ABI, functionName: "settlementMode", args: [SEPOLIA_DOMAIN] }),
    client.readContract({ address: DECISION_RELAY, abi: DECISION_RELAY_ABI, functionName: "trustedSender", args: [SEPOLIA_DOMAIN] }),
    client.readContract({ address: ISM, abi: ISM_ABI, functionName: "validatorsAndThreshold", args: ["0x"] }).catch(() => null),
  ]);

  results.push({
    name: "decisionrelay:settlementMode",
    status: Number(mode) === 1 ? "pass" : "fail",
    detail: `settlementMode(${SEPOLIA_DOMAIN}) = ${mode} (expected 1/SETTLEMENT)`,
  });
  results.push({
    name: "decisionrelay:settlementTarget",
    status: target !== "0x0000000000000000000000000000000000000000" ? "pass" : "fail",
    detail: `settlementTarget(${SEPOLIA_DOMAIN}) = ${target}`,
  });
  const expectedSender = `0x000000000000000000000000${TRUSTED_SENDER_ADDRESS.slice(2).toLowerCase()}`;
  results.push({
    name: "decisionrelay:trustedSender",
    status: (trustedSender as string).toLowerCase() === expectedSender ? "pass" : "fail",
    detail: `trustedSender(${SEPOLIA_DOMAIN}) = ${trustedSender}`,
  });
  if (ismValidatorsAndThreshold) {
    const [validators, threshold] = ismValidatorsAndThreshold as readonly [readonly Address[], number];
    results.push({
      name: "ism:validator-set",
      status: validators.length === VALIDATORS.length && Number(threshold) === VALIDATORS.length ? "pass" : "warn",
      detail: `ISM has ${validators.length} validator(s), threshold ${threshold}`,
    });
  }

  return results;
}

/** Static, config-derived — real independence requires distinct operators/accounts/providers, not just distinct addresses. See docs/self-hosted-validator-setup.md's own "What's still a placeholder" section. */
function checkValidatorIndependence(): CheckResult {
  return {
    name: "independence",
    status: "warn",
    detail:
      "Both validators share one operator, one cloud account, one AWS account, one S3 bucket. Not independent security actors — a single compromise or operational fault affects both. Do not count this toward quorum-based reliability guarantees until each validator has its own operator/account/provider/bucket.",
  };
}

export async function runReliabilityObservation(): Promise<{ passCount: number; warnCount: number; failCount: number }> {
  const allResults: CheckResult[] = [];
  let maxLag: number | null = null;
  let scriptCrashed = false;
  let crashDetail: string | null = null;

  let byValidator: Record<string, readonly string[]> = {};
  try {
    byValidator = await getValidatorS3Locations();
  } catch (err) {
    scriptCrashed = true;
    crashDetail = `getValidatorS3Locations crashed: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    const { results, maxLag: lag } = await checkCheckpointCurrency(byValidator);
    allResults.push(...results);
    maxLag = lag;
  } catch (err) {
    scriptCrashed = true;
    crashDetail = `${crashDetail ? crashDetail + "; " : ""}checkCheckpointCurrency crashed: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    allResults.push(...(await checkRecentDeliveryAndCoverage(byValidator)));
  } catch (err) {
    scriptCrashed = true;
    crashDetail = `${crashDetail ? crashDetail + "; " : ""}checkRecentDeliveryAndCoverage crashed: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    allResults.push(...(await checkWiring()));
  } catch (err) {
    scriptCrashed = true;
    crashDetail = `${crashDetail ? crashDetail + "; " : ""}checkWiring crashed: ${err instanceof Error ? err.message : String(err)}`;
  }

  allResults.push(checkValidatorIndependence());

  const passCount = allResults.filter((r) => r.status === "pass").length;
  const warnCount = allResults.filter((r) => r.status === "warn").length;
  const failCount = allResults.filter((r) => r.status === "fail").length;

  const observation = await prisma.reliabilityObservation.create({
    data: {
      checks: allResults as unknown as object,
      passCount,
      warnCount,
      failCount,
      maxCheckpointLagLeaves: maxLag,
      scriptCrashed,
      crashDetail,
    },
  });

  // Alert only on a NEW failure state (the prior observation didn't
  // fail), not every tick a known-bad condition persists — same
  // discipline as reconciliation.ts's raiseFinding. Escalation for a
  // persisting failure is exactly what the existing reconciliation
  // escalation path already does for ReconciliationFinding rows; this
  // module's job is durable measurement, not a second escalation
  // system.
  if (failCount > 0 || scriptCrashed) {
    const previous = await prisma.reliabilityObservation.findFirst({
      where: { id: { not: observation.id } },
      orderBy: { capturedAt: "desc" },
    });
    const previouslyHealthy = !previous || (previous.failCount === 0 && !previous.scriptCrashed);
    if (previouslyHealthy) {
      const failing = allResults.filter((r) => r.status === "fail").map((r) => `${r.name}: ${r.detail}`).join("\n");
      const title = scriptCrashed ? "Reliability observation crashed" : `Reliability observation found ${failCount} failing check(s)`;
      const detail = scriptCrashed ? crashDetail! : failing;
      try {
        await sendOpsAlert({ severity: "critical", title, detail });
      } catch (err) {
        console.error("reliability-monitor: failed to deliver Slack alert", err);
      }
      try {
        await sendNtfyAlert({ title, detail: "A reliability check started failing. See /settings/reliability for details.", priority: "urgent" });
      } catch (err) {
        console.error("reliability-monitor: failed to deliver ntfy alert", err);
      }
    }
  }

  return { passCount, warnCount, failCount };
}
