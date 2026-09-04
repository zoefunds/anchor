import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generatePartyToken } from "@/lib/party-auth";
import { generatePartySigningKeypair, signWithPartyKey, evidenceSigningMessage, settlementAddressSigningMessage } from "@/lib/party-signing";
import { POST as postEvidence } from "@/app/api/public/cases/[id]/evidence/route";
import { POST as postSigningKey } from "@/app/api/public/cases/[id]/signing-key/route";
import { POST as postSettlementAddress } from "@/app/api/public/cases/[id]/settlement-address/route";

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
  await prisma.caseSettlement.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.settlementIntegration.deleteMany({ where: { organizationId: orgId } });
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

// Security-audit fix: write-once signing-key registration + mandatory
// signature on settlement-address once a key is registered.
describe("signing-key registration is write-once", () => {
  it("rejects a second registration attempt for a role that already has a key", async () => {
    const claimantToken = generatePartyToken();
    const kase = await prisma.case.create({
      data: {
        organizationId: orgId,
        claim: "write-once test",
        amount: 100,
        claimantRef: "A",
        respondentRef: "B",
        policyId: "agent_data_task_v1",
        policyVersion: "1.0.0",
        claimantTokenHash: claimantToken.hash,
        claimantTokenExpiresAt: claimantToken.expiresAt,
      },
    });

    const firstKey = generatePartySigningKeypair();
    const firstReq = new NextRequest(`http://test/api/public/cases/${kase.id}/signing-key`, {
      method: "POST",
      body: JSON.stringify({ token: claimantToken.raw, publicKeyHex: firstKey.publicKeyHex }),
    });
    const firstRes = await postSigningKey(firstReq, { params: { id: kase.id } });
    expect(firstRes.status).toBe(200);

    const secondKey = generatePartySigningKeypair();
    const secondReq = new NextRequest(`http://test/api/public/cases/${kase.id}/signing-key`, {
      method: "POST",
      body: JSON.stringify({ token: claimantToken.raw, publicKeyHex: secondKey.publicKeyHex }),
    });
    const secondRes = await postSigningKey(secondReq, { params: { id: kase.id } });
    expect(secondRes.status).toBe(409);

    const stored = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
    expect(stored.claimantPublicKey).toBe(firstKey.publicKeyHex.toLowerCase());
  });
});

describe("settlement-address requires a valid signature once a signing key is registered", () => {
  async function makeBoundCase(withClaimantKey: boolean) {
    const claimantToken = generatePartyToken();
    const claimantKey = withClaimantKey ? generatePartySigningKeypair() : null;
    const integration = await prisma.settlementIntegration.create({
      data: {
        organizationId: orgId,
        chain: "sepolia",
        escrowContractAddress: "0x0000000000000000000000000000000000dEaD",
        assetSymbol: "ETH",
        assetDecimals: 18,
        escrowVersion: "V2",
        createdByMemberId: "m",
      },
    });
    const kase = await prisma.case.create({
      data: {
        organizationId: orgId,
        claim: "settlement-address signature test",
        amount: "1",
        claimantRef: "A",
        respondentRef: "B",
        policyId: "p",
        policyVersion: "v1",
        claimantTokenHash: claimantToken.hash,
        claimantTokenExpiresAt: claimantToken.expiresAt,
        claimantPublicKey: claimantKey?.publicKeyHex,
      },
    });
    await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: `0x${"11".repeat(32)}`, expectedAmountAtto: "1000000000000000000" },
    });
    return { kase, claimantToken: claimantToken.raw, claimantPrivateKey: claimantKey?.privateKeyBase64 };
  }

  it("still works with just a bearer token when no signing key is registered (unsigned path preserved)", async () => {
    const { kase, claimantToken } = await makeBoundCase(false);
    const address = "0x00000000000000000000000000000000000000C1";
    const req = new NextRequest(`http://test/api/public/cases/${kase.id}/settlement-address`, {
      method: "POST",
      body: JSON.stringify({ token: claimantToken, address }),
    });
    const res = await postSettlementAddress(req, { params: { id: kase.id } });
    expect(res.status).toBe(200);
  });

  it("rejects with no signature once a signing key is registered for that role", async () => {
    const { kase, claimantToken } = await makeBoundCase(true);
    const address = "0x00000000000000000000000000000000000000C1";
    const req = new NextRequest(`http://test/api/public/cases/${kase.id}/settlement-address`, {
      method: "POST",
      body: JSON.stringify({ token: claimantToken, address }),
    });
    const res = await postSettlementAddress(req, { params: { id: kase.id } });
    expect(res.status).toBe(401);
  });

  it("accepts a valid signature over the exact address once a signing key is registered", async () => {
    const { kase, claimantToken, claimantPrivateKey } = await makeBoundCase(true);
    const address = "0x00000000000000000000000000000000000000C1";
    const message = settlementAddressSigningMessage({ caseId: kase.id, role: "claimant", address });
    const signature = signWithPartyKey(claimantPrivateKey!, message);
    const req = new NextRequest(`http://test/api/public/cases/${kase.id}/settlement-address`, {
      method: "POST",
      body: JSON.stringify({ token: claimantToken, address, signature }),
    });
    const res = await postSettlementAddress(req, { params: { id: kase.id } });
    expect(res.status).toBe(200);
  });

  it("rejects a signature that doesn't match the actual address being set (a compromised token trying to substitute a different address)", async () => {
    const { kase, claimantToken, claimantPrivateKey } = await makeBoundCase(true);
    const signedAddress = "0x00000000000000000000000000000000000000C1";
    const message = settlementAddressSigningMessage({ caseId: kase.id, role: "claimant", address: signedAddress });
    const signature = signWithPartyKey(claimantPrivateKey!, message);

    const substitutedAddress = "0x000000000000000000000000000000000000bad1";
    const req = new NextRequest(`http://test/api/public/cases/${kase.id}/settlement-address`, {
      method: "POST",
      body: JSON.stringify({ token: claimantToken, address: substitutedAddress, signature }),
    });
    const res = await postSettlementAddress(req, { params: { id: kase.id } });
    expect(res.status).toBe(401);
  });
});
