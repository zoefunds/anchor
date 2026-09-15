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

// Cookie name is scoped to both the case AND the resolved role — not a
// single fixed name. A single shared name meant that opening the
// respondent's link in the same browser that already held a claimant
// session for the same case would silently overwrite it: the browser can
// only hold one value per cookie name, so whichever party link was
// opened (or refreshed) most recently won, and the other tab would then
// misattribute all of its actions to the wrong role — exactly the
// "claims I already submitted evidence" confusion this fixes. Scoping by
// case+role lets both roles hold independent sessions in the same
// browser (useful for an org testing both party links itself, not just
// the two-different-people case).
const PARTY_SESSION_COOKIE_PREFIX = "anchor_party_session";

export function partySessionCookieName(caseId: string, role: PartyRole): string {
  return `${PARTY_SESSION_COOKIE_PREFIX}_${caseId}_${role}`;
}

/** Reads whichever role's session cookie is present for this case (a request only ever carries the one relevant to whichever party link it was opened from). */
export function readPartySessionCookie(
  cookies: { get(name: string): { value: string } | undefined },
  caseId: string
): string | undefined {
  return (
    cookies.get(partySessionCookieName(caseId, "claimant"))?.value ??
    cookies.get(partySessionCookieName(caseId, "respondent"))?.value
  );
}

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
 * The auth check every /api/public/cases/:id/* route should use: an
 * explicit raw token wins whenever the caller supplies one — that's the
 * caller directly asserting "I am whoever this specific link belongs
 * to," which must never be overridden by a stale cookie from a
 * different party link opened earlier in the same browser (see
 * readPartySessionCookie's comment). Only when no token is supplied does
 * this fall back to the session cookie — the path a browser lands on
 * after its one-time exchange, for every request after the token has
 * already been stripped from the URL. Either way the result is scoped to
 * the specific caseId in the URL.
 */
export async function resolvePartyAuth(
  sessionCookieValue: string | undefined,
  rawToken: string | undefined,
  caseId: string
): Promise<{ role: PartyRole } | null> {
  if (rawToken) {
    const resolved = await resolvePartyToken(rawToken);
    if (resolved && resolved.caseId === caseId) return { role: resolved.role };
  }

  const session = await resolvePartySession(sessionCookieValue);
  if (session && session.caseId === caseId) return { role: session.role };

  return null;
}
