import { isIP } from "net";
import { lookup } from "dns/promises";
import { Agent, fetch as undiciFetch } from "undici";

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
 * Resolves `url`'s hostname, throws if any resolved address is private/
 * loopback/link-local/reserved, and returns the validated addresses.
 * Real audit finding fixed here: this function used to only validate and
 * return — the caller (safeFetch, below) then called plain `fetch()`,
 * which performs its OWN independent DNS resolution internally. Between
 * this validation and that second resolution, an attacker who controls
 * the DNS record (a classic rebinding attack) can repoint the hostname
 * at 127.0.0.1 or a cloud metadata endpoint; the two resolutions have no
 * guarantee of returning the same address. Validating here is
 * necessary but was never sufficient — see connectToValidatedAddress
 * below for the actual fix (pin the TCP connection to the address that
 * was just validated, not the hostname).
 */
async function resolveAndValidate(url: string): Promise<{ address: string; family: number }[] | null> {
  const parsed = new URL(url);
  if (isDangerousHostname(parsed.hostname)) {
    throw new Error(`refusing to fetch ${url}: hostname resolves to a private/internal address`);
  }
  // A literal IP in the URL has nothing to resolve — already covered by
  // isDangerousHostname above, and there is no separate resolution step
  // for safeFetch to race against.
  if (isIP(parsed.hostname)) return null;

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(parsed.hostname, { all: true });
  } catch (err) {
    throw new Error(`refusing to fetch ${url}: DNS lookup failed (${err instanceof Error ? err.message : err})`);
  }
  if (addresses.length === 0) {
    throw new Error(`refusing to fetch ${url}: DNS lookup returned no addresses`);
  }
  for (const { address, family } of addresses) {
    const unsafe = family === 6 ? isPrivateOrReservedIPv6(address) : isPrivateOrReservedIPv4(address);
    if (unsafe) {
      throw new Error(`refusing to fetch ${url}: resolves to private/internal address ${address}`);
    }
  }
  return addresses;
}

/**
 * Resolves `url`'s hostname and throws if it resolves to a private,
 * loopback, link-local, or reserved address. Kept as a standalone export
 * for callers that only need the validation, not a connection — prefer
 * safeFetch below for anything that actually fetches the URL, since only
 * safeFetch closes the DNS-rebinding race this function alone cannot.
 */
export async function assertSafeToFetch(url: string): Promise<void> {
  await resolveAndValidate(url);
}

/**
 * Builds an undici Agent whose connector ALWAYS connects to
 * `pinnedAddress` for this one request, regardless of what a fresh DNS
 * lookup for the URL's hostname would return — TLS SNI and the HTTP
 * Host header still come from the original URL (undici derives both
 * from the request URL, not from the connector's resolved address), so
 * this only removes the second, racy DNS resolution, not virtual-hosting
 * correctness. This is the actual fix for the DNS-rebinding TOCTOU gap:
 * the address that gets connected to is provably the same one that was
 * just validated, not a fresh, independently-resolved, possibly-attacker-
 * controlled answer.
 */
function pinnedDispatcher(pinnedAddress: string, family: number): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, [{ address: pinnedAddress, family: family as 4 | 6 }]);
      },
    },
  });
}

const MAX_SAFE_FETCH_REDIRECTS = 3;

/**
 * fetch() that validates every hop, not just the initial URL. Plain
 * `fetch(url)` with default redirect handling auto-follows a 3xx to
 * wherever it points — an operator-supplied URL that resolves safely at
 * request time can still redirect to 127.0.0.1 or a cloud metadata
 * endpoint, and assertSafeToFetch on the *original* URL alone would never
 * catch that. This fetches with redirect: "manual", validates the
 * Location header itself before following it, and repeats — capped at
 * MAX_SAFE_FETCH_REDIRECTS hops so a redirect loop can't hang a delivery
 * attempt forever.
 */
export async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_SAFE_FETCH_REDIRECTS; hop++) {
    const addresses = await resolveAndValidate(currentUrl);
    // A literal-IP URL has no separate resolution step to pin against —
    // plain fetch is fine there, since there's no hostname lookup for an
    // attacker to race. A hostname URL gets a dispatcher pinned to the
    // exact address just validated above, so undici's own internal DNS
    // resolution (which would otherwise re-resolve the hostname and
    // could legitimately get a different, unvalidated answer) never
    // runs for this request.
    const dispatcher = addresses ? pinnedDispatcher(addresses[0].address, addresses[0].family) : undefined;
    const res = await undiciFetch(currentUrl, { ...init, redirect: "manual", dispatcher } as Parameters<typeof undiciFetch>[1]);
    if (res.status < 300 || res.status >= 400 || !res.headers.has("location")) {
      return res as unknown as Response;
    }
    if (hop === MAX_SAFE_FETCH_REDIRECTS) {
      throw new Error(`refusing to follow more than ${MAX_SAFE_FETCH_REDIRECTS} redirects for ${url}`);
    }
    currentUrl = new URL(res.headers.get("location")!, currentUrl).toString();
  }
  throw new Error(`unreachable: redirect loop guard exhausted for ${url}`);
}
