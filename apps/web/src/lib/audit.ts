import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

interface LogActionParams {
  organizationId: string;
  memberId?: string | null;
  apiKeyId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

// Fixed value used as prevHash for the very first real row in an
// organization's chain (there's no real previous row to point at yet).
const GENESIS_HASH = "genesis";

/**
 * Recursively sorts object keys before serializing. Postgres JSONB does
 * NOT preserve the property insertion order of what was written to it —
 * reading `metadata` back can (and does, in practice) produce a
 * differently-ordered object than the one passed to prisma.auditLog.create.
 * A plain JSON.stringify over that object then produces a different
 * string than at write time even though the actual data is identical,
 * which breaks hash verification for every row with metadata. Sorting
 * keys before stringifying makes the serialization depend only on the
 * data, not on Postgres's internal JSONB key ordering.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function computeRowHash(params: {
  organizationId: string;
  memberId: string | null;
  apiKeyId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Prisma.InputJsonValue | undefined;
  createdAt: Date;
  prevHash: string;
}): string {
  // canonicalJson (not plain JSON.stringify) because `metadata` round-trips
  // through Postgres JSONB, which doesn't preserve key order — see
  // canonicalJson's own comment. The outer object's own key order here is
  // fixed by this function's source and never round-trips through JSONB
  // itself, so it doesn't strictly need sorting, but using canonicalJson
  // throughout keeps this function's output depending only on data, not
  // on incidental object-literal order anywhere in the call chain.
  const canonical = canonicalJson({
    organizationId: params.organizationId,
    memberId: params.memberId,
    apiKeyId: params.apiKeyId,
    action: params.action,
    targetType: params.targetType,
    targetId: params.targetId,
    metadata: params.metadata ?? null,
    createdAt: params.createdAt.toISOString(),
    prevHash: params.prevHash,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Records one audit-log entry as the next link in that organization's
 * tamper-evidence hash chain (see the AuditLog model's own doc comment
 * for what this does and doesn't protect against). Awaited by every
 * caller now, not fire-and-forget: a serverless request handler (Vercel)
 * can suspend the moment it sends its response, and an un-awaited promise
 * has no guarantee of completing before that happens — a compliance audit
 * trail that can silently lose entries under normal operation isn't
 * "durable" no matter how carefully the write itself is coded. Callers
 * that genuinely cannot afford to have their user-facing action blocked
 * by a slow audit write should say so explicitly by wrapping the call in
 * their own fire-and-forget, not by relying on this function to do it for
 * them silently.
 *
 * A first version of this used a plain read-then-write with a retry on
 * `hash` unique-constraint violation, reasoning that concurrent writers
 * to the SAME organization's chain were rare enough not to matter. A
 * concurrency test proved that reasoning wrong: two concurrent writers
 * can both read the same "previous" row before either has inserted,
 * compute DIFFERENT hashes (their `action`s differ) against the SAME
 * prevHash, and both inserts succeed — no unique-constraint violation at
 * all, just a forked chain (two rows both claiming the same ancestor).
 * A `pg_advisory_xact_lock` keyed by organizationId now serializes every
 * write to one organization's chain (held for the transaction's
 * lifetime, released automatically at commit/rollback) while leaving
 * different organizations' chains fully concurrent with each other.
 */
export async function logAction(params: LogActionParams): Promise<void> {
  const memberId = params.memberId ?? null;
  const apiKeyId = params.apiKeyId ?? null;
  const targetId = params.targetId ?? null;
  const metadata = (params.metadata as Prisma.InputJsonValue) ?? undefined;

  try {
    await prisma.$transaction(async (tx) => {
      // hashtext() maps the organizationId string to a stable bigint-ish
      // lock key; a 64-bit hash collision between two different real
      // organization ids is astronomically unlikely and, even if it
      // happened, would only ever cause extra (harmless) serialization
      // between two unrelated orgs' writes, never a correctness issue.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.organizationId}))`;

      const previous = await tx.auditLog.findFirst({
        where: { organizationId: params.organizationId },
        orderBy: { createdAt: "desc" },
        select: { hash: true },
      });
      const prevHash = previous?.hash ?? GENESIS_HASH;
      const createdAt = new Date();
      const hash = computeRowHash({
        organizationId: params.organizationId,
        memberId,
        apiKeyId,
        action: params.action,
        targetType: params.targetType,
        targetId,
        metadata,
        createdAt,
        prevHash,
      });

      await tx.auditLog.create({
        data: {
          organizationId: params.organizationId,
          memberId,
          apiKeyId,
          action: params.action,
          targetType: params.targetType,
          targetId,
          metadata,
          createdAt,
          prevHash,
          hash,
        },
      });
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("audit log write failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Verifies one organization's audit chain is intact — every row's hash
 * matches computeRowHash() over its own fields plus prevHash, and every
 * row's prevHash matches the previous row's hash (or GENESIS_HASH for the
 * first real, non-legacy row). Returns the id of the first broken row, or
 * null if the chain (excluding pre-migration "legacy-unchained:" rows,
 * which were never chained at write time — see the migration's own
 * comment) verifies cleanly. Intended for a periodic compliance check or
 * an on-demand audit endpoint, not the request-handling path.
 */
export async function verifyAuditChain(organizationId: string): Promise<{ ok: boolean; brokenAtId: string | null }> {
  const rows = await prisma.auditLog.findMany({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
  });

  let expectedPrevHash = GENESIS_HASH;
  for (const row of rows) {
    // Legacy pre-migration rows were never chained at write time (see
    // the migration's own comment) — their "hash" is an unverifiable
    // sentinel, not a real one, so there's nothing to recompute and
    // compare here. What DOES still matter is that the first real row
    // after one correctly points its prevHash at whatever the actual
    // previous row's stored hash was (legacy sentinel or real), so the
    // chain has no gap at the legacy/real boundary — that's still
    // checked below via expectedPrevHash, just without a hash
    // recomputation for the legacy row itself.
    if (row.hash.startsWith("legacy-unchained:")) {
      expectedPrevHash = row.hash;
      continue;
    }
    if (row.prevHash !== expectedPrevHash) {
      return { ok: false, brokenAtId: row.id };
    }
    const recomputed = computeRowHash({
      organizationId: row.organizationId,
      memberId: row.memberId,
      apiKeyId: row.apiKeyId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      metadata: (row.metadata as Prisma.InputJsonValue) ?? undefined,
      createdAt: row.createdAt,
      prevHash: row.prevHash,
    });
    if (recomputed !== row.hash) {
      return { ok: false, brokenAtId: row.id };
    }
    expectedPrevHash = row.hash;
  }
  return { ok: true, brokenAtId: null };
}
