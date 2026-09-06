import { type Address, keccak256, decodeAbiParameters } from "viem";
import { getEvmPublicClient } from "@/lib/hyperlane";
import { prisma } from "@/lib/prisma";
import { sendOpsAlert, sendNtfyAlert } from "@/lib/alerts";

// Re-audit response (Phase 0 — reliability evidence exporter). Ports
// the core, continuously-meaningful checks from
// chains/hyperlane-validator/scripts/verify-deployment.ts (a manual,
// point-in-time script whose results were previously recorded by hand
// as markdown "Log Snapshot N" entries — see 24H_OBSERVATION_LOG.md)
// into a real periodic sweep with durable, queryable storage
// (ReliabilityObservation) — so a genuine 30-day reliability window
// has actual accumulated evidence behind it, not manual snapshots.
//
// 2026-09-05 hardening pass (re-audit response): every check now
// records its raw evidence (HTTP status, response headers, full
// checkpoint body, on-chain read latency) alongside the pass/warn/fail
// verdict, not just a human sentence — "trust the underlying data, not
// the summary" is the whole point of an evidence exporter meant to
// leave a Hyperlane maintainer or an external auditor able to verify
// the claim themselves. Also adds a message-level processedDecisions
// check (real ground truth for "was this decision actually settled",
// independent of the delivered()/checkpoint-coverage discrepancy this
// session found and never fully explained) and a real
// HEALTHY/DEGRADED/DELIVERY_BLOCKED/UNKNOWN state, computed
// deterministically — no inferred "probably fine."
//
// chains/hyperlane-validator isn't an npm workspace and isn't shipped
// in the worker's Docker image (see apps/web/Dockerfile.worker) — this
// module is intentionally self-contained rather than shelling out to
// that script, so it works in the deployed worker with zero extra
// packaging.

const MAILBOX = "0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766" as Address;
// The tree leaf count any validator can ever checkpoint to — NOT
// Mailbox.nonce(), which counts every dispatch from every user of this
// shared canonical testnet mailbox, not just Anchor's own traffic. This
// was a real false-alarm root cause found and fixed in
// chains/hyperlane-validator/scripts/verify-deployment.ts earlier this
// project; this module is a separate implementation (see header) that
// carried the same bug independently until this fix (2026-09-06) — it
// was producing a fake ~1370-leaf "lag" and a false DELIVERY_BLOCKED
// state on the live dashboard.
const MERKLE_TREE_HOOK = "0x4917a9746A7B6E0A57159cCb7F5a6744247f2d0d" as Address;
const VALIDATOR_ANNOUNCE = "0xE6105C59480a1B7DD3E4f28153aFdbE12F4CfCD9" as Address;
// Current as of the validator2-replacement cutover (2026-09-06) — see
// chains/hyperlane-validator/deployment.json (source of truth) and
// VALIDATOR2_REPLACEMENT.md. These were also stale here (still pointing
// at the pre-validator3 relay/ISM) until this fix.
const DECISION_RELAY = "0x1fc130416Dc09dff60e0Ea3C8dE8474e8428b3E2" as Address;
const ISM = "0xd916b90858B8bF7Cc7E111D3C7923ab4Fe0FCcf0" as Address;
const TRUSTED_SENDER_ADDRESS = "0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb" as Address;
const SEPOLIA_DOMAIN = 11155111;
const MAX_CHECKPOINT_LAG_LEAVES = 100;

// Mirrors chains/hyperlane-validator/deployment.json's validators array
// (kept as a separate literal here rather than importing that file,
// per this module's own "intentionally self-contained" note above).
// flyApp is only present for Fly-hosted validators — validator2 and
// validator3 run on their own independent AWS EC2 instances instead
// (see VALIDATOR2_REPLACEMENT.md / VALIDATOR3_CUTOVER.md), so
// checkValidatorMachineMetadata below treats its absence as "not
// applicable," not an error.
const VALIDATORS = [
  { address: "0x2ffFd80d446835214EF87Eb3753B48935550f73f" as Address, label: "validator1", operator: "anchor-operator", account: "fly:priscilla-george-personal", provider: "fly.io", flyApp: "anc-hor-validator1" as string | undefined },
  { address: "0xf171c23607b892797Eb5eb4e52fc668f924Df0A3" as Address, label: "validator2", operator: "independent-operator-gideon820001", account: "aws:069066994101", provider: "aws-ec2", flyApp: undefined as string | undefined },
  { address: "0x4dbc8704ebD282535d64Be6daDF2a477C543114D" as Address, label: "validator3", operator: "independent-operator-bard775", account: "aws:269469928649", provider: "aws-ec2", flyApp: undefined as string | undefined },
] as const;

