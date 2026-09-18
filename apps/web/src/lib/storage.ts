import { createHash } from "crypto";
import { v2 as cloudinary } from "cloudinary";

// Evidence files are uploaded to Cloudinary's `authenticated` delivery
// type (private by default, not just "unlisted") rather than the public
// delivery type this used to use. Anything with a case ID and a content
// hash could previously construct a permanently-valid public URL and
// read the exhibit forever, with zero relationship to Anchor's own
// party-token/org-auth model — a real gap flagged in review.
//
// Genuinely fetchable-only-with-a-signature evidence still has to work
// for GenLayer: the contract fetches the URL itself via
// gl.nondet.web.get() from inside GenVM, completely independent of this
// backend, potentially long after upload (an appeal can re-adjudicate
// days later). A short-lived signed URL that's already expired by then
// would silently break re-adjudication. So instead of a fixed expiry
// baked in at upload time, storageRef stores a stable internal
// reference (see EVIDENCE_URI_PREFIX below), and every caller —
// GenLayer dispatch, the org API, the public API — asks
// getSignedEvidenceUrl() for a freshly signed URL at the moment it
// actually needs one, each with its own appropriate TTL.

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
  /** Stable internal reference stored in Evidence.storageRef — see EVIDENCE_URI_PREFIX. NOT a fetchable URL by itself. */
  uri: string;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
}

/** Marks an Evidence.storageRef value as a Cloudinary reference (uri-encoded `type/publicId`) rather than raw text/URL — see resolveEvidenceUri below for the inverse. */
const EVIDENCE_URI_PREFIX = "cloudinary-authenticated:";

function cloudinaryResourceTypeFor(mimeType: string): "image" | "raw" {
  return mimeType.startsWith("image/") ? "image" : "raw";
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
  const resourceType = cloudinaryResourceTypeFor(params.mimeType);
  const publicId = `anchor-evidence/${params.caseId}/${contentHash}`;

  await new Promise<{ bytes: number }>((resolve, reject) => {
    const uploadStream = client.uploader.upload_stream(
      {
        resource_type: resourceType,
        // "authenticated" — not the default "upload" delivery type — is
        // what actually makes this private: Cloudinary rejects
        // unsigned requests for authenticated assets outright, not just
        // "doesn't advertise the URL."
        type: "authenticated",
        // Content-addressed public id so an identical re-upload doesn't
        // pile up duplicate assets under Cloudinary's free/shared quota.
        public_id: publicId,
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
    uri: `${EVIDENCE_URI_PREFIX}${resourceType}:${publicId}`,
    contentHash,
    mimeType: params.mimeType,
    sizeBytes: params.bytes.length,
  };
}

/**
 * Best-effort deletion of a Cloudinary asset by its Evidence.storageRef —
 * used to clean up an orphaned upload when the DB write that was
 * supposed to record it fails (see api/cases/:id/evidence/upload and
 * api/public/cases/:id/evidence/upload). Never throws: a cleanup
 * failure must not mask the original error that triggered it, and an
 * orphaned Cloudinary asset is a cheap, non-urgent leak (content-
 * addressed public_id means a legitimate retry with the same bytes
 * reuses it rather than duplicating it) — not a correctness problem the
 * caller needs to react to synchronously.
 */
export async function deleteEvidenceFile(storageRef: string): Promise<void> {
  if (!storageRef.startsWith(EVIDENCE_URI_PREFIX)) return; // not a Cloudinary reference — nothing to clean up
  const [resourceType, ...publicIdParts] = storageRef.slice(EVIDENCE_URI_PREFIX.length).split(":");
  const publicId = publicIdParts.join(":");
  try {
    const client = getClient();
    await client.uploader.destroy(publicId, { resource_type: resourceType, type: "authenticated" });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`deleteEvidenceFile: failed to clean up orphaned asset ${storageRef}:`, err instanceof Error ? err.message : err);
  }
}

// Real bug found 2026-09-18: `publicId` (anchor-evidence/<caseId>/<contentHash>,
// see uploadEvidenceFile above) has never carried a file extension, so a
// URL built without an explicit `format` never ends in one either — e.g.
// `https://res.cloudinary.com/.../anchor-evidence/<case>/<hash>`, no
// `.jpg`/`.png` at all. genlayer/contracts/adjudicator.py's `_is_image_url`
// gates the ENTIRE "actually fetch this and hand the model a real image"
// path on `lowered.endswith(IMAGE_EXTENSIONS)` — with no extension, every
// piece of image evidence silently fell through to the generic
// "just confirm the URL is reachable" file branch instead, meaning no
// image evidence was ever genuinely visually evaluated by the contract,
// regardless of upload success. Fixed by deriving the real extension from
// the Evidence row's own stored `mimeType` and passing it as Cloudinary's
// `format` option, so the signed URL this returns actually ends with it.
const MIME_TYPE_TO_IMAGE_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Resolves an Evidence.storageRef into a freshly signed, time-limited
 * Cloudinary URL — the only way to actually fetch an `authenticated`
 * asset. Returns the input unchanged if it isn't a Cloudinary reference
 * (plain text evidence, or a legacy row uploaded before this existed —
 * see the migration note in the PR this shipped in).
 *
 * `expiresInSeconds` should be picked per caller: long for GenLayer
 * dispatch (an appeal can re-fetch evidence days later), short for a
 * dashboard/public-page view (that URL only needs to survive one page
 * load, not sit around in browser history as a standing credential —
 * exactly the property permanently-public URLs didn't have).
 *
 * `mimeType` (the Evidence row's own stored value) is required to produce
 * a URL search image evidence is actually recognized from — see the
 * MIME_TYPE_TO_IMAGE_EXTENSION comment above. Omit only for non-image
 * evidence (PDFs) or legacy rows with no stored mimeType, where no
 * extension-sniffing consumer exists.
 */
export function resolveEvidenceUri(storageRef: string, expiresInSeconds: number, mimeType?: string | null): string {
  if (!storageRef.startsWith(EVIDENCE_URI_PREFIX)) return storageRef;
  const rest = storageRef.slice(EVIDENCE_URI_PREFIX.length);
  const [resourceType, ...publicIdParts] = rest.split(":");
  const publicId = publicIdParts.join(":");

  const format = mimeType ? MIME_TYPE_TO_IMAGE_EXTENSION[mimeType] : undefined;

  const client = getClient();
  return client.url(publicId, {
    resource_type: resourceType,
    type: "authenticated",
    sign_url: true,
    secure: true,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    ...(format ? { format } : {}),
  });
}
