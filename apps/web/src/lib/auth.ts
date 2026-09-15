import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import IORedis from "ioredis";
import { prisma } from "@/lib/prisma";
import { ApiScope } from "@/lib/api-scopes";
import { recordBillableEvent, BillableEventType } from "@/lib/billing-events";

function safeRequestPath(req: Request): string | null {
  try {
    return new URL(req.url).pathname;
  } catch {
    return null;
  }
}

const SESSION_COOKIE = "anchor_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let rateLimitRedis: IORedis | null = null;

function getRateLimitRedis(): IORedis {
  if (!rateLimitRedis) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("REDIS_URL is not set — see apps/web/.env.example");
    }
    rateLimitRedis = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return rateLimitRedis;
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set — see apps/web/.env.example");
  }
  return secret;
}

// --- Passwords (scrypt, no extra dependency) ---

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, 64);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// --- Sessions (opaque token, HMAC-signed cookie, hash stored in DB) ---
// The raw token is only ever in the signed cookie on the client; the DB
// stores its SHA-256 hash, so a DB read alone can't be used to forge a
// session. The cookie value itself is signed (HMAC) so it can't be
// tampered with client-side either.

function signToken(token: string): string {
  const sig = createHmac("sha256", getSessionSecret()).update(token).digest("hex");
  return `${token}.${sig}`;
}

function verifySignedCookie(cookieValue: string): string | null {
  const [token, sig] = cookieValue.split(".");
  if (!token || !sig) return null;
  const expected = createHmac("sha256", getSessionSecret()).update(token).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(sig);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return null;
  }
  return token;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(memberId: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: {
      memberId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, signToken(token), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (raw) {
    const token = verifySignedCookie(raw);
    if (token) {
      await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
  }
  cookieStore.delete(SESSION_COOKIE);
}

export interface AuthedMember {
  memberId: string;
  organizationId: string;
  email: string;
  role: "OWNER" | "MEMBER" | "VIEWER";
  emailVerified: boolean;
}

/** Resolves the current dashboard session, if any, from the request cookie. */
export async function getSessionMember(): Promise<AuthedMember | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const token = verifySignedCookie(raw);
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { member: true },
  });
  if (!session || session.expiresAt < new Date()) return null;

  return {
    memberId: session.member.id,
    organizationId: session.member.organizationId,
    email: session.member.email,
    role: session.member.role,
    emailVerified: Boolean(session.member.emailVerifiedAt),
  };
}

// --- API keys (for agent / programmatic callers) ---
// Format: "ak_live_<32 random hex chars>". The prefix (first 12 chars) is
// stored in the clear for display in the dashboard ("ak_live_3f9a2b...");
// the full key's hash is what's actually checked.

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `ak_live_${randomBytes(16).toString("hex")}`;
  return { raw, prefix: raw.slice(0, 16), hash: hashToken(raw) };
}

export interface AuthedApiKey {
  organizationId: string;
  apiKeyId: string;
  restrictedToCaseIds: string[];
  // Empty = full access (see ApiKey.scopes' schema comment for the
  // backward-compat rationale) — resolved to an actual allowlist check
  // only in requireScope().
  scopes: string[];
  rateLimitPerMinute: number;
}

// --- API key rate limiting ---
// Redis-backed fixed-window counter per key (see lib/genlayer-rate-limit.ts
// for the same pattern/tradeoffs) — this used to be a plain in-memory Map,
// which only ever worked because everything ran in one `next start`
// process. That assumption breaks entirely on Vercel: every request can
// land on a different serverless invocation with its own fresh memory, so
// an in-memory counter there wouldn't actually limit anything.
const RATE_LIMIT_WINDOW_MS = 60_000;
// Fallback only for a key whose org row somehow has no value (shouldn't
// happen — the column is NOT NULL with a default — but a literal
// constant beats a silent `undefined * x`).
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 120;

