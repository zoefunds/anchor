import { describe, it, expect, vi, beforeEach } from "vitest";

// Item: "watch the watcher" — proves checkReliabilityObserverHeartbeat's
// three real branches: (a) a stale/missing observation fires a critical
// sendOpsAlert, (b) a recent observation fires none, (c) a DB query
// failure during the check itself ALSO fires a critical alert (a
// distinct message) instead of being silently swallowed. Prisma is
// mocked directly (same convention as tests/unit/no-escrow-fallback.test.ts
// and settlement-target-binding.test.ts), sendOpsAlert mocked the same
// way tests/integration/reconciliation.test.ts mocks lib/alerts.

const mockFindFirst = vi.fn();
const mockSendOpsAlert = vi.fn().mockResolvedValue(true);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    reliabilityWindowObservation: { findFirst: mockFindFirst },
  },
}));

vi.mock("@/lib/alerts", () => ({
  sendOpsAlert: mockSendOpsAlert,
}));

const { checkReliabilityObserverHeartbeat, STALE_HEARTBEAT_MS } = await import("@/lib/reliability-observer-watchdog");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkReliabilityObserverHeartbeat", () => {
  it("fires a critical sendOpsAlert when the latest observation is older than the staleness threshold", async () => {
    const staleAt = new Date(Date.now() - (STALE_HEARTBEAT_MS + 5 * 60 * 1000));
    mockFindFirst.mockResolvedValue({ capturedAt: staleAt });

    const status = await checkReliabilityObserverHeartbeat();

    expect(status.stale).toBe(true);
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(mockSendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "critical", title: expect.stringContaining("heartbeat is stale") })
    );
  });

  it("fires a critical sendOpsAlert when there are no observation rows at all", async () => {
    mockFindFirst.mockResolvedValue(null);

    const status = await checkReliabilityObserverHeartbeat();

    expect(status.stale).toBe(true);
    expect(status.lastObservationAt).toBeNull();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(mockSendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "critical", title: expect.stringContaining("No ReliabilityWindowObservation rows") })
    );
  });

  it("does NOT alert when the latest observation is recent (within the staleness threshold)", async () => {
    const freshAt = new Date(Date.now() - 5 * 60 * 1000);
    mockFindFirst.mockResolvedValue({ capturedAt: freshAt });

    const status = await checkReliabilityObserverHeartbeat();

    expect(status.stale).toBe(false);
    expect(status.lastObservationAt).toBe(freshAt.toISOString());
    expect(mockSendOpsAlert).not.toHaveBeenCalled();
  });

  it("fires a distinct critical sendOpsAlert when the DB query itself fails, instead of swallowing the error", async () => {
    mockFindFirst.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const status = await checkReliabilityObserverHeartbeat();

    expect(status.stale).toBe(true);
    expect(status.error).toContain("connection terminated unexpectedly");
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(mockSendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "critical", title: expect.stringContaining("could not query the database") })
    );
  });

  it("never throws even if sendOpsAlert delivery itself fails", async () => {
    mockFindFirst.mockResolvedValue(null);
    mockSendOpsAlert.mockRejectedValueOnce(new Error("webhook unreachable"));

    await expect(checkReliabilityObserverHeartbeat()).resolves.toBeDefined();
  });
});
