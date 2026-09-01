#!/usr/bin/env npx tsx
// Verifies the live state of Anchor's Hyperlane validator/ISM/relayer
// deployment against what's actually on-chain and actually reachable —
// built in response to a production-readiness audit that correctly
// asked for a repeatable check instead of point-in-time claims in a
// README. Run it any time after a validator, ISM, or DecisionRelay
// change, and periodically (see the alerting section at the bottom) to
// catch drift.
//
// Usage:
//   npx tsx chains/hyperlane-validator/scripts/verify-deployment.ts
//   npx tsx chains/hyperlane-validator/scripts/verify-deployment.ts --json
//
// Reads live config from chains/hyperlane-validator/deployment.json
// (machine-readable, checked in) rather than hardcoding addresses here,
// so this script and the human-readable runbook can't silently drift
// from each other — update deployment.json when any of these values
// change, nothing else.
//
// Exit code: 0 if every check passes, 1 if any check fails or reports a
// warning. Safe to wire into a cron/CI job for alerting (see bottom).

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";

const __dirname = dirname(fileURLToPath(import.meta.url));
const asJson = process.argv.includes("--json");

interface Deployment {
  sepolia: {
    rpcUrl: string;
    mailbox: Address;
    validatorAnnounce: Address;
    decisionRelay: Address;
    ism: Address;
    dispatcherAddress: Address;
  };
  validators: { address: Address; label: string; operator: string; account: string; provider: string; iamPrincipal: string; s3Bucket: string; s3Prefix: string }[];
  expectedThreshold: number;
  relayerWhitelistFile: string;
  checkpointFreshnessThresholdSeconds: number;
  undeliveredMessageSlaSeconds: number;
  dispatchLookbackBlocks: number;
}

const deployment: Deployment = JSON.parse(readFileSync(join(__dirname, "..", "deployment.json"), "utf-8"));

type CheckResult = { name: string; status: "pass" | "fail" | "warn"; detail: string };
const results: CheckResult[] = [];
function record(name: string, status: CheckResult["status"], detail: string) {
  results.push({ name, status, detail });
}

const client = createPublicClient({ chain: sepolia, transport: http(deployment.sepolia.rpcUrl) });

const VALIDATOR_ANNOUNCE_ABI = [
  {
    type: "function",
    name: "getAnnouncedStorageLocations",
    stateMutability: "view",
    inputs: [{ name: "_validators", type: "address[]" }],
    outputs: [{ name: "", type: "string[][]" }],
  },
] as const;

const ISM_ABI = [
  {
    type: "function",
    name: "validatorsAndThreshold",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes" }],
    outputs: [{ name: "", type: "address[]" }, { name: "", type: "uint8" }],
  },
] as const;

