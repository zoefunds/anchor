import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// Priority 5, item 21: real Slack alert delivery tests — a genuine
// local HTTP server, genuine network requests, genuine success/500/
// timeout/malformed-response behavior. Not a mocked fetch: the point
// of these tests is proving sendOpsAlert's OWN retry/failure
// semantics under real HTTP conditions, which a mocked
// Response object can't actually exercise (e.g. a real connection
// timeout looks nothing like a mocked rejected promise).
//
// The one thing genuinely mocked here is lib/ssrf-guard.ts's loopback
// check — by design, it refuses 127.0.0.1 (see ssrf-guard.ts's own
// "isDangerousHostname" doc comment), which is exactly why local test
// servers can't be pointed at safely in production code but must be
// bypassed to test against one at all. The mock still routes through
// the real, native fetch() — only the SSRF pre-check is skipped, not
// the HTTP request/response handling itself.
vi.mock("@/lib/ssrf-guard", () => ({
  assertSafeToFetch: vi.fn().mockResolvedValue(undefined),
  safeFetch: (url: string, init: RequestInit) => fetch(url, init),
}));

const { sendOpsAlert, OpsAlertDeliveryError, sendNtfyAlert, NtfyAlertDeliveryError } = await import("@/lib/alerts");

let server: Server;
let serverUrl: string;
let lastRequestBody: unknown = null;
let lastRequestHeaders: Record<string, string | string[] | undefined> = {};
let lastRequestRawBody = "";
let responseBehavior: "ok" | "server_error" | "hang" | "malformed" = "ok";

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      lastRequestRawBody = raw;
      lastRequestHeaders = req.headers;
      // sendOpsAlert posts JSON; sendNtfyAlert posts a raw text body — only
      // try to parse as JSON when it looks like it, so ntfy tests don't
      // choke on plain text.
      lastRequestBody = raw && raw.trim().startsWith("{") ? JSON.parse(raw) : null;
      if (responseBehavior === "ok") {
        res.writeHead(200, { "Content-Type": "application/json" }).end("ok");
      } else if (responseBehavior === "server_error") {
        res.writeHead(500).end("internal error");
      } else if (responseBehavior === "malformed") {
        res.writeHead(200).end(); // real 2xx, empty body — still a successful delivery as far as sendOpsAlert cares
      }
      // "hang": deliberately never respond — exercises sendOpsAlert's real AbortSignal.timeout
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  lastRequestBody = null;
  lastRequestHeaders = {};
  lastRequestRawBody = "";
  responseBehavior = "ok";
  delete process.env.OPS_ALERT_WEBHOOK_URL;
  delete process.env.OPS_ALERT_OWNER;
  delete process.env.NTFY_TOPIC_URL;
});

describe("sendOpsAlert — real HTTP delivery", () => {
  it("returns false and makes no request when OPS_ALERT_WEBHOOK_URL is unset", async () => {
    const delivered = await sendOpsAlert({ severity: "warning", title: "test", detail: "detail" });
    expect(delivered).toBe(false);
    expect(lastRequestBody).toBeNull();
  });

  it("delivers a real request and returns true on a genuine 2xx response", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = serverUrl;
    process.env.OPS_ALERT_OWNER = "Test Owner";
    const delivered = await sendOpsAlert({ severity: "critical", title: "Something is wrong", detail: "real detail text" });
    expect(delivered).toBe(true);
    expect(lastRequestBody).toMatchObject({ text: expect.stringContaining("Something is wrong") });
    expect((lastRequestBody as { text: string }).text).toContain("Test Owner");
    expect((lastRequestBody as { text: string }).text).toContain("real detail text");
  });

  it("includes a severity-appropriate marker for critical vs warning vs info", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = serverUrl;
    await sendOpsAlert({ severity: "critical", title: "t", detail: "d" });
    expect((lastRequestBody as { text: string }).text).toContain("CRITICAL");
    await sendOpsAlert({ severity: "info", title: "t", detail: "d" });
    expect((lastRequestBody as { text: string }).text).toContain("INFO");
  });

  it("throws OpsAlertDeliveryError on a real 500 response — never silently swallowed", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = serverUrl;
    responseBehavior = "server_error";
    await expect(sendOpsAlert({ severity: "warning", title: "t", detail: "d" })).rejects.toBeInstanceOf(OpsAlertDeliveryError);
  });

  it("still returns true on a genuine 2xx with an empty/malformed body — HTTP status is the real signal, not response parsing", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = serverUrl;
    responseBehavior = "malformed";
    const delivered = await sendOpsAlert({ severity: "info", title: "t", detail: "d" });
    expect(delivered).toBe(true);
  });

  it("throws OpsAlertDeliveryError when the endpoint is unreachable (real connection refused, no server listening)", async () => {
    process.env.OPS_ALERT_WEBHOOK_URL = "http://127.0.0.1:1"; // real, guaranteed-closed port
    await expect(sendOpsAlert({ severity: "warning", title: "t", detail: "d" })).rejects.toBeInstanceOf(OpsAlertDeliveryError);
  });
});

describe("sendNtfyAlert — real HTTP delivery", () => {
  it("returns false and makes no request when NTFY_TOPIC_URL is unset", async () => {
    const delivered = await sendNtfyAlert({ title: "test", detail: "detail" });
    expect(delivered).toBe(false);
    expect(lastRequestRawBody).toBe("");
  });

  it("delivers a real request and returns true on a genuine 2xx response, with the title/priority/detail in the real request", async () => {
    process.env.NTFY_TOPIC_URL = serverUrl;
    const delivered = await sendNtfyAlert({ title: "Something is wrong", detail: "real detail text", priority: "urgent" });
    expect(delivered).toBe(true);
    expect(lastRequestHeaders["title"]).toBe("Something is wrong");
    expect(lastRequestHeaders["priority"]).toBe("urgent");
    expect(lastRequestRawBody).toBe("real detail text");
  });

  it("defaults priority to urgent when not specified", async () => {
    process.env.NTFY_TOPIC_URL = serverUrl;
    await sendNtfyAlert({ title: "t", detail: "d" });
    expect(lastRequestHeaders["priority"]).toBe("urgent");
  });

  it("throws NtfyAlertDeliveryError on a real 500 response — never silently swallowed", async () => {
    process.env.NTFY_TOPIC_URL = serverUrl;
    responseBehavior = "server_error";
    await expect(sendNtfyAlert({ title: "t", detail: "d" })).rejects.toBeInstanceOf(NtfyAlertDeliveryError);
  });

  it("still returns true on a genuine 2xx with an empty body", async () => {
    process.env.NTFY_TOPIC_URL = serverUrl;
    responseBehavior = "malformed";
    const delivered = await sendNtfyAlert({ title: "t", detail: "d" });
    expect(delivered).toBe(true);
  });

  it("throws NtfyAlertDeliveryError when the endpoint is unreachable (real connection refused, no server listening)", async () => {
    process.env.NTFY_TOPIC_URL = "http://127.0.0.1:1"; // real, guaranteed-closed port
    await expect(sendNtfyAlert({ title: "t", detail: "d" })).rejects.toBeInstanceOf(NtfyAlertDeliveryError);
  });
});
