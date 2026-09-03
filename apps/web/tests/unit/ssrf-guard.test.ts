import { describe, it, expect } from "vitest";
import { isDangerousHostname, assertSafeToFetch } from "@/lib/ssrf-guard";

describe("isDangerousHostname", () => {
  it("rejects loopback, private, and link-local IPv4 addresses", () => {
    expect(isDangerousHostname("127.0.0.1")).toBe(true);
    expect(isDangerousHostname("10.0.0.5")).toBe(true);
    expect(isDangerousHostname("172.16.0.1")).toBe(true);
    expect(isDangerousHostname("192.168.1.1")).toBe(true);
    expect(isDangerousHostname("169.254.169.254")).toBe(true); // cloud metadata
  });

  it("rejects known-dangerous hostnames and suffixes", () => {
    expect(isDangerousHostname("localhost")).toBe(true);
    expect(isDangerousHostname("metadata.google.internal")).toBe(true);
    expect(isDangerousHostname("foo.internal")).toBe(true);
    expect(isDangerousHostname("foo.flycast")).toBe(true);
  });

  it("allows a real public IPv4 address", () => {
    expect(isDangerousHostname("8.8.8.8")).toBe(false);
  });

  it("allows an ordinary public hostname (no DNS resolution here — see assertSafeToFetch)", () => {
    expect(isDangerousHostname("example.com")).toBe(false);
  });
});

describe("assertSafeToFetch", () => {
  it("throws for a URL whose hostname is a literal private IP", async () => {
    await expect(assertSafeToFetch("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertSafeToFetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
  });

  it("does not throw for a real, publicly-routable hostname", async () => {
    // example.com resolves to a public IP with no private ranges —
    // a real DNS lookup, not mocked, matching this project's own
    // integration-test posture for this function.
    await expect(assertSafeToFetch("https://example.com/")).resolves.toBeUndefined();
  });
});
