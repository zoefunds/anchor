import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const SESSION_COOKIE = "anchor_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
// Fixed-window counter per key, held in process memory. This is
// intentionally not a DB table: it resets on deploy/restart and doesn't
// survive multiple instances, which is fine for the current single-process
// `next start` deployment (see the adjudicate route's caveat about the
// same limitation for its job runner) — move to Redis before scaling out
// horizontally.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const rateLimitWindows = new Map<string, { count: number; windowStart: number }>();

export function checkApiKeyRateLimit(apiKeyId: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const entry = rateLimitWindows.get(apiKeyId);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitWindows.set(apiKeyId, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSeconds = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  entry.count += 1;
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
  | { organizationId: string }
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
    const rateLimit = checkApiKeyRateLimit(apiKeyAuth.apiKeyId);
    if (!rateLimit.allowed) {
      return { error: "rate_limited", retryAfterSeconds: rateLimit.retryAfterSeconds! };
    }
    return { organizationId: apiKeyAuth.organizationId };
  }

  const member = await getSessionMember();
  if (member) return { organizationId: member.organizationId };

  return { error: "unauthorized" };
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
