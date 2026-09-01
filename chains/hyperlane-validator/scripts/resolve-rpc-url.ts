// Resolves which Sepolia RPC endpoint a Hyperlane component (validator
// agent, relayer, or this project's own verify-deployment.ts) should
// use — centralized here so the "fail closed in production, allow the
// public fallback only under an explicit local-dev opt-in" rule lives
// in exactly one place instead of being reimplemented per script.
//
// The actual dedicated endpoint value is NEVER read, logged, or
// returned by anything in this file beyond the resolved URL string
// itself, which callers must treat the same way (never log the full
// URL — see hostOf() below for what's safe to print).

const PUBLIC_FALLBACK_URL = "https://ethereum-sepolia.publicnode.com";

export class MissingRpcUrlError extends Error {
  constructor() {
    super(
      "HYPERLANE_SEPOLIA_RPC_URL is not set. A dedicated RPC endpoint is required " +
        "in production — the shared public endpoint has previously caused real rate-limiting " +
        "that degraded validator checkpoint indexing (see docs/production-readiness-hardening-pass.md). " +
        "To use the public endpoint anyway (local development ONLY), set ALLOW_PUBLIC_RPC_FALLBACK=true."
    );
    this.name = "MissingRpcUrlError";
  }
}

export interface ResolvedRpcUrl {
  url: string;
  /** true if this is the shared public fallback, not a dedicated endpoint */
  isPublicFallback: boolean;
}

/**
 * Resolves the Sepolia RPC URL to use, per this project's fail-closed
 * policy:
 * - HYPERLANE_SEPOLIA_RPC_URL set -> use it (a dedicated endpoint).
 * - HYPERLANE_SEPOLIA_RPC_URL unset AND ALLOW_PUBLIC_RPC_FALLBACK=true
 *   -> use the shared public endpoint (local development only).
 * - HYPERLANE_SEPOLIA_RPC_URL unset AND no explicit fallback opt-in
 *   -> throws MissingRpcUrlError. Callers in a production entrypoint
 *   must let this propagate and exit non-zero, not swallow it.
 */
export function resolveSepoliaRpcUrl(env: NodeJS.ProcessEnv = process.env): ResolvedRpcUrl {
  const configured = env.HYPERLANE_SEPOLIA_RPC_URL;
  if (configured) {
    return { url: configured, isPublicFallback: false };
  }
  if (env.ALLOW_PUBLIC_RPC_FALLBACK === "true") {
    return { url: PUBLIC_FALLBACK_URL, isPublicFallback: true };
  }
  throw new MissingRpcUrlError();
}

/** The only thing safe to log about a resolved RPC URL — never the full URL (query params can carry an API key), never any credential. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<unparseable>";
  }
}
