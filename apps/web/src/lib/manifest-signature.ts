import { createHash } from "crypto";

// Phase 6, item 2: "production deployment manifest signed and verified
// at startup." Deliberate minimal-viable choice, stated rather than
// hidden: this is a checked-in SHA-256 of each manifest's canonical
// JSON, verified at load — not a full PKI/detached-signature system
// with a separate signing key and certificate chain. That is a real
// scope reduction: it catches accidental drift or tampering of the
// committed file (the same class of risk deployment-manifest.ts's own
// doc comment already discusses for the manifest's content), but it
// does NOT prove who produced the manifest, since anyone with repo
// write access can also regenerate the hash. A real PKI-based scheme
// (signing key held separately from repo-write access, e.g. by whoever
// runs scripts/generate-deployment-manifest.ts in a controlled
// pipeline) is listed as an open item in docs/mainnet-readiness-gate.md
// rather than built here, per this phase's prepare-don't-execute scope.

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeManifestHash(manifest: unknown): string {
  return createHash("sha256").update(canonicalize(manifest)).digest("hex");
}

export class ManifestSignatureError extends Error {}

/** Throws if `manifest`'s canonical-JSON SHA-256 does not match `expectedHash`. Callers use this at load time, fail-closed like every other startup check in this file's sibling startup-checks.ts. */
export function verifyManifestHash(manifest: unknown, expectedHash: string): void {
  const actual = computeManifestHash(manifest);
  if (actual !== expectedHash) {
    throw new ManifestSignatureError(
      `deployment manifest hash mismatch — expected ${expectedHash}, computed ${actual}. The committed manifest file has been modified without updating its recorded hash, or vice versa. Refusing to trust it.`
    );
  }
}
