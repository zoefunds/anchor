import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import IORedis from "ioredis";
import { prisma } from "@/lib/prisma";

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

  cookies().set(SESSION_COOKIE, signToken(token), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession(): Promise<void> {
  const raw = cookies().get(SESSION_COOKIE)?.value;
  if (raw) {
    const token = verifySignedCookie(raw);
    if (token) {
      await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
  }
  cookies().delete(SESSION_COOKIE);
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
  const raw = cookies().get(SESSION_COOKIE)?.value;
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
}

// --- API key rate limiting ---
// Redis-backed fixed-window counter per key (see lib/genlayer-rate-limit.ts
// for the same pattern/tradeoffs) — this used to be a plain in-memory Map,
// which only ever worked because everything ran in one `next start`
// process. That assumption breaks entirely on Vercel: every request can
// land on a different serverless invocation with its own fresh memory, so
// an in-memory counter there wouldn't actually limit anything.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;

export async function checkApiKeyRateLimit(apiKeyId: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const redis = getRateLimitRedis();
  const bucket = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
  const key = `apikey_rl:${apiKeyId}:${bucket}`;

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) + 5);
  }

  if (count > RATE_LIMIT_MAX_REQUESTS) {
    const windowEnd = (bucket + 1) * RATE_LIMIT_WINDOW_MS;
    return { allowed: false, retryAfterSeconds: Math.ceil((windowEnd - Date.now()) / 1000) };
  }
  return { allowed: true };
}

/** Resolves an `Authorization: Bearer <key>` header to its organization. */
export async function getApiKeyAuth(authHeader: string | null): Promise<AuthedApiKey | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const raw = authHeader.slice("Bearer ".length).trim();
  if (!raw) return null;

  const key = await prisma.apiKey.findUnique({ where: { keyHash: hashToken(raw) } });
  if (!key || key.revokedAt) return null;

  // Fire-and-forget last-used update — not on the critical path.
  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });

  return { organizationId: key.organizationId, apiKeyId: key.id };
}

export type OrgAuthResult =
  | { organizationId: string; memberId?: string; apiKeyId?: string; role?: "OWNER" | "MEMBER" | "VIEWER" }
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
    const rateLimit = await checkApiKeyRateLimit(apiKeyAuth.apiKeyId);
    if (!rateLimit.allowed) {
      return { error: "rate_limited", retryAfterSeconds: rateLimit.retryAfterSeconds! };
    }
    return { organizationId: apiKeyAuth.organizationId, apiKeyId: apiKeyAuth.apiKeyId };
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
