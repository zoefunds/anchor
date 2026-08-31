import { randomBytes, createHash } from "crypto";
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

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generatePartyToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}

export type PartyRole = "claimant" | "respondent";

/**
 * Resolves a raw party token to the case it belongs to and which role it
 * grants — null if the token doesn't match any case's current
 * claimant/respondent token. Case scoping is enforced by the token
 * itself (it's only ever valid for the one case it was generated for),
 * not by a caseId the caller also supplies — a caller can't use a valid
 * token against the wrong case's id, since the token IS the lookup key.
 */
export async function resolvePartyToken(rawToken: string): Promise<{ caseId: string; role: PartyRole } | null> {
  const hash = hashToken(rawToken);
  const kase = await prisma.case.findFirst({
    where: { OR: [{ claimantTokenHash: hash }, { respondentTokenHash: hash }] },
    select: { id: true, claimantTokenHash: true },
  });
  if (!kase) return null;
  return { caseId: kase.id, role: kase.claimantTokenHash === hash ? "claimant" : "respondent" };
}
