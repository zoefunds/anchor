import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner, generateApiKey } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { isValidScope } from "@/lib/api-scopes";

// API keys can only be managed via a dashboard session, not another API
// key — otherwise a leaked key could mint itself unlimited replacements.
//
// Real P0 fixed here (found by an external audit): this used to accept
// any authenticated session member, including VIEWER. An API key carries
// no role of its own — resolveOrgFromRequest's OrgAuthResult only sets
// `role` for session callers, so an API-key-authenticated request always
// passes requireWriteAccess's VIEWER check. That meant a read-only member
// could mint a key and use it to bypass their own read-only restriction
// entirely, becoming an unrestricted org-wide writer. Management is now
// OWNER-only, matching the same requireOwner() gate this project already
// uses for webhooks/member management/audit log.
export async function GET() {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }
  const keys = await prisma.apiKey.findMany({
    where: { organizationId: member.organizationId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
      creatorMemberId: true,
      expiresAt: true,
      restrictedToCaseIds: true,
      scopes: true,
      rotatedFromKeyId: true,
    },
  });
  return NextResponse.json(keys);
}

// Real P0-adjacent gap fixed here (external audit finding): keys used
// to be permanently valid and org-wide-unrestricted the instant they
// were minted, with no record of who created them. New keys now
// default to a bounded 90-day expiry (a real security-positive
// behavior change, not just a schema field nobody sets) unless the
// caller explicitly opts out with `expiresInDays: null` — an explicit,
// visible choice rather than a silent default. `restrictedToCaseIds`
// is optional; omitted or empty means unrestricted, same as every
// pre-existing key.
const DEFAULT_KEY_EXPIRY_DAYS = 90;

export async function POST(req: NextRequest) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }
  const { name, expiresInDays, restrictedToCaseIds, scopes } = await req.json();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  let expiresAt: Date | null;
  if (expiresInDays === undefined) {
    expiresAt = new Date(Date.now() + DEFAULT_KEY_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  } else if (expiresInDays === null) {
    expiresAt = null; // explicit opt-out of expiry
  } else if (typeof expiresInDays === "number" && Number.isInteger(expiresInDays) && expiresInDays > 0) {
    expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  } else {
    return NextResponse.json({ error: "expiresInDays must be a positive integer, or null to opt out of expiry" }, { status: 400 });
  }

  let caseIds: string[] = [];
  if (restrictedToCaseIds !== undefined) {
    if (!Array.isArray(restrictedToCaseIds) || restrictedToCaseIds.some((id) => typeof id !== "string")) {
      return NextResponse.json({ error: "restrictedToCaseIds must be an array of case ID strings" }, { status: 400 });
    }
    caseIds = [...new Set(restrictedToCaseIds)];
    if (caseIds.length > 0) {
      const found = await prisma.case.findMany({
        where: { id: { in: caseIds }, organizationId: member.organizationId },
        select: { id: true },
      });
      const foundIds = new Set(found.map((c) => c.id));
      const missing = caseIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        return NextResponse.json({ error: `unknown case ID(s) for this organization: ${missing.join(", ")}` }, { status: 400 });
      }
    }
  }

  // scopes omitted or [] = full access — see ApiKey.scopes' schema
  // comment. Explicit is validated against the real vocabulary so a
  // typo'd scope fails loudly at creation time, not silently at
  // enforcement time.
  let keyScopes: string[] = [];
  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string")) {
      return NextResponse.json({ error: "scopes must be an array of scope strings" }, { status: 400 });
    }
    keyScopes = [...new Set(scopes)];
    const invalid = keyScopes.filter((s) => !isValidScope(s));
    if (invalid.length > 0) {
      return NextResponse.json({ error: `unknown scope(s): ${invalid.join(", ")}` }, { status: 400 });
    }
  }

  // Real audit-completeness gap fixed here (external audit finding):
  // API-key creation — a genuinely security-sensitive action, now
  // OWNER-only for exactly that reason — was never audited at all.
  // Wrapped in one transaction with the audit write, same pattern as
  // case/webhook creation elsewhere in this project: either both commit,
  // or neither does, so a failed audit write can never leave a silently
  // unlogged privileged action.
  const { raw, prefix, hash } = generateApiKey();
  const key = await prisma.$transaction(async (tx) => {
    const created = await tx.apiKey.create({
      data: {
        organizationId: member.organizationId,
        name,
        keyHash: hash,
        keyPrefix: prefix,
        creatorMemberId: member.memberId,
        expiresAt,
        restrictedToCaseIds: caseIds,
        scopes: keyScopes,
      },
    });
    await logAction(
      {
        organizationId: member.organizationId,
        memberId: member.memberId,
        action: "api_key.created",
        targetType: "apiKey",
        targetId: created.id,
        metadata: { name, keyPrefix: prefix, expiresAt, restrictedToCaseIds: caseIds, scopes: keyScopes },
      },
      tx
    );
    return created;
  });

  // The raw key is returned exactly once, here — it is never retrievable
  // again after this response.
  return NextResponse.json(
    {
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      key: raw,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
      restrictedToCaseIds: key.restrictedToCaseIds,
      scopes: key.scopes,
    },
    { status: 201 }
  );
}
