import { createHash } from "crypto";
import { v2 as cloudinary } from "cloudinary";

// Evidence files need to end up at a real public URL (not a signed/expiring
// one), because the GenLayer contract fetches them itself via
// gl.nondet.web.get() from inside the network — completely independent of
// this backend, so a Next.js API route or presigned URL with an expiry
// isn't an option. Cloudinary's uploaded asset URLs are public and stable
// by default, which is what makes them usable here.

let configured = false;
function getClient(): typeof cloudinary {
  if (!configured) {
    const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
    const api_key = process.env.CLOUDINARY_API_KEY;
    const api_secret = process.env.CLOUDINARY_API_SECRET;
    if (!cloud_name || !api_key || !api_secret) {
      throw new Error(
        "CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are not set — see apps/web/.env.example"
      );
    }
    cloudinary.config({ cloud_name, api_key, api_secret, secure: true });
    configured = true;
  }
  return cloudinary;
}

// Evidence files are visual/document exhibits (images, PDFs) — not
// arbitrary uploads. Kept intentionally small: this is a dispute-evidence
// pipeline, not a file host, and the GenLayer contract only genuinely
// interprets images (see adjudicator.py's _resolve_evidence) — anything
// larger just sits as an unread audit artifact.
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

export interface UploadedEvidenceFile {
  url: string;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
}

export async function uploadEvidenceFile(params: {
  caseId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<UploadedEvidenceFile> {
  if (!ALLOWED_MIME_TYPES.has(params.mimeType)) {
    throw new Error(`unsupported file type: ${params.mimeType} (allowed: ${[...ALLOWED_MIME_TYPES].join(", ")})`);
  }
  if (params.bytes.length > MAX_FILE_BYTES) {
    throw new Error(`file too large: ${params.bytes.length} bytes (max ${MAX_FILE_BYTES})`);
  }

  const client = getClient();
  const contentHash = createHash("sha256").update(params.bytes).digest("hex");

  // resource_type "auto" lets Cloudinary route images vs PDFs correctly;
  // "raw" would serve a PDF as an octet-stream download link instead of a
  // directly fetchable URL, which is what the contract actually needs.
  const result = await new Promise<{ secure_url: string; bytes: number }>((resolve, reject) => {
    const uploadStream = client.uploader.upload_stream(
      {
        folder: `anchor-evidence/${params.caseId}`,
        resource_type: "auto",
        // Content-addressed public id so an identical re-upload doesn't
        // pile up duplicate assets under Cloudinary's free/shared quota.
        public_id: contentHash,
        overwrite: false,
      },
      (error, uploadResult) => {
        if (error || !uploadResult) {
          reject(error ?? new Error("Cloudinary upload returned no result"));
          return;
        }
        resolve(uploadResult);
      }
    );
    uploadStream.end(params.bytes);
  });

  return {
    url: result.secure_url,
    contentHash,
    mimeType: params.mimeType,
    sizeBytes: params.bytes.length,
  };
}
