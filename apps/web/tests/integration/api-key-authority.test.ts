import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { generateApiKey, getApiKeyAuth, resolveOrgFromRequest } from "@/lib/auth";
import { canAccessCase, caseVisibilityWhere, isCaseIdAllowedForAuth } from "@/lib/case-access";

// Real regression coverage for two related audit findings this session
// fixed: (1) API keys previously had no expiry, and (2) no per-case
// scope restriction — every key was permanently valid and org-wide-
// unrestricted the moment it was minted. This exercises the real
// lib/auth.ts + lib/case-access.ts logic (not mocked) against a real
// Postgres database, since that's exactly where both gaps lived.
//
// Deliberately does NOT test the OWNER-only gate on api-keys/route.ts
// itself — that route reads next/headers' cookies(), which needs a
// live Next.js request-scoped AsyncLocalStorage this test harness
// doesn't set up (calling route handlers directly works fine for
// header/body-only auth, as every other integration test in this repo
// does, but not for cookie-based session auth). requireOwner()'s logic
// itself (role !== "OWNER" -> forbidden) is simple enough to be
// low-risk; the higher-value gap was always the underlying key
// mechanics tested here.

let orgId: string;
let caseAId: string;
let caseBId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "api-key-authority-test-org" } });
  orgId = org.id;

  const caseA = await prisma.case.create({
    data: { organizationId: orgId, claim: "claim A", amount: "100", claimantRef: "A1", respondentRef: "A2", policyId: "agent_data_task_v1", policyVersion: "1.0.0" },
  });
  const caseB = await prisma.case.create({
    data: { organizationId: orgId, claim: "claim B", amount: "200", claimantRef: "B1", respondentRef: "B2", policyId: "agent_data_task_v1", policyVersion: "1.0.0" },
  });
  caseAId = caseA.id;
  caseBId = caseB.id;
});

afterAll(async () => {
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.apiKey.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function createKey(opts: { expiresAt?: Date | null; restrictedToCaseIds?: string[] }) {
  const { raw, prefix, hash } = generateApiKey();
  await prisma.apiKey.create({
    data: {
      organizationId: orgId,
      name: "test key",
      keyHash: hash,
      keyPrefix: prefix,
      expiresAt: opts.expiresAt ?? null,
      restrictedToCaseIds: opts.restrictedToCaseIds ?? [],
    },
  });
  return raw;
}

describe("API key expiry", () => {
  it("resolves a key with no expiry", async () => {
    const raw = await createKey({});
    const auth = await getApiKeyAuth(`Bearer ${raw}`);
    expect(auth).not.toBeNull();
    expect(auth!.organizationId).toBe(orgId);
  });

  it("resolves a key whose expiry is in the future", async () => {
    const raw = await createKey({ expiresAt: new Date(Date.now() + 60_000) });
    const auth = await getApiKeyAuth(`Bearer ${raw}`);
    expect(auth).not.toBeNull();
  });

  it("rejects a key whose expiry is in the past, same as a revoked key", async () => {
    const raw = await createKey({ expiresAt: new Date(Date.now() - 60_000) });
    const auth = await getApiKeyAuth(`Bearer ${raw}`);
    expect(auth).toBeNull();
  });
});

describe("API key case scoping", () => {
  it("an unrestricted key (empty restrictedToCaseIds) can access any case in its org", () => {
    const auth = { organizationId: orgId, apiKeyId: "fake", restrictedToCaseIds: [] as string[] };
    expect(isCaseIdAllowedForAuth(auth, caseAId)).toBe(true);
    expect(isCaseIdAllowedForAuth(auth, caseBId)).toBe(true);
  });

  it("a scoped key can access only its listed case(s)", () => {
    const auth = { organizationId: orgId, apiKeyId: "fake", restrictedToCaseIds: [caseAId] };
    expect(isCaseIdAllowedForAuth(auth, caseAId)).toBe(true);
    expect(isCaseIdAllowedForAuth(auth, caseBId)).toBe(false);
  });

  it("canAccessCase rejects a scoped key for a case outside its scope, even if the case itself is unrestricted", async () => {
    const auth = { organizationId: orgId, apiKeyId: "fake", restrictedToCaseIds: [caseAId] };
    const kase = await prisma.case.findUniqueOrThrow({ where: { id: caseBId } });
    expect(await canAccessCase(auth, kase)).toBe(false);
  });

  it("canAccessCase allows a scoped key for its own listed case", async () => {
    const auth = { organizationId: orgId, apiKeyId: "fake", restrictedToCaseIds: [caseAId] };
    const kase = await prisma.case.findUniqueOrThrow({ where: { id: caseAId } });
    expect(await canAccessCase(auth, kase)).toBe(true);
  });

  it("caseVisibilityWhere filters a scoped key's case list to only its allowed IDs", async () => {
    const auth = { organizationId: orgId, apiKeyId: "fake", restrictedToCaseIds: [caseAId] };
    const visible = await prisma.case.findMany({ where: { organizationId: orgId, ...caseVisibilityWhere(auth) } });
    expect(visible.map((c) => c.id).sort()).toEqual([caseAId].sort());
  });

  it("caseVisibilityWhere returns everything for an unrestricted key", async () => {
    const auth = { organizationId: orgId, apiKeyId: "fake", restrictedToCaseIds: [] as string[] };
    const visible = await prisma.case.findMany({ where: { organizationId: orgId, ...caseVisibilityWhere(auth) } });
    expect(visible.map((c) => c.id).sort()).toEqual([caseAId, caseBId].sort());
  });
});

describe("resolveOrgFromRequest carries restrictedToCaseIds through for API-key callers", () => {
  it("a scoped key's resolved auth reflects its real scope", async () => {
    const raw = await createKey({ restrictedToCaseIds: [caseBId] });
    const req = new Request("http://localhost/api/cases", { headers: { authorization: `Bearer ${raw}` } });
    const auth = await resolveOrgFromRequest(req);
    expect("error" in auth).toBe(false);
    if (!("error" in auth)) {
      expect(auth.restrictedToCaseIds).toEqual([caseBId]);
    }
  });
});
