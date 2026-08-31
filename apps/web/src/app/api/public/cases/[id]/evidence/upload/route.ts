import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePartyAuth, PARTY_SESSION_COOKIE } from "@/lib/party-auth";
import { checkEvidenceSubmittable } from "@/lib/evidence-validation";
import { uploadEvidenceFile } from "@/lib/storage";
import { extractPdfText } from "@/lib/pdf-extract";

// POST /api/public/cases/:id/evidence/upload — multipart file evidence
// (images, PDFs) from a party authenticated by their own per-case token
// (see lib/party-auth.ts), not an org session or API key. Mirrors the
// org-authenticated /api/cases/:id/evidence/upload exactly (same
// storage/extraction pipeline) — without this, a counterparty with only
// a party token could submit text evidence but never the strongest
// evidence types (photos, PDFs, contracts), which meant the org that
// filed the case was effectively the only one who could introduce real
// documentary evidence.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const form = await req.formData();
  const token = form.get("token");
  const type = form.get("type");
  const file = form.get("file");

  const sessionCookie = req.cookies.get(PARTY_SESSION_COOKIE)?.value;
  const resolved = await resolvePartyAuth(sessionCookie, typeof token === "string" ? token : undefined, params.id);
  if (!resolved) {
    return NextResponse.json({ error: "invalid token or session" }, { status: 401 });
  }

  if (typeof type !== "string" || !type) {
    return NextResponse.json({ error: "type is required" }, { status: 400 });
  }
  // Duck-typed instead of `instanceof File` — see the org-authenticated
  // upload route for why.
  const isFileLike =
    typeof file === "object" &&
    file !== null &&
    typeof (file as { arrayBuffer?: unknown }).arrayBuffer === "function";
  if (!isFileLike) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  const uploadedFile = file as unknown as { arrayBuffer(): Promise<ArrayBuffer>; name: string; type: string };

  const kase = await prisma.case.findUnique({
    where: { id: params.id },
    include: { evidence: true },
  });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

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

  let extractedText: string | null = null;
  if (uploaded.mimeType === "application/pdf") {
    try {
      extractedText = await extractPdfText(bytes);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`PDF text extraction failed for case ${kase.id}:`, err instanceof Error ? err.message : err);
    }
  }

  const evidence = await prisma.evidence.create({
    data: {
      caseId: kase.id,
      type,
      contentHash: uploaded.contentHash,
      storageRef: uploaded.url,
      mimeType: uploaded.mimeType,
      fileSizeBytes: uploaded.sizeBytes,
      // Cryptographically derived from the token, not a form field — see
      // the sibling text-evidence route for why this matters.
      submittedBy: resolved.role,
      extractedText,
    },
  });

  return NextResponse.json(evidence, { status: 201 });
}
