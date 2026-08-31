import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";

// Isolates whether the "evidence map came back empty under concurrent
// adjudication" bug observed live in production is even in Anchor's own
// code (the Prisma fetch + local transform in runAdjudicationJob) or
// purely downstream in GenLayer/genlayer-js — by reproducing the exact
// same fetch-and-transform logic concurrently against real Postgres,
// with zero GenLayer involvement. If this passes reliably, the bug is
// downstream of Anchor's own evidence handling.

let orgId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "concurrency-repro-org" } });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.evidence.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function makeCaseWithEvidence(claim: string) {
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim,
      amount: 100,
      claimantRef: "A",
      respondentRef: "B",
      policyId: "agent_data_task_v1",
      policyVersion: "1.0.0",
      status: "EVIDENCE_COLLECTION",
    },
  });
  for (const type of ["task_spec", "delivery_payload", "claimant_statement", "respondent_statement"]) {
    await prisma.evidence.create({
      data: { caseId: kase.id, type, contentHash: `hash_${type}`, storageRef: `content for ${type}` },
    });
  }
  return kase.id;
}

// Mirrors runAdjudicationJob's exact fetch + transform, minus GenLayer.
async function fetchAndBuildEvidenceMap(caseId: string) {
  const kase = await prisma.case.findUniqueOrThrow({ where: { id: caseId }, include: { evidence: true } });
  const evidence: Record<string, string> = {};
  const sortedEvidence = [...kase.evidence].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const e of sortedEvidence) {
    evidence[e.type] = e.storageRef;
  }
  return { rowCount: kase.evidence.length, evidenceKeys: Object.keys(evidence) };
}

describe("concurrency repro — Prisma-level evidence fetch under load", () => {
  it("20 concurrent fetches across 2 cases never lose evidence rows", async () => {
    const caseA = await makeCaseWithEvidence("concurrency_repro_a");
    const caseB = await makeCaseWithEvidence("concurrency_repro_b");

    const tasks: Promise<{ rowCount: number; evidenceKeys: string[] }>[] = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(fetchAndBuildEvidenceMap(caseA));
      tasks.push(fetchAndBuildEvidenceMap(caseB));
    }
    const results = await Promise.all(tasks);

    for (const r of results) {
      expect(r.rowCount).toBe(4);
      expect(r.evidenceKeys.length).toBe(4);
    }
  });
});
