import { randomBytes, createHash, createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";

// Per-case, per-role capability tokens — the raw token is shown exactly
// once (at case creation, in the POST /api/cases response), only its
// sha256 hash is ever stored (same discipline as Session/ApiKey/Invite).
// Anyone holding a raw token can act AS that specific party on that
// specific case via /api/public/cases/:id/* routes, without needing an
// org session or API key. This is real per-case, per-role standing (a
// bearer capability secret), not full cryptographic identity/signature
// verification — a party never proves who they are, only that they
// possess the secret the case-creating org handed them. Documented as
// such, not oversold.

const PARTY_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Deliberately much shorter than the token itself — a session exchanged
// from a raw token is meant to cover "one sitting" (reading the case,
// submitting evidence, filing an appeal), not to become a second
// long-lived credential in its own right.
const PARTY_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is not set — see apps/web/.env.example");
  }
  return secret;
}

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

export function generatePartyToken(): { raw: string; hash: string; expiresAt: Date } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw), expiresAt: new Date(Date.now() + PARTY_TOKEN_TTL_MS) };
}

export type PartyRole = "claimant" | "respondent";

/**
 * Resolves a raw party token to the case it belongs to and which role it
 * grants — null if the token doesn't match any case's current
 * claimant/respondent token, OR if it matched but has expired (see
 * PARTY_TOKEN_TTL_MS above; expired is treated identically to invalid,
 * not surfaced as a distinct error, so a caller probing tokens can't use
 * the response to distinguish "wrong" from "right but stale"). Case
 * scoping is enforced by the token itself (it's only ever valid for the
 * one case it was generated for), not by a caseId the caller also
 * supplies.
 */
export async function resolvePartyToken(rawToken: string): Promise<{ caseId: string; role: PartyRole } | null> {
  const hash = hashToken(rawToken);
  const kase = await prisma.case.findFirst({
    where: { OR: [{ claimantTokenHash: hash }, { respondentTokenHash: hash }] },
    select: { id: true, claimantTokenHash: true, claimantTokenExpiresAt: true, respondentTokenExpiresAt: true },
  });
  if (!kase) return null;
  const isClaimant = kase.claimantTokenHash === hash;
  const expiresAt = isClaimant ? kase.claimantTokenExpiresAt : kase.respondentTokenExpiresAt;
  if (expiresAt && expiresAt < new Date()) return null;
  return { caseId: kase.id, role: isClaimant ? "claimant" : "respondent" };
}

export const PARTY_SESSION_COOKIE = "anchor_party_session";

/**
 * Exchanges a raw (still-valid) party token for a short-lived session —
 * the fix for "party tokens are long-lived bearer URLs in query
 * parameters" (they leak through browser history, logs, referrers,
 * screenshots). After this, the caller uses the returned signed cookie
 * value for subsequent requests instead of resending the raw token, and
 * the raw token itself only ever needs to appear once, in the initial
 * link. Returns null if the token doesn't resolve (same as
 * resolvePartyToken).
 */
export async function exchangePartyTokenForSession(
  rawToken: string
): Promise<{ caseId: string; role: PartyRole; cookieValue: string; expiresAt: Date } | null> {
  const resolved = await resolvePartyToken(rawToken);
  if (!resolved) return null;

  const sessionToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + PARTY_SESSION_TTL_MS);
  await prisma.partySession.create({
    data: {
      caseId: resolved.caseId,
      role: resolved.role,
      tokenHash: hashToken(sessionToken),
      expiresAt,
    },
  });

  return { ...resolved, cookieValue: signToken(sessionToken), expiresAt };
}

/** Resolves a party session from its signed cookie value — null if missing, tampered, unknown, or expired. */
export async function resolvePartySession(cookieValue: string | undefined): Promise<{ caseId: string; role: PartyRole } | null> {
  if (!cookieValue) return null;
  const token = verifySignedCookie(cookieValue);
  if (!token) return null;

  const session = await prisma.partySession.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!session || session.expiresAt < new Date()) return null;
  return { caseId: session.caseId, role: session.role as PartyRole };
}

/**
 * The auth check every /api/public/cases/:id/* route should use: prefer
 * the short-lived session cookie (the path a browser hitting the public
 * case page ends up on after exchanging its token — see the session
 * route), fall back to a raw token if the caller supplied one directly
 * (programmatic callers that never visit the page have no reason to
 * exchange first, and requiring it would just be friction with no
 * security benefit for a caller that already isn't a browser leaking
 * URLs into history). Either way the result is scoped to the specific
 * caseId in the URL, same as before.
 */
export async function resolvePartyAuth(
  sessionCookieValue: string | undefined,
  rawToken: string | undefined,
  caseId: string
): Promise<{ role: PartyRole } | null> {
  const session = await resolvePartySession(sessionCookieValue);
  if (session && session.caseId === caseId) return { role: session.role };

  if (rawToken) {
    const resolved = await resolvePartyToken(rawToken);
    if (resolved && resolved.caseId === caseId) return { role: resolved.role };
  }

  return null;
}
