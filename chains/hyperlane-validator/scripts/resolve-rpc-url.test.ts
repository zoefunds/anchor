import { describe, it, expect } from "vitest";
import { resolveSepoliaRpcUrl, hostOf, MissingRpcUrlError } from "./resolve-rpc-url.js";

describe("resolveSepoliaRpcUrl", () => {
  it("uses HYPERLANE_SEPOLIA_RPC_URL when set", () => {
    const resolved = resolveSepoliaRpcUrl({ HYPERLANE_SEPOLIA_RPC_URL: "https://dedicated.example.com/v2/secret-key" });
    expect(resolved.url).toBe("https://dedicated.example.com/v2/secret-key");
    expect(resolved.isPublicFallback).toBe(false);
  });

  it("rejects (fails closed) when unset and no fallback opt-in", () => {
    expect(() => resolveSepoliaRpcUrl({})).toThrow(MissingRpcUrlError);
  });

  it("rejects when unset even if ALLOW_PUBLIC_RPC_FALLBACK is present but not exactly \"true\"", () => {
    expect(() => resolveSepoliaRpcUrl({ ALLOW_PUBLIC_RPC_FALLBACK: "1" })).toThrow(MissingRpcUrlError);
    expect(() => resolveSepoliaRpcUrl({ ALLOW_PUBLIC_RPC_FALLBACK: "yes" })).toThrow(MissingRpcUrlError);
  });

  it("falls back to the public endpoint only with explicit opt-in", () => {
    const resolved = resolveSepoliaRpcUrl({ ALLOW_PUBLIC_RPC_FALLBACK: "true" });
    expect(resolved.isPublicFallback).toBe(true);
    expect(resolved.url).toBe("https://ethereum-sepolia.publicnode.com");
  });

  it("prefers the dedicated endpoint over the fallback flag when both are present", () => {
    const resolved = resolveSepoliaRpcUrl({
      HYPERLANE_SEPOLIA_RPC_URL: "https://dedicated.example.com/key",
      ALLOW_PUBLIC_RPC_FALLBACK: "true",
    });
    expect(resolved.isPublicFallback).toBe(false);
    expect(resolved.url).toBe("https://dedicated.example.com/key");
  });
});

describe("hostOf", () => {
  it("extracts only the host, never the path/query (where an API key could live)", () => {
    expect(hostOf("https://eth-sepolia.g.alchemy.com/v2/super-secret-key")).toBe("eth-sepolia.g.alchemy.com");
    expect(hostOf("https://ethereum-sepolia.publicnode.com")).toBe("ethereum-sepolia.publicnode.com");
  });

  it("returns a safe placeholder for an unparseable URL rather than throwing", () => {
    expect(hostOf("not a url")).toBe("<unparseable>");
  });
});