/**
 * Per-org rate-limit tier: Organization.apiRateLimitPerMinute
 * (lib/auth.ts callers pass it through from getApiKeyAuth, which reads
 * it once per request via the ApiKey->Organization relation) replaces
 * what used to be a single hardcoded 120/min for every org on the
 * platform. `maxRequests` defaults to the old flat value so a caller
 * that doesn't know about tiers yet behaves exactly as before.
 */
export async function checkApiKeyRateLimit(
  apiKeyId: string,
  maxRequests: number = DEFAULT_RATE_LIMIT_MAX_REQUESTS
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const redis = getRateLimitRedis();
  const bucket = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
  const key = `apikey_rl:${apiKeyId}:${bucket}`;

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) + 5);
  }

  if (count > maxRequests) {
    const windowEnd = (bucket + 1) * RATE_LIMIT_WINDOW_MS;
    return { allowed: false, retryAfterSeconds: Math.ceil((windowEnd - Date.now()) / 1000) };
  }
  return { allowed: true };
}

/**
 * Resolves an `Authorization: Bearer <key>` header to its organization.
 * Real gap fixed here (external audit finding): a key with an
 * `expiresAt` in the past now resolves as invalid, same as a revoked
 * one — expiry existing in the schema was never enough on its own; it
 * had to actually be checked here to mean anything.
 */
export async function getApiKeyAuth(authHeader: string | null): Promise<AuthedApiKey | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const raw = authHeader.slice("Bearer ".length).trim();
  if (!raw) return null;

  const key = await prisma.apiKey.findUnique({
    where: { keyHash: hashToken(raw) },
    include: { organization: { select: { apiRateLimitPerMinute: true } } },
  });
  if (!key || key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt < new Date()) return null;

  // Fire-and-forget last-used update — not on the critical path.
  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });

  return {
    organizationId: key.organizationId,
    apiKeyId: key.id,
    restrictedToCaseIds: key.restrictedToCaseIds,
    scopes: key.scopes,
    rateLimitPerMinute: key.organization.apiRateLimitPerMinute,
  };
}

export type OrgAuthResult =
  | {
      organizationId: string;
      memberId?: string;
      apiKeyId?: string;
      role?: "OWNER" | "MEMBER" | "VIEWER";
      // Empty = unrestricted (org-wide), matching the original API-key
      // behavior. Only ever set for API-key callers — a session member's
      // case scope is governed by CaseAccess instead (see case-access.ts).
      restrictedToCaseIds?: string[];
      // Only ever set for API-key callers — undefined for a session
      // member means "not scope-gated at all" (see requireScope), not
      // "no access."
      scopes?: string[];
    }
  | { error: "unauthorized" }
  | { error: "rate_limited"; retryAfterSeconds: number };

/**
 * Resolves the calling organization for an API request from either an API
 * key (Authorization header — the agent/programmatic path) or a dashboard
 * session cookie (the human path). Both are first-class; neither is a
 * fallback for the other.
 *
 * API-key callers are additionally subject to a per-key rate limit —
 * session-cookie callers (a human clicking around the dashboard) are not,
 * since that path isn't the one agents hammer programmatically.
 */
export async function resolveOrgFromRequest(req: Request): Promise<OrgAuthResult> {
  const apiKeyAuth = await getApiKeyAuth(req.headers.get("authorization"));
  if (apiKeyAuth) {
    const rateLimit = await checkApiKeyRateLimit(apiKeyAuth.apiKeyId, apiKeyAuth.rateLimitPerMinute);
    if (!rateLimit.allowed) {
      return { error: "rate_limited", retryAfterSeconds: rateLimit.retryAfterSeconds! };
    }
    // Fire-and-forget, not awaited: metering must never add latency (or
    // a failure path) to every single API-key request. See
    // billing-events.ts's own note on why this stays independent of
    // computeStubInvoice.
    void recordBillableEvent({
      organizationId: apiKeyAuth.organizationId,
      eventType: BillableEventType.API_CALL,
      subjectId: apiKeyAuth.apiKeyId,
      metadata: { path: safeRequestPath(req), method: (req as { method?: string }).method ?? null },
    });
    return {
      organizationId: apiKeyAuth.organizationId,
      apiKeyId: apiKeyAuth.apiKeyId,
      restrictedToCaseIds: apiKeyAuth.restrictedToCaseIds,
      scopes: apiKeyAuth.scopes,
    };
  }

  const member = await getSessionMember();
  if (member) {
    return { organizationId: member.organizationId, memberId: member.memberId, role: member.role };
  }

  return { error: "unauthorized" };
}

