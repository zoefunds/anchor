import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess } from "@/lib/auth";
import { checkEvidenceSubmittable } from "@/lib/evidence-validation";
import { canAccessCase } from "@/lib/case-access";
import { logAction } from "@/lib/audit";

// POST /api/cases/:id/evidence — inline text/JSON evidence (task specs,
// statements, delivery payloads). For images/PDFs, see
// /api/cases/:id/evidence/upload instead — those go to R2, not this
// table's storageRef, since the GenLayer contract fetches file evidence
// itself over the network rather than reading it out of calldata.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;

  const kase = await prisma.case.findUnique({
    where: { id: params.id },
    include: { evidence: true },
  });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const { type, content, submittedBy } = await req.json();
  if (!type || !content) {
    return NextResponse.json({ error: "type and content are required" }, { status: 400 });
  }

  const submitError = checkEvidenceSubmittable(kase, type);
  if (submitError) return submitError;

  const contentHash = createHash("sha256").update(content).digest("hex");

  // Real audit-completeness gap fixed here (external audit finding):
  // evidence submission was never audited at all — a real gap for a
  // security/dispute-relevant mutation. Wrapped in one transaction with
  // the audit write, same pattern as case/webhook/api-key creation
  // elsewhere in this project. Also note in the audit metadata that this
  // is organization-asserted attribution (submittedBy is a caller-
  // supplied string here, not derived from real party auth) — see
  // api/public/cases/:id/evidence/route.ts for the stronger, party-
  // token-derived path.
  const evidence = await prisma.$transaction(async (tx) => {
    const created = await tx.evidence.create({
      data: {
        caseId: kase.id,
        type,
        contentHash,
        storageRef: content,
        submittedBy: submittedBy ?? null,
      },
    });
    await logAction(
      {
        organizationId: auth.organizationId,
        memberId: auth.memberId,
        apiKeyId: auth.apiKeyId,
        action: "evidence.submitted",
        targetType: "evidence",
        targetId: created.id,
        metadata: { caseId: kase.id, type, contentHash, submittedBy: submittedBy ?? null, source: "organization" },
      },
      tx
    );
    return created;
  });

  return NextResponse.json(evidence, { status: 201 });
}
