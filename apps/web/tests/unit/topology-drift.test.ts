import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { ACTIVE_SEPOLIA_TOPOLOGY, RETIRED_SEPOLIA_ADDRESSES } from "@/lib/deployment-registry";
import { HYPERLANE_DOMAIN } from "@anchor/hyperlane-relay";
import evmManifest from "../../deployment-manifest.json";
import validatorDeploymentJson from "../../../../chains/hyperlane-validator/deployment.json";

// Incident recovery, topology-freeze phase (2026-09-13): CI-enforced
// guard against exactly the class of bug this whole incident kept
// re-surfacing as — a consumer silently left pointed at a retired
// mailbox/DecisionRelay/Escrow while deployment-registry.ts (the single
// source of truth every active consumer is meant to import from) had
// already moved on. Deliberately fast, static, and offline: no live RPC
// call in this file at all — that's scripts/verify-active-topology.ts's
// job, run manually/on deploy, not something every CI run should
// depend on a live Sepolia RPC succeeding for.

describe("topology drift — deployment manifest vs. registry", () => {
  it("committed deployment-manifest.json's DecisionRelay address matches the registry's active DecisionRelay", () => {
    expect(evmManifest.decisionRelay.address.toLowerCase()).toBe(ACTIVE_SEPOLIA_TOPOLOGY.decisionRelay.toLowerCase());
  });

  it("committed deployment-manifest.json's ISM matches the registry's active ISM", () => {
    expect(evmManifest.decisionRelay.interchainSecurityModule.toLowerCase()).toBe(ACTIVE_SEPOLIA_TOPOLOGY.ism.toLowerCase());
  });

  it("committed deployment-manifest.json's attestorThreshold matches the registry", () => {
    expect(Number(evmManifest.decisionRelay.attestorThreshold)).toBe(ACTIVE_SEPOLIA_TOPOLOGY.attestorThreshold);
  });
});

describe("topology drift — standalone scripts' deployment.json vs. registry", () => {
  // chains/hyperlane-validator/deployment.json is hand-maintained (that
  // directory isn't an npm workspace and can't import the TS registry
  // directly) — this is the one place a human can silently forget to
  // update it after a redeploy, so CI checks it explicitly rather than
  // trusting the file's own "kept in sync by hand" comment.
  it("deployment.json's sepolia section matches the registry's active topology", () => {
    const sepoliaSection = validatorDeploymentJson.sepolia;
    expect(sepoliaSection.mailbox.toLowerCase()).toBe(ACTIVE_SEPOLIA_TOPOLOGY.mailbox.toLowerCase());
    expect(sepoliaSection.decisionRelay.toLowerCase()).toBe(ACTIVE_SEPOLIA_TOPOLOGY.decisionRelay.toLowerCase());
    expect(sepoliaSection.escrow.toLowerCase()).toBe(ACTIVE_SEPOLIA_TOPOLOGY.escrow.toLowerCase());
    expect(sepoliaSection.ism.toLowerCase()).toBe(ACTIVE_SEPOLIA_TOPOLOGY.ism.toLowerCase());
  });
});

describe("topology drift — source/destination domain agreement", () => {
  it("registry's sourceDomain/destinationDomain match the dispatch package's HYPERLANE_DOMAIN.sepolia", () => {
    expect(ACTIVE_SEPOLIA_TOPOLOGY.sourceDomain).toBe(HYPERLANE_DOMAIN.sepolia);
    expect(ACTIVE_SEPOLIA_TOPOLOGY.destinationDomain).toBe(HYPERLANE_DOMAIN.sepolia);
  });
});

describe("topology drift — no active service references a retired address", () => {
  // Scans this repo's own source for retired addresses appearing OUTSIDE
  // the small set of files that are expected to mention them (the
  // registry's own historical record, docs, generated build artifacts,
  // and test fixtures that deliberately exercise the retired-address
  // case). A retired address found anywhere else is exactly the "old
  // system still selectable by runtime code" bug this incident kept
  // re-discovering by hand.
  const RETIRED_ADDRESSES = Object.values(RETIRED_SEPOLIA_ADDRESSES).map((a) => a.toLowerCase());

  const ALLOWED_FILE_SUBSTRINGS = [
    "deployment-registry.ts", // the historical record itself
    "/docs/", // documentation may legitimately discuss retired history
    "/broadcast/", // forge deployment broadcast logs — historical, not runtime
    "/cache/", // forge build cache
    "reconciliation.ts", // OLD_STUCK_DEPOSIT recovery record — deliberately references the retired escrow/relay to track its refund eligibility
    ".test.ts", // test fixtures may legitimately reference a retired address (e.g. testing that it's correctly rejected, or an unrelated fake address that happens to collide with nothing)
    "entrypoint.sh", // relayer whitelist keeps retired entries commented/labelled per its own established "retired, not deleted" convention — reviewed by hand above, not enforced here
    "monitor.sh", // incident-response monitoring script, explicitly checks the retired canonical mailbox's own delivered() state as part of diagnosing the ORIGINAL incident
    "apps/web/src/lib/hyperlane.ts", // doc-comment only, explaining why the retired DecisionRelay is unfixable — verified 2026-09-13, no runtime reference
    "packages/hyperlane-relay/index.ts", // doc-comment only, citing the retired canonical mailbox address for context — verified 2026-09-13, no runtime reference
  ];

  const SEARCH_ROOTS = [
    path.resolve(__dirname, "../../src"),
    path.resolve(__dirname, "../../scripts"),
    path.resolve(__dirname, "../../../../packages/hyperlane-relay"),
  ];

  function walk(dir: string, files: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (entry === "node_modules" || entry === ".next") continue;
        walk(full, files);
      } else if (/\.(ts|tsx|json)$/.test(entry)) {
        files.push(full);
      }
    }
    return files;
  }

  it("no non-historical source file under src/, scripts/, or the dispatch package contains a retired Sepolia address", () => {
    const offenders: string[] = [];
    for (const root of SEARCH_ROOTS) {
      let files: string[];
      try {
        files = walk(root);
      } catch {
        continue; // root doesn't exist in this checkout shape — skip rather than fail
      }
      for (const file of files) {
        if (ALLOWED_FILE_SUBSTRINGS.some((s) => file.includes(s))) continue;
        const content = readFileSync(file, "utf8").toLowerCase();
        for (const addr of RETIRED_ADDRESSES) {
          if (content.includes(addr)) {
            offenders.push(`${file} references retired address ${addr}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
