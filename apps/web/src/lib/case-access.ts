import { prisma } from "@/lib/prisma";
import type { OrgAuthResult } from "@/lib/auth";

type ResolvedAuth = Extract<OrgAuthResult, { organizationId: string }>;
type MinimalCase = { id: string; restricted: boolean };

/**
 * Whether `auth` may see/act on `kase` — call sites still separately check
 * kase.organizationId === auth.organizationId first (this only decides
 * per-case restriction, not org scoping).
 *
 * API-key callers and OWNER session members always pass, same full-trust
 * posture as requireWriteAccess()'s API-key carve-out and OWNER being the
 * org's unrestricted admin everywhere else. MEMBER/VIEWER session callers
 * pass for any unrestricted case; for a restricted one, only if a
 * CaseAccess row explicitly grants them access.
 */
export async function canAccessCase(auth: ResolvedAuth, kase: MinimalCase): Promise<boolean> {
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
 * OWNER/API-key callers get an empty fragment (no restriction filtering,
 * same bypass as canAccessCase); MEMBER/VIEWER get "unrestricted, or I
 * have an explicit CaseAccess grant."
 */
export function caseVisibilityWhere(auth: ResolvedAuth) {
  if (auth.apiKeyId || auth.role === "OWNER") return {};
  if (!auth.memberId) return { restricted: false };
  return {
    OR: [{ restricted: false }, { caseAccess: { some: { memberId: auth.memberId } } }],
  };
}
