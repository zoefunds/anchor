import { prisma } from "@/lib/prisma";
import type { OrgAuthResult } from "@/lib/auth";

type ResolvedAuth = Extract<OrgAuthResult, { organizationId: string }>;
type MinimalCase = { id: string; restricted: boolean };

/**
 * Whether an API key's OWN scope (independent of the case's `restricted`
 * flag) permits it to touch `caseId` — real gap fixed here (external
 * audit finding): API keys previously had no case-restriction concept
 * at all. An empty `restrictedToCaseIds` (the default, and every
 * pre-existing key) means unrestricted, same as before this existed —
 * this is purely additive, never more permissive than the prior
 * behavior. Always true for non-API-key callers (session auth has its
 * own, separate CaseAccess mechanism below).
 */
export function isCaseIdAllowedForAuth(auth: ResolvedAuth, caseId: string): boolean {
  if (!auth.apiKeyId) return true;
  if (!auth.restrictedToCaseIds || auth.restrictedToCaseIds.length === 0) return true;
  return auth.restrictedToCaseIds.includes(caseId);
}

/**
 * Whether `auth` may see/act on `kase` — call sites still separately check
 * kase.organizationId === auth.organizationId first (this only decides
 * per-case restriction, not org scoping).
 *
 * API-key callers and OWNER session members always pass the CASE's own
 * `restricted` flag, same full-trust posture as requireWriteAccess()'s
 * API-key carve-out and OWNER being the org's unrestricted admin
 * everywhere else — but an API key is still separately checked against
 * its OWN scope (isCaseIdAllowedForAuth) first, which is an independent,
 * possibly-narrower restriction. MEMBER/VIEWER session callers pass for
 * any unrestricted case; for a restricted one, only if a CaseAccess row
 * explicitly grants them access.
 */
export async function canAccessCase(auth: ResolvedAuth, kase: MinimalCase): Promise<boolean> {
  if (!isCaseIdAllowedForAuth(auth, kase.id)) return false;
  if (!kase.restricted) return true;
  if (auth.apiKeyId || auth.role === "OWNER") return true;
  if (!auth.memberId) return false;
  const access = await prisma.caseAccess.findUnique({
    where: { caseId_memberId: { caseId: kase.id, memberId: auth.memberId } },
  });
  return Boolean(access);
}

/**
 * The Prisma where-clause fragment that restricts a case list query to
 * what `auth` is allowed to see — for GET /api/cases, where checking each
 * row individually with canAccessCase would mean one query per case.
 * OWNER/API-key callers get an empty fragment for the CASE-restricted
 * concept (no filtering by kase.restricted, same bypass as
 * canAccessCase) — but a scoped API key ADDITIONALLY gets an `id IN
 * (...)` filter from its own restrictedToCaseIds, applied regardless of
 * role. MEMBER/VIEWER get "unrestricted, or I have an explicit
 * CaseAccess grant," same as before.
 */
export function caseVisibilityWhere(auth: ResolvedAuth) {
  const scopeFilter = auth.apiKeyId && auth.restrictedToCaseIds && auth.restrictedToCaseIds.length > 0 ? { id: { in: auth.restrictedToCaseIds } } : {};
  if (auth.apiKeyId || auth.role === "OWNER") return scopeFilter;
  if (!auth.memberId) return { restricted: false };
  return {
    OR: [{ restricted: false }, { caseAccess: { some: { memberId: auth.memberId } } }],
  };
}
