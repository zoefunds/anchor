import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess, requireScope } from "@/lib/auth";
import { checkEvidenceSubmittable } from "@/lib/evidence-validation";
import { uploadEvidenceFile, deleteEvidenceFile } from "@/lib/storage";
import { canAccessCase } from "@/lib/case-access";
import { extractPdfText } from "@/lib/pdf-extract";
import { logAction } from "@/lib/audit";

// POST /api/cases/:id/evidence/upload — multipart file evidence (images,
// PDFs). The file goes to R2 at a real public URL; for images, the
// GenLayer contract fetches that URL itself (gl.nondet.web.get) and
// passes the actual bytes into exec_prompt as genuine visual input. For
// PDFs, text is extracted HERE at upload time (see lib/pdf-extract.ts)
// and sent to the contract as real evidence content — the contract
// itself has no PDF-parsing capability and can only confirm a bare URL
// is reachable, so extraction has to happen on this side or a PDF's
// actual content never reaches adjudication at all.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;
  const scopeError = requireScope(auth, "evidence:write");
  if (scopeError) return scopeError;

  const kase = await prisma.case.findUnique({
    where: { id: params.id },
    include: { evidence: true },
  });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const form = await req.formData();
  const type = form.get("type");
  const file = form.get("file");
  const submittedBy = form.get("submittedBy");

  if (typeof type !== "string" || !type) {
    return NextResponse.json({ error: "type is required" }, { status: 400 });
  }
  // Duck-typed instead of `instanceof File` — the global `File` isn't
  // reliably present in every Next.js route runtime, but formData() always
  // gives file fields this Blob-like shape regardless.
  const isFileLike =
    typeof file === "object" &&
    file !== null &&
    typeof (file as { arrayBuffer?: unknown }).arrayBuffer === "function";
  if (!isFileLike) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  const uploadedFile = file as unknown as { arrayBuffer(): Promise<ArrayBuffer>; name: string; type: string };

  const submitError = checkEvidenceSubmittable(kase, type);
  if (submitError) return submitError;

  const bytes = Buffer.from(await uploadedFile.arrayBuffer());

  let uploaded;
  try {
    uploaded = await uploadEvidenceFile({
      caseId: kase.id,
      filename: uploadedFile.name,
      mimeType: uploadedFile.type,
      bytes,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }

  // Best-effort: a PDF that fails to parse (encrypted, malformed, a scan
  // with no text layer) still gets uploaded normally, just without
  // extractedText — the contract falls back to its existing
  // reachability-only handling for it, same as before this existed. A
  // parse failure here must never block evidence submission.
  let extractedText: string | null = null;
  if (uploaded.mimeType === "application/pdf") {
    try {
      extractedText = await extractPdfText(bytes);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`PDF text extraction failed for case ${kase.id}:`, err instanceof Error ? err.message : err);
    }
  }

  // Real P1 fixed here (external audit finding, raised twice): this
  // route uploaded the file and inserted the Evidence row with no audit
  // record at all, and no cleanup if the DB write failed after a real
  // upload had already happened. Now: the DB write + audit record are
  // one transaction (matching the pattern already used for inline
  // evidence and case/webhook/api-key creation), and if that
  // transaction fails, the just-uploaded file is best-effort cleaned up
  // rather than left as a silent orphan. attributionSource is always
  // "organization_asserted" here — this is the org-authenticated route,
  // submittedBy (if present) remains only the org's own unverified
  // claim about which party this is from, never trusted as real
  // attribution strength.
  let evidence;
  try {
    evidence = await prisma.$transaction(async (tx) => {
      const created = await tx.evidence.create({
        data: {
          caseId: kase.id,
          type,
          contentHash: uploaded.contentHash,
          storageRef: uploaded.uri,
          mimeType: uploaded.mimeType,
          fileSizeBytes: uploaded.sizeBytes,
          submittedBy: submittedBy === "claimant" || submittedBy === "respondent" ? submittedBy : null,
          attributionSource: "organization_asserted",
          extractedText,
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
          metadata: {
            caseId: kase.id,
            type,
            contentHash: uploaded.contentHash,
            mimeType: uploaded.mimeType,
            fileSizeBytes: uploaded.sizeBytes,
            submittedBy: submittedBy === "claimant" || submittedBy === "respondent" ? submittedBy : null,
            source: "organization",
          },
        },
        tx
      );
      return created;
    });
  } catch (err) {
    await deleteEvidenceFile(uploaded.uri);
    throw err;
  }

  return NextResponse.json(evidence, { status: 201 });
}