/** Owner-only actions (invite/remove members, manage webhooks, view audit log) go through this instead of resolveOrgFromRequest directly — API-key callers never pass, since a key isn't "a" member with a role. */
export async function requireOwner(): Promise<AuthedMember | { error: "unauthorized" | "forbidden" }> {
  const member = await getSessionMember();
  if (!member) return { error: "unauthorized" };
  if (member.role !== "OWNER") return { error: "forbidden" };
  return member;
}

/**
 * Platform-operator-only — deliberately stricter than requireOwner.
 * ReconciliationFinding (see lib/reconciliation.ts) is global,
 * cross-tenant data: it names real SettlementIntegration/Organization
 * ids across every org on this deployment, not just the caller's own.
 * An org's OWNER is the wrong authority to see that — this repo has no
 * separate "platform admin" role/table, so PLATFORM_ADMIN_EMAILS (a
 * comma-separated env var, unset by default) is the real, explicit
 * allowlist. Unset means nobody passes, not "any owner" — fail closed.
 */
export async function requirePlatformAdmin(): Promise<AuthedMember | { error: "unauthorized" | "forbidden" }> {
  const member = await getSessionMember();
  if (!member) return { error: "unauthorized" };
  const allowlist = (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!allowlist.includes(member.email.toLowerCase())) return { error: "forbidden" };
  return member;
}

/**
 * Rejects VIEWER-role session members from mutating routes. Call after
 * resolveOrgFromRequest succeeds, before performing the write — API-key
 * callers (no `role`) and OWNER/MEMBER session callers pass through
 * unchanged, since only VIEWER is read-only.
 */
export function requireWriteAccess(auth: Extract<OrgAuthResult, { organizationId: string }>): NextResponse | null {
  if (auth.role === "VIEWER") {
    return NextResponse.json({ error: "read-only members cannot perform this action" }, { status: 403 });
  }
  return null;
}

/**
 * Enforces API-key scopes on a route. Call after resolveOrgFromRequest
 * succeeds (and, for mutating routes, after requireWriteAccess), before
 * doing the work — same call-site shape as requireWriteAccess.
 *
 * A session-cookie caller (`auth.scopes === undefined`) is never
 * scope-gated — scopes are an API-key concept only, a human's access is
 * already governed by their MemberRole. An API-key caller with
 * `scopes.length === 0` is the explicit backward-compat default: every
 * key minted before this column existed (and any new key that doesn't
 * ask for a restriction) keeps full access, matching its pre-scopes
 * behavior exactly. A non-empty array is a real allowlist.
 */
export function requireScope(auth: Extract<OrgAuthResult, { organizationId: string }>, scope: ApiScope): NextResponse | null {
  if (auth.scopes === undefined || auth.scopes.length === 0) return null;
  if (!auth.scopes.includes(scope)) {
    return NextResponse.json({ error: `this API key is missing the required scope: ${scope}` }, { status: 403 });
  }
  return null;
}

/** Turns a non-success OrgAuthResult into the matching error response — call sites just early-return it. */
export function authErrorResponse(auth: Exclude<OrgAuthResult, { organizationId: string }>): NextResponse {
  if (auth.error === "rate_limited") {
    return NextResponse.json(
      { error: "rate limit exceeded", retryAfterSeconds: auth.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(auth.retryAfterSeconds) } }
    );
  }
  return NextResponse.json({ error: "authentication required" }, { status: 401 });
}
