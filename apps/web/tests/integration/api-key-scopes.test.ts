import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/auth";
import { GET as policiesGet } from "@/app/api/policies/route";
import { GET as casesGet, POST as casesPost } from "@/app/api/cases/route";

// Real regression coverage for Phase 5's API-key scope enforcement.
// Calls the actual exported route handlers (not a mock, not just
// lib/auth.ts's requireScope() in isolation) against a real Postgres
// database, the same style tests/integration/api-key-authority.test.ts
// already uses for the expiry/case-scoping gaps.

let orgId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "api-key-scopes-test-org" } });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.riskAssessment.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.apiKey.deleteMany({ where: { organizationId: orgId } });
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function createKey(scopes: string[]) {
  const { raw, prefix, hash } = generateApiKey();
  await prisma.apiKey.create({
    data: { organizationId: orgId, name: "scope-test key", keyHash: hash, keyPrefix: prefix, scopes },
  });
  return raw;
}

function req(url: string, init?: RequestInit) {
  return new NextRequest(new Request(url, init));
}

describe("API key scope enforcement (real route handlers)", () => {
  it("a key scoped to only cases:write is rejected with a real 403 from GET /api/policies (needs policies:read)", async () => {
    const raw = await createKey(["cases:write"]);
    const res = await policiesGet(req("http://localhost/api/policies", { headers: { authorization: `Bearer ${raw}` } }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/policies:read/);
  });

  it("a key scoped to policies:read is allowed through GET /api/policies", async () => {
    const raw = await createKey(["policies:read"]);
    const res = await policiesGet(req("http://localhost/api/policies", { headers: { authorization: `Bearer ${raw}` } }));
    expect(res.status).toBe(200);
  });

  it("a pre-existing key with scopes=[] (backward-compat default) has full access to GET /api/policies", async () => {
    const raw = await createKey([]);
    const res = await policiesGet(req("http://localhost/api/policies", { headers: { authorization: `Bearer ${raw}` } }));
    expect(res.status).toBe(200);
  });

  it("a key scoped to only cases:read is rejected with a real 403 from POST /api/cases (needs cases:write)", async () => {
    const raw = await createKey(["cases:read"]);
    const res = await casesPost(
      req("http://localhost/api/cases", {
        method: "POST",
        headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" },
        body: JSON.stringify({ claim: "x", amount: "10", claimantRef: "c1", respondentRef: "r1" }),
      })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/cases:write/);
  });

  it("a key scoped to cases:write can actually POST /api/cases, and the created case does not leak to a cases:read-only GET from a differently-scoped key in the same org", async () => {
    const writeKeyRaw = await createKey(["cases:write"]);
    const createRes = await casesPost(
      req("http://localhost/api/cases", {
        method: "POST",
        headers: { authorization: `Bearer ${writeKeyRaw}`, "content-type": "application/json" },
        body: JSON.stringify({ claim: "scope-test claim", amount: "10", claimantRef: "c1", respondentRef: "r1" }),
      })
    );
    expect(createRes.status).toBe(201);

    const readKeyRaw = await createKey(["cases:read"]);
    const listRes = await casesGet(req("http://localhost/api/cases", { headers: { authorization: `Bearer ${readKeyRaw}` } }));
    expect(listRes.status).toBe(200);
    const cases = await listRes.json();
    expect(cases.some((c: { claim: string }) => c.claim === "scope-test claim")).toBe(true);
  });
});
