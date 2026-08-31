import { isIP } from "net";
import { lookup } from "dns/promises";

// Webhook URLs are operator-supplied (POST /api/webhooks) and this app
// fetch()es them from a real request handler and from Fly workers on a
// real private network (6PN) that can reach other internal services
// (Postgres, the relayer) — an unvalidated webhook URL is a genuine SSRF
// vector, not a theoretical one. Two checks, both needed:
//   1. isDangerousHostname() — cheap, obvious-pattern rejection at
//      webhook registration time (POST /api/webhooks), so a blatantly
//      internal URL never even gets saved.
//   2. assertSafeToFetch() — resolves the hostname to its real IP right
//      before every dispatch and validates THAT, not just the hostname
//      string. Registration-time-only checking is vulnerable to DNS
//      rebinding: a hostname that resolved to a public IP when the
//      webhook was created can be repointed at 127.0.0.1 or a cloud
//      metadata endpoint by the time it's actually fetched, hours or
//      days later.

const DANGEROUS_HOSTNAME_SUFFIXES = [".internal", ".local", ".flycast", ".localhost"];
const DANGEROUS_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed — treat as unsafe
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local — includes cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT, used by some internal networks)
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true;
  if (normalized.startsWith("fe80:")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local (fc00::/7)
  if (normalized.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 — validate the embedded IPv4 address instead of
    // letting it slip through as "not a recognized IPv6 pattern".
    const mapped = normalized.split(":").pop();
    return mapped ? isPrivateOrReservedIPv4(mapped) : true;
  }
  return false;
}

/** Cheap, string-level rejection at registration time — obvious cases only, not a substitute for assertSafeToFetch(). */
export function isDangerousHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (DANGEROUS_HOSTNAMES.has(lower)) return true;
  if (DANGEROUS_HOSTNAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  const ipVersion = isIP(lower);
  if (ipVersion === 4) return isPrivateOrReservedIPv4(lower);
  if (ipVersion === 6) return isPrivateOrReservedIPv6(lower);
  return false;
}

/**
 * Resolves `url`'s hostname and throws if it resolves to a private,
 * loopback, link-local, or reserved address. Call this immediately
 * before every fetch of an operator-supplied URL — not just once at
 * registration — since DNS can change between the two.
 */
export async function assertSafeToFetch(url: string): Promise<void> {
  const parsed = new URL(url);
  if (isDangerousHostname(parsed.hostname)) {
    throw new Error(`refusing to fetch ${url}: hostname resolves to a private/internal address`);
  }
  // A literal IP in the URL has nothing to resolve — already covered by
  // isDangerousHostname above.
  if (isIP(parsed.hostname)) return;

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(parsed.hostname, { all: true });
  } catch (err) {
    throw new Error(`refusing to fetch ${url}: DNS lookup failed (${err instanceof Error ? err.message : err})`);
  }
  for (const { address, family } of addresses) {
    const unsafe = family === 6 ? isPrivateOrReservedIPv6(address) : isPrivateOrReservedIPv4(address);
    if (unsafe) {
      throw new Error(`refusing to fetch ${url}: resolves to private/internal address ${address}`);
    }
  }
}
