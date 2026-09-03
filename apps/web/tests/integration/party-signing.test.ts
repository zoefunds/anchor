import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generatePartyToken } from "@/lib/party-auth";
import { generatePartySigningKeypair, signWithPartyKey, evidenceSigningMessage } from "@/lib/party-signing";
import { POST as postEvidence } from "@/app/api/public/cases/[id]/evidence/route";

// Exercises the optional signed-submission path (see
// lib/party-signing.ts) against real Postgres and the actual route
// handler — a real Ed25519 keypair, a real signature, verified for
// real against the stored public key. Covers the audit's "bearer
// capabilities are still not identity" finding: this is what upgrading
// toward real non-repudiation actually looks like end to end, not just
// unit-level crypto correctness.

let orgId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "party-signing-test-org" } });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.evidence.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  // See party-token-access.test.ts's identical fix for why this is
  // needed now — evidence submission writes an AuditLog row.
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function makeCaseWithSigningKeys() {
  const claimantToken = generatePartyToken();
  const respondentToken = generatePartyToken();
  const claimantKey = generatePartySigningKeypair();
  const respondentKey = generatePartySigningKeypair();
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "signing_test",
      amount: 100,
      claimantRef: "A",
      respondentRef: "B",
      policyId: "agent_data_task_v1",
      policyVersion: "1.0.0",
      status: "EVIDENCE_COLLECTION",
      claimantTokenHash: claimantToken.hash,
      respondentTokenHash: respondentToken.hash,
      claimantTokenExpiresAt: claimantToken.expiresAt,
      respondentTokenExpiresAt: respondentToken.expiresAt,
      claimantPublicKey: claimantKey.publicKeyHex,
      respondentPublicKey: respondentKey.publicKeyHex,
    },
  });
  return {
    kase,
    claimantToken: claimantToken.raw,
    claimantPrivateKey: claimantKey.privateKeyBase64,
    respondentPrivateKey: respondentKey.privateKeyBase64,
  };
}

describe("signed evidence submission", () => {
  it("marks signatureVerified true for a valid signature over the actual content", async () => {
    const { kase, claimantToken, claimantPrivateKey } = await makeCaseWithSigningKeys();
    const content = "the delivery genuinely met spec";
    const signature = signWithPartyKey(
      claimantPrivateKey,
      evidenceSigningMessage({ caseId: kase.id, type: "claimant_statement", content })
    );

    const req = new NextRequest(`http://test/api/public/cases/${kase.id}/evidence`, {
      method: "POST",
      body: JSON.stringify({ token: claimantToken, type: "claimant_statement", content, signature }),
    });
    const res = await postEvidence(req, { params: { id: kase.id } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.signatureVerified).toBe(true);
    expect(body.submittedBy).toBe("claimant");
  });

  it("submits successfully with signatureVerified false when no signature is provided (unsigned path still works)", async () => {
    const { kase, claimantToken } = await makeCaseWithSigningKeys();
    const req = new NextRequest(`http://test/api/public/cases/${kase.id}/evidence`, {
      method: "POST",
      body: JSON.stringify({ token: claimantToken, type: "claimant_statement", content: "no signature here" }),
    });
    const res = await postEvidence(req, { params: { id: kase.id } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.signatureVerified).toBe(false);
  });

  it("rejects a submission with a signature from the WRONG party's key", async () => {
    const { kase, claimantToken, respondentPrivateKey } = await makeCaseWithSigningKeys();
    const content = "forged attribution attempt";
    // Signed with the respondent's key but submitted using the claimant's token.
    const signature = signWithPartyKey(
      respondentPrivateKey,
      evidenceSigningMessage({ caseId: kase.id, type: "claimant_statement", content })
    );

    const req = new NextRequest(`http://test/api/public/cases/${kase.id}/evidence`, {
      method: "POST",
      body: JSON.stringify({ token: claimantToken, type: "claimant_statement", content, signature }),
    });
    const res = await postEvidence(req, { params: { id: kase.id } });
    expect(res.status).toBe(401);
  });

  it("rejects a signature that doesn't match the actual submitted content (tampered after signing)", async () => {
    const { kase, claimantToken, claimantPrivateKey } = await makeCaseWithSigningKeys();
    const signedContent = "the original, signed statement";
    const signature = signWithPartyKey(
      claimantPrivateKey,
      evidenceSigningMessage({ caseId: kase.id, type: "claimant_statement", content: signedContent })
    );

    const req = new NextRequest(`http://test/api/public/cases/${kase.id}/evidence`, {
      method: "POST",
      body: JSON.stringify({
        token: claimantToken,
        type: "claimant_statement",
        content: "a DIFFERENT statement than what was signed",
        signature,
      }),
    });
    const res = await postEvidence(req, { params: { id: kase.id } });
    expect(res.status).toBe(401);
  });
});
