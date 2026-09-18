import evmManifestJson from "../../deployment-manifest.json";
import solanaManifestJson from "../../deployment-manifest.solana.json";
import { verifyManifestHash } from "@/lib/manifest-signature";

// Phase 6: expected SHA-256 of each manifest's canonical JSON, checked
// into source alongside the manifest itself (not inside the JSON file,
// which would make the hash self-referential). Recompute with
// manifest-signature.ts's computeManifestHash() whenever
// scripts/generate-deployment-manifest.ts / generate-solana-deployment-manifest.ts
// regenerate either file, and update these constants in the same commit —
// an unreviewed manifest change without a matching hash update is exactly
// the drift verifyManifestHash() below exists to catch.
// Updated 2026-09-13 alongside deployment-manifest.json's regeneration
// (incident recovery Phase 2, SECOND deploy — external audit fix adding
// chainid/deadline/explicit-target-binding to attestedSettle()'s signed
// digest) — the manifest now reflects 0x56bf62F9F4C2C316D956F9C35DD1B15BE5ae9834,
// replacing the short-lived, never-used first Phase 2 pair
// (0x2d5E63ea...) — see deployment-registry.ts's RETIRED_SEPOLIA_ADDRESSES.
// Updated again 2026-09-13 (same day) after the manifest's owner-not-Safe
// finding was recategorized from `flags` to `knownLimitations` — this
// contract has no ownership-transfer function at all (confirmed by
// reading DecisionRelay.sol), so that finding can never resolve without
// a full redeploy, and putting it in `flags` crash-looped anc-hor-worker
// in production the moment a real boot enforced flags.length === 0. No
// on-chain values changed, only how this one known, permanent fact is
// classified.
// 2026-09-18: updated after regenerating deployment-manifest.json purely
// to refresh its generatedAt timestamp and re-verify live on-chain state
// (no address/attestor/governance values actually changed — see
// docs/incidents/2026-09-18-emergency-refund-recovery.md). Missing this
// update in the same commit as that regeneration is exactly the failure
// mode this file's own doc comment above warns about: it crash-looped
// anc-hor-worker in production (every boot failing closed on
// verifyManifestHash()), silently blocking every adjudication job queued
// after that deploy with no visible error on the case itself — it just
// sat in ADJUDICATING forever since nothing was left running to process
// the job.
const EXPECTED_EVM_MANIFEST_HASH = "c95b1b9d1c40d2a47549788eb8997a0b2da4ca4ff384edec77f8e00d384c6717";
const EXPECTED_SOLANA_MANIFEST_HASH = "4e82dd6c5a4e2bf430151c731f3b1af37d73e5e7afc3e14c2f4a71f614e1f671";

// Phase 1 (signer/settlement/delivery reliability), item 1's "expected
// deployment manifest": a COMMITTED file, imported at build time, never
// fetched live. Real design tradeoff, stated rather than hidden: a
// startup check against a stale committed manifest can pass even when
// live on-chain state has since drifted (an attestor rotated out via a
// Safe tx that hasn't been re-synced into deployment-manifest.json
// yet), whereas a live RPC read at every boot would be the "more
// correct" check. The reason this repo chooses the committed file:
// "fail closed on mismatch" must also mean "fail closed, not fail
// OPEN, when RPC happens to be briefly unreachable at boot" — a signer
// process that can't start signing because Sepolia's RPC endpoint is
// having a bad five minutes is a worse operational failure mode than
// one running briefly against a manifest that's a few hours stale.
// The staleness risk is bounded by two things this repo already has:
// scripts/generate-deployment-manifest.ts's own flags[] catching
// governance drift when re-run, and the periodic reconciliation sweep
// (lib/reconciliation.ts) + testnet canary (scripts/testnet-canary.ts)
// independently re-verifying live on-chain state on a tight cadence —
// so drift is caught within minutes even though the startup check
// itself doesn't re-read chain state on every process boot.
export interface EvmDeploymentManifest {
  network: { chain: string; chainId: number; rpcHost: string };
  decisionRelay: {
    address: string;
    owner: string;
    attestorThreshold: string;
    interchainSecurityModule: string;
    attestors: { active: string[]; checkedButInactive: string[] };
  };
  // Genuine governance-drift signals (owner reassigned away from the
  // Safe, threshold exceeding the active attestor set, Safe threshold
  // below 2) — a real, transient, resolvable problem. startup-checks.ts
  // fails closed on these because they mean the deployed relay's
  // governance is in a state this process has no way to reason about
  // safely.
  flags: string[];
  // Static, already-documented, ALREADY-ACCEPTED-for-testnet facts about
  // this deployment (e.g. "Safe is 2-of-2, operator independence
  // unverified" — see docs/multisig-attestor-setup.md) that will never
  // resolve short of a real governance change and were never meant to
  // block a process from starting — they're the reason
  // docs/mainnet-custody-design.md and docs/mainnet-readiness-gate.md
  // exist, not something a signer/worker restart can fix. Distinct from
  // `flags` specifically so a real, permanent, known limitation can
  // never accidentally become a permanent inability to boot at all —
  // that conflation is exactly what took anc-hor-worker and both
  // attestors down in production on 2026-09-09 before this fix.
  knownLimitations: string[];
}

export interface SolanaDeploymentManifest {
  network: { cluster: string; rpcHost: string; genesisHash: string };
  decisionRelay: { attestors: { expected: string[]; threshold: number } };
  flags: string[];
}

export function loadEvmDeploymentManifest(): EvmDeploymentManifest {
  verifyManifestHash(evmManifestJson, EXPECTED_EVM_MANIFEST_HASH);
  return evmManifestJson as EvmDeploymentManifest;
}

export function loadSolanaDeploymentManifest(): SolanaDeploymentManifest {
  verifyManifestHash(solanaManifestJson, EXPECTED_SOLANA_MANIFEST_HASH);
  return solanaManifestJson as SolanaDeploymentManifest;
}
