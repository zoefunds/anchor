import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess } from "@/lib/auth";
import { checkEvidenceSubmittable } from "@/lib/evidence-validation";
import { uploadEvidenceFile } from "@/lib/storage";

// POST /api/cases/:id/evidence/upload — multipart file evidence (images,
// PDFs). The file goes to R2 at a real public URL; the GenLayer contract
// fetches that URL itself over the network (gl.nondet.web.get) and, for
// images, passes the actual bytes into exec_prompt as genuine visual
// input — no OCR/text-extraction step on our side, the model sees the
// image directly.
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
  if (!kase || kase.organizationId !== auth.organizationId) {
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

  const evidence = await prisma.evidence.create({
    data: {
      caseId: kase.id,
      type,
      contentHash: uploaded.contentHash,
      storageRef: uploaded.url,
      mimeType: uploaded.mimeType,
      fileSizeBytes: uploaded.sizeBytes,
      submittedBy: submittedBy === "claimant" || submittedBy === "respondent" ? submittedBy : null,
    },
  });

  return NextResponse.json(evidence, { status: 201 });
}
