import { describe, it, expect } from "vitest";
import { computeWindowState } from "@/lib/reliability-window";

// TRACK 1, item 1 — tests the pass/fail and window-extension/reset rule
// written in docs/reliability-observation-window.md, as implemented by
// computeWindowState. Pure function, no DB needed.
//
// Every test builds a DENSE sequence of 15-minute ticks (the real
// scheduled cadence) covering the whole span under test, ending at
// "now" — a sparse sequence with a multi-day gap to "now" would itself
// be a genuine missed-observation reset under the written rule, which
// is exactly what the dedicated gap tests below check for on purpose.

const DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 15 * 60 * 1000;

function tick(t: Date, status: "PASS" | "FAIL", failReasons: string[] = []) {
  return { capturedAt: t, status, failReasons };
}

/** Dense 15-minute ticks from `start` up to (and including) "now", all PASS, with optional overrides at specific offsets (ms from start). */
function denseSeries(start: Date, overrides: Array<{ atMs: number; status: "PASS" | "FAIL"; failReasons?: string[] }> = []) {
  const now = Date.now();
  const rows = [];
  for (let t = start.getTime(); t <= now; t += TICK_MS) {
    const override = overrides.find((o) => Math.abs(start.getTime() + o.atMs - t) < TICK_MS / 2);
    rows.push(override ? tick(new Date(t), override.status, override.failReasons ?? []) : tick(new Date(t), "PASS"));
  }
  return rows;
}

describe("computeWindowState", () => {
  it("reports NOT_STARTED with zero observations", () => {
    const state = computeWindowState([]);
    expect(state.status).toBe("NOT_STARTED");
    expect(state.dayOfWindow).toBe(0);
  });

  it("stays PASS through an unbroken run of healthy 15-minute ticks", () => {
    const start = new Date(Date.now() - 5 * DAY_MS);
    const rows = denseSeries(start);
    const state = computeWindowState(rows);
    expect(state.status).toBe("PASS");
    expect(state.failTicks.length).toBe(0);
    expect(state.dayOfWindow).toBeGreaterThanOrEqual(5);
  });

  it("a non-quorum FAIL (e.g. canary_failed) extends the window by 1 day, without resetting windowStartedAt", () => {
    const start = new Date(Date.now() - 3 * DAY_MS);
    const rows = denseSeries(start, [{ atMs: DAY_MS, status: "FAIL", failReasons: ["canary_failed"] }]);
    const state = computeWindowState(rows);
    expect(state.windowStartedAt).toBe(start.toISOString());
    expect(state.status).toBe("EXTENDED");
    expect(state.failTicks).toHaveLength(1);
    expect(state.failTicks[0].resetsWindow).toBe(false);
    expect(state.failTicks[0].reasons).toContain("canary_failed");
  });

  it("a signer_quorum_loss FAIL resets the window to zero starting from that tick", () => {
    const start = new Date(Date.now() - 10 * DAY_MS);
    const quorumLossOffset = 2 * DAY_MS;
    const rows = denseSeries(start, [{ atMs: quorumLossOffset, status: "FAIL", failReasons: ["signer_quorum_loss"] }]);
    const state = computeWindowState(rows);
    const expectedResetAt = new Date(start.getTime() + quorumLossOffset).toISOString();
    expect(state.windowStartedAt).toBe(expectedResetAt);
    const quorumFailTick = state.failTicks.find((f) => f.reasons.includes("signer_quorum_loss"));
    expect(quorumFailTick?.resetsWindow).toBe(true);
    expect(state.dayOfWindow).toBeLessThanOrEqual(9);
  });

  it("a missed-observation gap under 4 hours extends (does not reset) the window", () => {
    const start = new Date(Date.now() - 5 * DAY_MS);
    const rows = denseSeries(start).filter((r) => {
      // Drop ticks in a 1h5m window partway through, simulating a short outage of the scheduler itself.
      const gapStart = start.getTime() + 2 * DAY_MS;
      const gapEnd = gapStart + 65 * 60 * 1000;
      return !(r.capturedAt.getTime() > gapStart && r.capturedAt.getTime() < gapEnd);
    });
    const state = computeWindowState(rows);
    expect(state.windowStartedAt).toBe(start.toISOString());
    const missed = state.failTicks.filter((f) => f.reasons.includes("missed_observation"));
    expect(missed).toHaveLength(1);
    expect(missed[0].resetsWindow).toBe(false);
    expect(missed[0].synthetic).toBe(true);
  });

  it("a missed-observation gap over 4 hours resets the window (quorum loss could have gone unrecorded)", () => {
    const start = new Date(Date.now() - 10 * DAY_MS);
    const rows = denseSeries(start).filter((r) => {
      const gapStart = start.getTime() + 2 * DAY_MS;
      const gapEnd = gapStart + 6 * 60 * 60 * 1000; // 6h gap
      return !(r.capturedAt.getTime() > gapStart && r.capturedAt.getTime() < gapEnd);
    });
    const state = computeWindowState(rows);
    expect(state.windowStartedAt).not.toBe(start.toISOString());
    const missed = state.failTicks.filter((f) => f.reasons.includes("missed_observation"));
    expect(missed.some((f) => f.resetsWindow)).toBe(true);
  });

  it("reaches PASS (not EXTENDED) once a full 30 days of unbroken dense ticks have elapsed", () => {
    const start = new Date(Date.now() - 31 * DAY_MS);
    const rows = denseSeries(start);
    const state = computeWindowState(rows, 30);
    expect(state.status).toBe("PASS");
    expect(state.dayOfWindow).toBe(30);
  });
});
