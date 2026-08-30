import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse } from "@/lib/auth";
import { checkEvidenceSubmittable } from "@/lib/evidence-validation";

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

  const kase = await prisma.case.findUnique({
    where: { id: params.id },
    include: { evidence: true },
  });
  if (!kase || kase.organizationId !== auth.organizationId) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const { type, content, submittedBy } = await req.json();
  if (!type || !content) {
    return NextResponse.json({ error: "type and content are required" }, { status: 400 });
  }

  const submitError = checkEvidenceSubmittable(kase, type);
  if (submitError) return submitError;

  const contentHash = createHash("sha256").update(content).digest("hex");

  const evidence = await prisma.evidence.create({
    data: {
      caseId: kase.id,
      type,
      contentHash,
      storageRef: content,
      submittedBy: submittedBy ?? null,
    },
  });

  return NextResponse.json(evidence, { status: 201 });
}