type CheckStatus = "pass" | "warn" | "fail";
interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Raw, independently-verifiable evidence behind the verdict above — HTTP status/headers/body, on-chain call latency, etc. Never summarized away. */
  evidence?: Record<string, unknown>;
}

type ReliabilityState = "HEALTHY" | "DEGRADED" | "DELIVERY_BLOCKED" | "UNKNOWN";

interface RpcCallStat {
  method: string;
  latencyMs: number;
  success: boolean;
  error?: string;
}

const VALIDATOR_ANNOUNCE_ABI = [
  { type: "function", name: "getAnnouncedStorageLocations", stateMutability: "view", inputs: [{ type: "address[]" }], outputs: [{ type: "string[][]" }] },
] as const;
const MERKLE_TREE_HOOK_ABI = [{ type: "function", name: "count", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] }] as const;
const ISM_ABI = [
  { type: "function", name: "validatorsAndThreshold", stateMutability: "view", inputs: [{ type: "bytes" }], outputs: [{ type: "address[]" }, { type: "uint8" }] },
] as const;
const DECISION_RELAY_ABI = [
  { type: "function", name: "settlementTarget", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "settlementMode", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "trustedSender", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "processedDecisions", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
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

// Matches packages/hyperlane-relay/index.ts's encodeDecisionRelayBody
// exactly — the ONE place this shape is defined; duplicated here (not
// imported) only because that package isn't built for direct TS
// import from this module's real runtime path. Keep these two in sync
// if that encoding ever changes.
const DECISION_RELAY_BODY_ABI = [
  { type: "bytes32" }, // caseId
  { type: "string" }, // outcome
  { type: "uint256" }, // claimantAmount
  { type: "uint256" }, // respondentAmount
  { type: "bytes32" }, // escrowId
  { type: "bytes32" }, // proofHash
  { type: "bytes[]" }, // attestationSignatures
] as const;
const MESSAGE_HEADER_BYTES = 1 + 4 + 4 + 32 + 4 + 32; // version + nonce + origin + sender + destination + recipient

/** Hyperlane message header: version(1) + nonce(4) + origin(4) + sender(32) + destination(4) + recipient(32) + body. Nonce is bytes 1..5. Same decode verify-deployment.ts uses. */
function decodeMessageNonce(message: `0x${string}`): number {
  const hex = message.slice(2);
  return parseInt(hex.slice(2, 10), 16);
}

function decodeMessageBody(message: `0x${string}`): `0x${string}` {
  return `0x${message.slice(2 + MESSAGE_HEADER_BYTES * 2)}` as `0x${string}`;
}

/** Best-effort — this decode only applies to DecisionRelay-shaped messages (real settlement dispatches); anything else (e.g. a raw test/proof message) fails to decode and is reported as such, not silently skipped. */
function tryDecodeProofHash(message: `0x${string}`): { ok: true; proofHash: `0x${string}` } | { ok: false; reason: string } {
  try {
    const body = decodeMessageBody(message);
    const [, , , , , proofHash] = decodeAbiParameters(DECISION_RELAY_BODY_ABI, body);
    return { ok: true, proofHash: proofHash as `0x${string}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Same literal URL convention Hyperlane's own S3 checkpoint syncer uses — see verify-deployment.ts's s3ObjectUrl for the real bug this fixed (region is a hostname selector, not a path segment). */
function s3ObjectUrl(loc: string, key: string): string {
  const [, , bucket, region, ...folderParts] = loc.split("/");
  const folder = folderParts.join("/");
  return `https://${bucket}.s3.${region}.amazonaws.com/${folder}/${key}`;
}

/** Fetches an S3 checkpoint object and returns full, independently-verifiable evidence — not just ok/not-ok. Selected response headers only (no auth-adjacent ones — these are anonymous public reads, so there's nothing sensitive to redact, but keep it to headers actually useful for verification). */
async function fetchS3Evidence(url: string): Promise<{ status: number | null; headers: Record<string, string>; body: unknown; error?: string }> {
  try {
    const res = await fetch(url);
    const headers: Record<string, string> = {};
    for (const key of ["last-modified", "content-length", "etag", "x-amz-request-id"]) {
      const v = res.headers.get(key);
      if (v) headers[key] = v;
    }
    let body: unknown = null;
    if (res.ok) {
      try {
        body = await res.json();
      } catch {
        body = "(non-JSON body)";
      }
    }
    return { status: res.status, headers, body };
  } catch (err) {
    return { status: null, headers: {}, body: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function timedRpcCall<T>(rpcStats: RpcCallStat[], method: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    rpcStats.push({ method, latencyMs: Date.now() - start, success: true });
    return result;
  } catch (err) {
    rpcStats.push({ method, latencyMs: Date.now() - start, success: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

async function getValidatorS3Locations(rpcStats: RpcCallStat[]): Promise<Record<string, readonly string[]>> {
  const client = getEvmPublicClient();
  const locations = await timedRpcCall(rpcStats, "ValidatorAnnounce.getAnnouncedStorageLocations", () =>
    client.readContract({
      address: VALIDATOR_ANNOUNCE,
      abi: VALIDATOR_ANNOUNCE_ABI,
      functionName: "getAnnouncedStorageLocations",
      args: [VALIDATORS.map((v) => v.address)],
    })
  );
  const byValidator: Record<string, readonly string[]> = {};
  VALIDATORS.forEach((v, i) => {
    byValidator[v.address] = (locations as readonly (readonly string[])[])[i] ?? [];
  });
  return byValidator;
}

async function checkCheckpointCurrency(byValidator: Record<string, readonly string[]>, rpcStats: RpcCallStat[]): Promise<{ results: CheckResult[]; maxLag: number | null }> {
  const client = getEvmPublicClient();
  const results: CheckResult[] = [];
  let maxLag: number | null = null;

  const treeLeafCount = await timedRpcCall(rpcStats, "MerkleTreeHook.count", () => client.readContract({ address: MERKLE_TREE_HOOK, abi: MERKLE_TREE_HOOK_ABI, functionName: "count" }));

  for (const v of VALIDATORS) {
    const locs = byValidator[v.address] ?? [];
    const s3Loc = locs.find((l) => l.startsWith("s3://"));
    if (!s3Loc) {
      results.push({ name: `checkpoint-currency:${v.label}`, status: "fail", detail: "no announced S3 storage location", evidence: { announcedLocations: locs } });
      continue;
    }
    const url = s3ObjectUrl(s3Loc, "checkpoint_latest_index.json");
    const ev = await fetchS3Evidence(url);
    if (ev.error || ev.status === null) {
      results.push({ name: `checkpoint-currency:${v.label}`, status: "fail", detail: `checkpoint_latest_index.json fetch failed: ${ev.error}`, evidence: { url, ...ev } });
      continue;
    }
    if (ev.status !== 200) {
      results.push({ name: `checkpoint-currency:${v.label}`, status: "warn", detail: `checkpoint_latest_index.json -> HTTP ${ev.status} (not independently verifiable over HTTPS)`, evidence: { url, ...ev } });
      continue;
    }
    // Hyperlane's own format wraps the index as {"value": N}; accept a
    // bare number too rather than assume one shape and crash on the other.
    const latestIndex = typeof ev.body === "number" ? ev.body : Number((ev.body as { value?: number })?.value);
    if (!Number.isFinite(latestIndex)) {
      results.push({ name: `checkpoint-currency:${v.label}`, status: "warn", detail: `checkpoint_latest_index.json reachable but unparseable: ${JSON.stringify(ev.body)}`, evidence: { url, ...ev } });
      continue;
    }
    const lag = Number(treeLeafCount) - latestIndex;
    maxLag = maxLag === null ? lag : Math.max(maxLag, lag);
    results.push({
      name: `checkpoint-currency:${v.label}`,
      status: lag > MAX_CHECKPOINT_LAG_LEAVES ? "fail" : "pass",
      detail: `latest signed index: ${latestIndex}, tree leaf count: ${treeLeafCount}, lag: ${lag} leaves`,
      evidence: { url, latestIndex, treeLeafCount: Number(treeLeafCount), lag, ...ev },
    });
  }
  return { results, maxLag };
}

/**
 * Real audit finding (2026-09-05): a message can be genuinely
 * undeliverable — no valid attestor signature exists for it yet on
 * either validator — while a confirmed-delivered check can still pass
 * if it picks an OLDER dispatch already safely within the completed
 * backfill range. This checks the actual most recent dispatch
 * specifically. Also checks DecisionRelay.processedDecisions directly
 * (real settlement ground truth, independent of Mailbox.delivered()) —
 * a message can be "delivered" at the Mailbox/ISM level without
 * settle() having actually run, or vice versa in theory; checking both
 * separately is what an evidence exporter is for.
 */
async function checkRecentDeliveryAndCoverage(byValidator: Record<string, readonly string[]>, rpcStats: RpcCallStat[]): Promise<CheckResult[]> {
  const client = getEvmPublicClient();
  const results: CheckResult[] = [];

  const currentBlock = await timedRpcCall(rpcStats, "eth_blockNumber", () => client.getBlockNumber());
  const fromBlock = currentBlock > DISPATCH_LOOKBACK_BLOCKS ? currentBlock - DISPATCH_LOOKBACK_BLOCKS : 0n;
  const logs = await timedRpcCall(rpcStats, "eth_getLogs(Dispatch)", () =>
    client.getLogs({ address: MAILBOX, event: MAILBOX_DISPATCH_EVENT, args: { sender: TRUSTED_SENDER_ADDRESS }, fromBlock, toBlock: currentBlock })
  );

  if (logs.length === 0) {
    results.push({ name: "delivery:recent", status: "warn", detail: `no Dispatch events from ${TRUSTED_SENDER_ADDRESS} in the last ${DISPATCH_LOOKBACK_BLOCKS} blocks` });
    return results;
  }

  const latest = logs[logs.length - 1];
  const message = latest.args.message as `0x${string}`;
  const destinationDomain = latest.args.destination as number;
  const nonce = decodeMessageNonce(message);
  const messageId = keccak256(message);

  if (destinationDomain === SEPOLIA_DOMAIN) {
    const delivered = await timedRpcCall(rpcStats, "Mailbox.delivered", () =>
      client.readContract({ address: MAILBOX, abi: MAILBOX_DELIVERED_ABI, functionName: "delivered", args: [messageId] })
    ).catch(() => null);

    const decoded = tryDecodeProofHash(message);
    let processedDecision: boolean | null = null;
    if (decoded.ok) {
      processedDecision = await timedRpcCall(rpcStats, "DecisionRelay.processedDecisions", () =>
        client.readContract({ address: DECISION_RELAY, abi: DECISION_RELAY_ABI, functionName: "processedDecisions", args: [decoded.proofHash] })
      ).catch(() => null);
    }

    // Flagged, not silently buried in evidence: delivered=true with
    // processedDecisions=false is either a real settlement gap (handle()
    // ran but settle() didn't complete/commit) or — more likely, since
    // this session dispatched several non-settlement message types from
    // the same TRUSTED_SENDER_ADDRESS — this specific dispatch simply
    // isn't DecisionRelay-body-shaped and the proofHash decode above,
    // while it didn't throw, extracted meaningless bytes. Not
    // determined which; noted explicitly rather than asserted either way.
    const unexplainedGap = decoded.ok && delivered === true && processedDecision === false;
    results.push({
      name: "delivery:most-recent-dispatch",
      status: delivered ? "pass" : "warn",
      detail:
        `most recent dispatch (nonce ${nonce}, tx ${latest.transactionHash}, messageId ${messageId}) is ${delivered ? "" : "NOT yet "}delivered` +
        (unexplainedGap ? " — NOTE: delivered=true but DecisionRelay.processedDecisions(proofHash)=false; not yet determined whether this is a real settlement gap or a non-DecisionRelay message this decode misread" : ""),
      evidence: {
        nonce,
        messageId,
        txHash: latest.transactionHash,
        mailboxDelivered: delivered,
        proofHash: decoded.ok ? decoded.proofHash : null,
        proofHashDecodeError: decoded.ok ? undefined : decoded.reason,
        decisionRelayProcessedDecisions: processedDecision,
        unexplainedGap,
      },
    });
  }

  for (const v of VALIDATORS) {
    const locs = byValidator[v.address] ?? [];
    let found = false;
    let checkedUrl: string | null = null;
    let lastEvidence: Awaited<ReturnType<typeof fetchS3Evidence>> | null = null;
    for (const loc of locs) {
      if (!loc.startsWith("s3://") || found) continue;
      checkedUrl = s3ObjectUrl(loc, `checkpoint_${nonce}_with_id.json`);
      lastEvidence = await fetchS3Evidence(checkedUrl);
      if (lastEvidence.status === 200) found = true;
    }
    results.push({
      name: `message-checkpoint-coverage:${v.label}`,
      // "warn", not "fail" — confirmed live (2026-09-05) that a message
      // can read as genuinely delivered() on-chain (see delivery check
      // above) while this specific per-nonce object lookup finds
      // nothing, for a reason not yet fully understood. Treat this as
      // informative context alongside the delivery/processedDecisions
      // checks' ground truth, not as an independent failure signal.
      status: found ? "pass" : "warn",
      detail: found
        ? `covers the most recent dispatch's leaf (nonce ${nonce}) — deliverable by this validator's own attestation regardless of sequential backfill lag`
        : `no published checkpoint for the most recent dispatch's leaf (nonce ${nonce}) — informative only; real dispatches have been confirmed delivered despite this same "no checkpoint found" result`,
      evidence: { url: checkedUrl, nonce, ...lastEvidence },
    });
  }

  return results;
}

async function checkWiring(rpcStats: RpcCallStat[]): Promise<CheckResult[]> {
  const client = getEvmPublicClient();
  const results: CheckResult[] = [];

  const [target, mode, trustedSender, ismValidatorsAndThreshold] = await Promise.all([
    timedRpcCall(rpcStats, "DecisionRelay.settlementTarget", () => client.readContract({ address: DECISION_RELAY, abi: DECISION_RELAY_ABI, functionName: "settlementTarget", args: [SEPOLIA_DOMAIN] })),
    timedRpcCall(rpcStats, "DecisionRelay.settlementMode", () => client.readContract({ address: DECISION_RELAY, abi: DECISION_RELAY_ABI, functionName: "settlementMode", args: [SEPOLIA_DOMAIN] })),
    timedRpcCall(rpcStats, "DecisionRelay.trustedSender", () => client.readContract({ address: DECISION_RELAY, abi: DECISION_RELAY_ABI, functionName: "trustedSender", args: [SEPOLIA_DOMAIN] })),
    timedRpcCall(rpcStats, "ISM.validatorsAndThreshold", () => client.readContract({ address: ISM, abi: ISM_ABI, functionName: "validatorsAndThreshold", args: ["0x"] })).catch(() => null),
  ]);

  results.push({
    name: "decisionrelay:settlementMode",
    status: Number(mode) === 1 ? "pass" : "fail",
    detail: `settlementMode(${SEPOLIA_DOMAIN}) = ${mode} (expected 1/SETTLEMENT)`,
    evidence: { mode: Number(mode) },
  });
  results.push({
    name: "decisionrelay:settlementTarget",
    status: target !== "0x0000000000000000000000000000000000000000" ? "pass" : "fail",
    detail: `settlementTarget(${SEPOLIA_DOMAIN}) = ${target}`,
    evidence: { target },
  });
  const expectedSender = `0x000000000000000000000000${TRUSTED_SENDER_ADDRESS.slice(2).toLowerCase()}`;
  results.push({
    name: "decisionrelay:trustedSender",
    status: (trustedSender as string).toLowerCase() === expectedSender ? "pass" : "fail",
    detail: `trustedSender(${SEPOLIA_DOMAIN}) = ${trustedSender}`,
    evidence: { trustedSender, expectedSender },
  });
  if (ismValidatorsAndThreshold) {
    const [validators, threshold] = ismValidatorsAndThreshold as readonly [readonly Address[], number];
    results.push({
      name: "ism:validator-set",
      status: validators.length === VALIDATORS.length && Number(threshold) === VALIDATORS.length ? "pass" : "warn",
      detail: `ISM has ${validators.length} validator(s), threshold ${threshold}`,
      evidence: { validators, threshold },
    });
  }

  return results;
}

/** Static, config-derived — real independence requires distinct operators/accounts/providers, not just distinct addresses. See docs/self-hosted-validator-setup.md's own "What's still a placeholder" section. */
/**
 * Computed from VALIDATORS' own operator/account/provider metadata
 * rather than a hand-written sentence — the previous hardcoded "both
 * validators share everything" text survived unedited through the
 * validator3 addition AND the validator2 replacement (see
 * VALIDATOR2_REPLACEMENT.md), silently describing a stale 2-validator
 * state that had already been fixed on-chain. Mirrors
 * chains/hyperlane-validator/scripts/verify-deployment.ts's
 * checkOperatorIndependence so the two never drift into disagreement
 * about the same real-world fact again.
 */
function checkValidatorIndependence(): CheckResult {
  const accounts = new Set(VALIDATORS.map((v) => v.account));
  const operators = new Set(VALIDATORS.map((v) => v.operator));
  const providers = new Set(VALIDATORS.map((v) => v.provider));

  const sharedDims: string[] = [];
  if (accounts.size < VALIDATORS.length) sharedDims.push("cloud account");
  if (operators.size < VALIDATORS.length) sharedDims.push("operator");
  if (providers.size < VALIDATORS.length) sharedDims.push("cloud provider");

  if (sharedDims.length > 0) {
    return {
      name: "independence",
      status: "warn",
      detail: `NOT independent consensus: validators share ${sharedDims.join(", ")}. A compromise of that shared thing compromises every validator that shares it. Do not count this toward quorum-based reliability guarantees until every validator has its own operator, account, and provider.`,
    };
  }
  return { name: "independence", status: "pass", detail: "every validator has a distinct operator, account, and cloud provider" };
}

/**
 * Validator process metadata (deployed image digest, restart count,
 * uptime) via Fly's Machines API — genuinely optional, since it needs
 * a Fly API token this worker doesn't hold by default (deliberately:
 * not provisioning a broad personal/account-level token into a
 * running service without the operator's own explicit choice). Absent
 * FLY_API_TOKEN, this reports "unknown" rather than fabricating a
 * healthy-looking gap — exactly the UNKNOWN state this exporter is
 * meant to make honest.
 */
async function checkValidatorMachineMetadata(): Promise<CheckResult[]> {
  const flyValidators = VALIDATORS.filter((v): v is (typeof VALIDATORS)[number] & { flyApp: string } => Boolean(v.flyApp));
  const nonFlyResults: CheckResult[] = VALIDATORS.filter((v) => !v.flyApp).map((v) => ({
    name: `machine-metadata:${v.label}`,
    status: "pass" as const,
    detail: `not Fly-hosted (provider: ${v.provider}) — this check only covers Fly Machines API metadata; not applicable`,
  }));

  const token = process.env.FLY_API_TOKEN;
  if (!token) {
    return [
      ...flyValidators.map((v) => ({
        name: `machine-metadata:${v.label}`,
        status: "warn" as const,
        detail: `FLY_API_TOKEN not configured on this worker — validator uptime/restart-count/image-digest/memory/disk cannot be captured. Set a scoped, read-only Fly API token to close this gap.`,
      })),
      ...nonFlyResults,
    ];
  }

  const results: CheckResult[] = [...nonFlyResults];
  for (const v of flyValidators) {
    try {
      const res = await fetch(`https://api.machines.dev/v1/apps/${v.flyApp}/machines`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        results.push({ name: `machine-metadata:${v.label}`, status: "warn", detail: `Fly Machines API returned HTTP ${res.status}`, evidence: { status: res.status } });
        continue;
      }
      const machines = (await res.json()) as Array<{ id: string; state: string; image_ref?: { digest?: string }; created_at?: string }>;
      const machine = machines[0];
      results.push({
        name: `machine-metadata:${v.label}`,
        status: machine?.state === "started" ? "pass" : "warn",
        detail: `state: ${machine?.state ?? "unknown"}, image digest: ${machine?.image_ref?.digest ?? "unknown"}`,
        evidence: { machines },
      });
    } catch (err) {
      results.push({ name: `machine-metadata:${v.label}`, status: "warn", detail: `Fly Machines API call failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return results;
}

/**
 * Deterministic overall state — no "probably fine." HEALTHY requires
 * every check to pass. DELIVERY_BLOCKED specifically means the checks
 * that answer "can a real message settle right now" failed (checkpoint
 * currency past threshold, or the most recent dispatch confirmed
 * undelivered past a reasonable window) — this is the state that
 * should gate any settlement-eligibility decision, never an inferred
 * "probably okay." DEGRADED covers everything else with a warn but no
 * delivery-relevant failure. UNKNOWN means the sweep itself couldn't
 * form a reliable picture (crashed, or one of the on-chain reads
 * needed to compute state failed outright).
 */
function computeState(results: CheckResult[], scriptCrashed: boolean): ReliabilityState {
  if (scriptCrashed) return "UNKNOWN";
  const deliveryRelevant = results.filter((r) => r.name.startsWith("checkpoint-currency:") || r.name === "delivery:most-recent-dispatch");
  if (deliveryRelevant.some((r) => r.status === "fail")) return "DELIVERY_BLOCKED";
  if (results.some((r) => r.status === "fail" || r.status === "warn")) return "DEGRADED";
  return "HEALTHY";
}

export async function runReliabilityObservation(): Promise<{ passCount: number; warnCount: number; failCount: number; state: ReliabilityState }> {
  const allResults: CheckResult[] = [];
  const rpcStats: RpcCallStat[] = [];
  let maxLag: number | null = null;
  let scriptCrashed = false;
  let crashDetail: string | null = null;

  let byValidator: Record<string, readonly string[]> = {};
  try {
    byValidator = await getValidatorS3Locations(rpcStats);
  } catch (err) {
    scriptCrashed = true;
    crashDetail = `getValidatorS3Locations crashed: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    const { results, maxLag: lag } = await checkCheckpointCurrency(byValidator, rpcStats);
    allResults.push(...results);
    maxLag = lag;
  } catch (err) {
    scriptCrashed = true;
    crashDetail = `${crashDetail ? crashDetail + "; " : ""}checkCheckpointCurrency crashed: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    allResults.push(...(await checkRecentDeliveryAndCoverage(byValidator, rpcStats)));
  } catch (err) {
    scriptCrashed = true;
    crashDetail = `${crashDetail ? crashDetail + "; " : ""}checkRecentDeliveryAndCoverage crashed: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    allResults.push(...(await checkWiring(rpcStats)));
  } catch (err) {
    scriptCrashed = true;
    crashDetail = `${crashDetail ? crashDetail + "; " : ""}checkWiring crashed: ${err instanceof Error ? err.message : String(err)}`;
  }

  allResults.push(checkValidatorIndependence());
  allResults.push(...(await checkValidatorMachineMetadata()));

  const passCount = allResults.filter((r) => r.status === "pass").length;
  const warnCount = allResults.filter((r) => r.status === "warn").length;
  const failCount = allResults.filter((r) => r.status === "fail").length;
  const state = computeState(allResults, scriptCrashed);

  const observation = await prisma.reliabilityObservation.create({
    data: {
      checks: allResults as unknown as object,
      rpcStats: rpcStats as unknown as object,
      state,
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
      const title = scriptCrashed ? "Reliability observation crashed" : `Reliability observation found ${failCount} failing check(s) — state: ${state}`;
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

  return { passCount, warnCount, failCount, state };
}
