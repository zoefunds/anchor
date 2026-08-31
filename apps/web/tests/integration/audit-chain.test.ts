import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { logAction, verifyAuditChain } from "@/lib/audit";

// Real Postgres, real hash chain, real tamper detection — not a unit
// test of computeRowHash in isolation. Covers the audit finding that a
// compliance trail needs to be "durable, complete, retained, and
// tamper-evident," and specifically the JSONB key-ordering bug that
// broke chain verification the first time this was tested manually
// (Postgres doesn't preserve object key insertion order on round-trip,
// which a plain JSON.stringify hash is silently sensitive to).

let orgId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "audit-chain-test-org" } });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("audit log hash chain", () => {
  it("verifies a real chain of writes, including metadata that round-trips through Postgres JSONB", async () => {
    await logAction({ organizationId: orgId, action: "test.one", targetType: "test", metadata: { z: 1, a: 2, nested: { b: 1, a: 2 } } });
    await logAction({ organizationId: orgId, action: "test.two", targetType: "test" });
    await logAction({ organizationId: orgId, action: "test.three", targetType: "test", metadata: { array: [3, 1, 2] } });

    const result = await verifyAuditChain(orgId);
    expect(result).toEqual({ ok: true, brokenAtId: null });
  });

  it("detects an in-place edit of a historical row", async () => {
    const row = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: "test.one" } });
    expect(row).not.toBeNull();

    await prisma.auditLog.update({ where: { id: row!.id }, data: { action: "test.tampered" } });

    const result = await verifyAuditChain(orgId);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(row!.id);

    // Restore, so this test doesn't poison the org's chain for anything
    // that runs after it within the same suite.
    await prisma.auditLog.update({ where: { id: row!.id }, data: { action: "test.one" } });
  });

  it("chains prevHash correctly across concurrent writes to the same organization", async () => {
    await Promise.all([
      logAction({ organizationId: orgId, action: "test.concurrent.a", targetType: "test" }),
      logAction({ organizationId: orgId, action: "test.concurrent.b", targetType: "test" }),
      logAction({ organizationId: orgId, action: "test.concurrent.c", targetType: "test" }),
    ]);

    const result = await verifyAuditChain(orgId);
    expect(result).toEqual({ ok: true, brokenAtId: null });

    const rows = await prisma.auditLog.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } });
    expect(rows.length).toBeGreaterThanOrEqual(6);
    // Every row's hash must be unique — a real chain, not accidental
    // collisions from the concurrent-write retry path reusing a prevHash.
    expect(new Set(rows.map((r) => r.hash)).size).toBe(rows.length);
  });
});