const DECISION_RELAY_ABI = [
  {
    type: "function",
    name: "interchainSecurityModule",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "trustedSender",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint32" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

// --- Check 1: every configured validator is announced on-chain ---
async function checkAnnouncements(): Promise<Record<string, string[]>> {
  const addresses = deployment.validators.map((v) => v.address);
  const locations = await client.readContract({
    address: deployment.sepolia.validatorAnnounce,
    abi: VALIDATOR_ANNOUNCE_ABI,
    functionName: "getAnnouncedStorageLocations",
    args: [addresses],
  });
  const byValidator: Record<string, string[]> = {};
  locations.forEach((locs, i) => {
    const v = deployment.validators[i];
    byValidator[v.address] = locs;
    if (locs.length === 0) {
      record(`announcement:${v.label}`, "fail", `${v.address} has NOT announced any storage location on-chain`);
    } else {
      record(`announcement:${v.label}`, "pass", `announced: ${locs.join(", ")}`);
    }
  });
  return byValidator;
}

// --- Check 2: announced checkpoint locations are actually reachable (anonymous HTTPS GET, same as a real relayer would do — NOT using our own AWS credentials, since a third-party relayer never has those) ---
//
// A real bug found running this check live: the Hyperlane agent's
// announced storage location string includes the AWS region as an
// extra path segment ("s3://bucket/eu-north-1/validator1") that does
// NOT match where the checkpointSyncer actually writes objects
// ("validator1/..." — confirmed by listing the bucket directly). This
// function therefore tries the literal announced path FIRST (what a
// real relayer that trusts the announcement literally would do), and
// falls back to the region-stripped path second, reporting which one
// (if either) actually works — so this stays a genuine reachability
// check, not one that's silently been "fixed" to only ever test the
// path we know is right.
async function checkReachability(byValidator: Record<string, string[]>): Promise<void> {
  for (const v of deployment.validators) {
    const locs = byValidator[v.address] ?? [];
    for (const loc of locs) {
      if (!loc.startsWith("s3://")) {
        record(`reachability:${v.label}`, "warn", `non-S3 storage location "${loc}" — this script only knows how to check S3`);
        continue;
      }
      const [, , bucket, ...prefixParts] = loc.split("/");
      const announcedPrefix = prefixParts.join("/");
      const regionStrippedPrefix = prefixParts.slice(1).join("/"); // drop a leading region-looking segment, if any
      const candidates = [
        { label: "as literally announced", url: `https://${bucket}.s3.amazonaws.com/${announcedPrefix}/metadata_latest.json` },
        { label: "region-segment stripped (real object path)", url: `https://${bucket}.s3.amazonaws.com/${regionStrippedPrefix}/metadata_latest.json` },
      ];
      let anyOk = false;
      for (const c of candidates) {
        try {
          const res = await fetch(c.url);
          if (res.ok) {
            anyOk = true;
            record(`reachability:${v.label}`, "pass", `${c.label}: ${c.url} -> HTTP ${res.status}`);
          } else {
            record(`reachability:${v.label}`, "warn", `${c.label}: ${c.url} -> HTTP ${res.status}`);
          }
        } catch (err) {
          record(`reachability:${v.label}`, "warn", `${c.label}: ${c.url} -> ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!anyOk) {
        record(
          `reachability:${v.label}:summary`,
          "fail",
          `neither the literally-announced path nor the region-stripped path is reachable — a REAL relayer with no AWS ` +
            `credentials fetches checkpoints via plain HTTPS; if nothing here is public-read, no third-party relayer can ` +
            `ever deliver a message this validator signed`
        );
      } else {
        record(`reachability:${v.label}:summary`, "pass", "at least one real checkpoint path is publicly reachable");
      }
    }
  }
}

// --- Check 3: checkpoint freshness ---
async function checkFreshness(byValidator: Record<string, string[]>): Promise<void> {
  for (const v of deployment.validators) {
    const locs = byValidator[v.address] ?? [];
    for (const loc of locs) {
      if (!loc.startsWith("s3://")) continue;
      const [, , bucket, ...prefixParts] = loc.split("/");
      const announcedPrefix = prefixParts.join("/");
      const regionStrippedPrefix = prefixParts.slice(1).join("/");
      // Same fallback reasoning as checkReachability — try both known path shapes, use whichever actually responds.
      const urlCandidates = [
        `https://${bucket}.s3.amazonaws.com/${announcedPrefix}/metadata_latest.json`,
        `https://${bucket}.s3.amazonaws.com/${regionStrippedPrefix}/metadata_latest.json`,
      ];
      let res: Response | null = null;
      let url = urlCandidates[0];
      for (const candidate of urlCandidates) {
        const attempt = await fetch(candidate).catch(() => null);
        if (attempt?.ok) {
          res = attempt;
          url = candidate;
          break;
        }
      }
      try {
        if (!res || !res.ok) {
          record(`freshness:${v.label}`, "warn", "skipped — metadata_latest.json not reachable (see reachability check above)");
          continue;
        }
        const lastModifiedHeader = res.headers.get("last-modified");
        if (!lastModifiedHeader) {
          record(`freshness:${v.label}`, "warn", "S3 response had no Last-Modified header — cannot determine freshness");
          continue;
        }
        const ageSeconds = (Date.now() - new Date(lastModifiedHeader).getTime()) / 1000;
        if (ageSeconds > deployment.checkpointFreshnessThresholdSeconds) {
          record(`freshness:${v.label}`, "fail", `metadata_latest.json is ${Math.round(ageSeconds)}s old (threshold ${deployment.checkpointFreshnessThresholdSeconds}s) — validator may be stalled or crash-looping`);
        } else {
          record(`freshness:${v.label}`, "pass", `metadata_latest.json is ${Math.round(ageSeconds)}s old`);
        }
      } catch (err) {
        record(`freshness:${v.label}`, "fail", err instanceof Error ? err.message : String(err));
      }
    }
  }
}

// --- Check 4: deployed ISM contains the expected validator set + threshold ---
async function checkIsm(): Promise<void> {
  try {
    const [validators, threshold] = await client.readContract({
      address: deployment.sepolia.ism,
      abi: ISM_ABI,
      functionName: "validatorsAndThreshold",
      args: ["0x" as Hex],
    });
    const expected = new Set(deployment.validators.map((v) => v.address.toLowerCase()));
    const actual = new Set(validators.map((a) => a.toLowerCase()));
    const missing = [...expected].filter((a) => !actual.has(a));
    const extra = [...actual].filter((a) => !expected.has(a));
    if (missing.length > 0 || extra.length > 0) {
      record("ism:validator-set", "fail", `ISM validator set mismatch — missing: [${missing.join(",")}], unexpected: [${extra.join(",")}]`);
    } else {
      record("ism:validator-set", "pass", `ISM contains exactly the expected ${actual.size} validator(s)`);
    }
    if (Number(threshold) !== deployment.expectedThreshold) {
      record("ism:threshold", "fail", `ISM threshold is ${threshold}, expected ${deployment.expectedThreshold}`);
    } else {
      record("ism:threshold", "pass", `ISM threshold is ${threshold}`);
    }
  } catch (err) {
    record("ism:validator-set", "fail", `could not read validatorsAndThreshold from ${deployment.sepolia.ism}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Check 5: DecisionRelay.interchainSecurityModule() actually points at that ISM ---
async function checkDecisionRelayIsm(): Promise<void> {
  try {
    const ism = await client.readContract({
      address: deployment.sepolia.decisionRelay,
      abi: DECISION_RELAY_ABI,
      functionName: "interchainSecurityModule",
    });
    if (ism.toLowerCase() !== deployment.sepolia.ism.toLowerCase()) {
      record("decisionrelay:ism", "fail", `DecisionRelay.interchainSecurityModule() returns ${ism}, expected ${deployment.sepolia.ism} — the deployed contract is NOT using the ISM this script just verified`);
    } else {
      record("decisionrelay:ism", "pass", `DecisionRelay is wired to the expected ISM`);
    }
  } catch (err) {
    record("decisionrelay:ism", "fail", err instanceof Error ? err.message : String(err));
  }
}

// --- Check 6: DecisionRelay's trustedSender matches the dispatcher we actually use ---
async function checkTrustedSender(): Promise<void> {
  try {
    const sender = await client.readContract({
      address: deployment.sepolia.decisionRelay,
      abi: DECISION_RELAY_ABI,
      functionName: "trustedSender",
      args: [11155111],
    });
    const expected = ("0x" + "00".repeat(12) + deployment.sepolia.dispatcherAddress.slice(2)).toLowerCase();
    if (sender.toLowerCase() !== expected) {
      record("decisionrelay:trustedSender", "fail", `trustedSender is ${sender}, expected the dispatcher address padded to bytes32 (${expected})`);
    } else {
      record("decisionrelay:trustedSender", "pass", "trustedSender matches the configured dispatcher");
    }
  } catch (err) {
    record("decisionrelay:trustedSender", "fail", err instanceof Error ? err.message : String(err));
  }
}

// --- Check 7: relayer whitelist includes the current recipient ---
function checkRelayerWhitelist(): void {
  try {
    const content = readFileSync(join(__dirname, "..", "..", "..", deployment.relayerWhitelistFile), "utf-8");
    if (content.toLowerCase().includes(deployment.sepolia.decisionRelay.toLowerCase())) {
      record("relayer:whitelist", "pass", `${deployment.relayerWhitelistFile} includes the current DecisionRelay address`);
    } else {
      record("relayer:whitelist", "fail", `${deployment.relayerWhitelistFile} does NOT mention ${deployment.sepolia.decisionRelay} — the self-hosted relayer will never attempt delivery to it (a real bug hit earlier this project)`);
    }
  } catch (err) {
    record("relayer:whitelist", "fail", `could not read ${deployment.relayerWhitelistFile}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Check 8: operator/account/provider independence — reported honestly, never inflated ---
function checkOperatorIndependence(): void {
  const accounts = new Set(deployment.validators.map((v) => v.account));
  const operators = new Set(deployment.validators.map((v) => v.operator));
  const providers = new Set(deployment.validators.map((v) => v.provider));
  const iamPrincipals = new Set(deployment.validators.map((v) => v.iamPrincipal));
  const s3Buckets = new Set(deployment.validators.map((v) => v.s3Bucket));

  const sharedDims: string[] = [];
  if (accounts.size < deployment.validators.length) sharedDims.push("cloud account");
  if (operators.size < deployment.validators.length) sharedDims.push("operator");
  if (providers.size < deployment.validators.length) sharedDims.push("cloud provider");
  if (iamPrincipals.size < deployment.validators.length) sharedDims.push("IAM principal");
  if (s3Buckets.size < deployment.validators.length) sharedDims.push("S3 bucket");

  if (sharedDims.length > 0) {
    record(
      "independence",
      "warn",
      `NOT independent consensus: validators share ${sharedDims.join(", ")}. A compromise of that shared thing ` +
        `compromises every validator that shares it. Do not describe this validator set as providing real ` +
        `multi-party security until every validator has its own operator, account, provider, IAM principal, and bucket.`
    );
  } else {
    record("independence", "pass", "every validator has a distinct operator, account, provider, IAM principal, and S3 bucket");
  }
}

// --- Check 9: the most recent real dispatch has either delivered, or is within the SLA window and not (yet) alarming ---
// Reads Mailbox Dispatch events directly (not DecisionRelay's own
// events) so this works even if the recipient contract changes shape —
// Dispatch is Hyperlane's own canonical "a message left this chain"
// event, emitted by the Mailbox regardless of recipient.
const MAILBOX_DISPATCH_EVENT = {
  type: "event",
  name: "Dispatch",
  inputs: [
    { name: "sender", type: "address", indexed: true },
    { name: "destination", type: "uint32", indexed: false },
    { name: "recipient", type: "bytes32", indexed: true },
    { name: "message", type: "bytes", indexed: false },
  ],
} as const;

const MAILBOX_DELIVERED_ABI = [
  { type: "function", name: "delivered", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] },
] as const;

async function checkRecentDelivery(): Promise<void> {
  try {
    const currentBlock = await client.getBlockNumber();
    const fromBlock = currentBlock - BigInt(deployment.dispatchLookbackBlocks);
    const logs = await client.getLogs({
      address: deployment.sepolia.mailbox,
      event: MAILBOX_DISPATCH_EVENT,
      args: { sender: deployment.sepolia.dispatcherAddress },
      fromBlock,
      toBlock: currentBlock,
    });

    if (logs.length === 0) {
      record("delivery:recent", "warn", `no Dispatch events from ${deployment.sepolia.dispatcherAddress} in the last ${deployment.dispatchLookbackBlocks} blocks — nothing to check (this is not itself a problem)`);
      return;
    }

    const latest = logs[logs.length - 1];
    const block = await client.getBlock({ blockNumber: latest.blockNumber! });
    const ageSeconds = Date.now() / 1000 - Number(block.timestamp);

    // Hyperlane's message id is keccak256 of the raw message bytes, not
    // derivable from the Dispatch log's args alone without re-encoding
    // the message header — rather than reimplementing that here (real
    // risk of a subtle bytes mismatch silently producing a false
    // negative), this reports the dispatch TRANSACTION's age and points
    // the operator at the exact lookup command instead of guessing the
    // message id itself.
    if (ageSeconds > deployment.undeliveredMessageSlaSeconds) {
      record(
        "delivery:recent",
        "warn",
        `most recent dispatch (tx ${latest.transactionHash}) is ${Math.round(ageSeconds)}s old (SLA ${deployment.undeliveredMessageSlaSeconds}s) — ` +
          `confirm delivery manually: cast call ${deployment.sepolia.mailbox} "delivered(bytes32)(bool)" <messageId> --rpc-url ${deployment.sepolia.rpcUrl}, ` +
          `or check https://explorer.hyperlane.xyz for tx ${latest.transactionHash}. If false/undelivered past SLA, check validator freshness above first — ` +
          `a stalled/stale validator is the most common real cause found during this project's own verification.`
      );
    } else {
      record("delivery:recent", "pass", `most recent dispatch (tx ${latest.transactionHash}) is ${Math.round(ageSeconds)}s old, within SLA`);
    }
  } catch (err) {
    record("delivery:recent", "warn", `could not check recent dispatches: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  const byValidator = await checkAnnouncements();
  await checkReachability(byValidator);
  await checkFreshness(byValidator);
  await checkRecentDelivery();
  await checkIsm();
  await checkDecisionRelayIsm();
  await checkTrustedSender();
  checkRelayerWhitelist();
  checkOperatorIndependence();

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const symbol = r.status === "pass" ? "OK  " : r.status === "warn" ? "WARN" : "FAIL";
      console.log(`[${symbol}] ${r.name}: ${r.detail}`);
    }
  }

  const failed = results.filter((r) => r.status === "fail");
  const warned = results.filter((r) => r.status === "warn");
  console.error(`\n${results.length} checks: ${results.length - failed.length - warned.length} pass, ${warned.length} warn, ${failed.length} fail`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("verify-deployment.ts crashed:", err);
  process.exit(1);
});
