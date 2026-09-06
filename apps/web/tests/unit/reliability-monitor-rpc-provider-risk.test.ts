import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Regression test for docs/mainnet-readiness-runbook.md §3: the
// migration off an exhausted paid Alchemy key onto a free public RPC
// must stay a visible, tracked risk on the reliability dashboard, not
// silently disappear once it stops being top of mind. checkRpcProviderRisk
// isn't exported (internal to the sweep), so this inspects source text
// directly -- consistent with this repo's existing pattern for
// self-contained reliability-monitor checks (see
// reliability-monitor-checkpoint-currency.test.ts).

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleSource = readFileSync(join(__dirname, "..", "..", "src", "lib", "reliability-monitor.ts"), "utf-8");

describe("reliability-monitor rpc-provider-risk regression: must exist and be wired into the sweep", () => {
  it("defines checkRpcProviderRisk against a known-public-host list including publicnode.com", () => {
    expect(moduleSource).toContain("function checkRpcProviderRisk");
    expect(moduleSource).toContain("publicnode.com");
  });

  it("is actually called from runReliabilityObservation, not just defined", () => {
    const start = moduleSource.indexOf("export async function runReliabilityObservation");
    const body = moduleSource.slice(start);
    expect(body).toContain("checkRpcProviderRisk()");
  });

  it("reports warn (not pass) for a known public host, so computeState correctly downgrades to DEGRADED", () => {
    const start = moduleSource.indexOf("function checkRpcProviderRisk");
    const end = moduleSource.indexOf("\n}", moduleSource.indexOf("if (isKnownPublic)", start));
    const body = moduleSource.slice(start, end);
    expect(body).toContain('status: "warn"');
  });
});
