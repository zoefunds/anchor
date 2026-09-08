import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withDbRetry } from "@/lib/db-retry";

// Regression coverage for the 2026-09-07 decision-loss incident (see
// adjudication-service.ts's own history comment): a computed GenLayer
// decision could be silently lost forever if the DB write immediately
// following computation failed transiently (a real ~20s Postgres
// connection-pool exhaustion window was observed live) AND the catch
// block's own recovery write (marking the case UNDETERMINED) also hit
// the same transient failure. Before this fix neither write retried at
// all — a single transient error was fatal and the decision was gone
// with no record it was ever computed.

function transientPrismaError(code = "P1001") {
  const err = new Error(`transient: ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

describe("withDbRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a transient Prisma error and eventually returns the successful result — the decision write is not lost", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(transientPrismaError("P1001"))
      .mockRejectedValueOnce(transientPrismaError("P1017"))
      .mockResolvedValueOnce({ id: "decision-1" });

    const resultPromise = withDbRetry(fn, 5);
    // Let the two backoff timers (1s, 2s) elapse without a real 3s wall-clock wait.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(result).toEqual({ id: "decision-1" });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-transient error — fails fast rather than masking a real bug as a retry", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("not a Prisma error at all"));
    await expect(withDbRetry(fn, 5)).rejects.toThrow("not a Prisma error at all");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up and throws after exhausting attempts on a persistent transient failure", async () => {
    const fn = vi.fn().mockRejectedValue(transientPrismaError("P1002"));
    const resultPromise = withDbRetry(fn, 3).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    const err = await resultPromise;
    expect(err).toBeInstanceOf(Error);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
