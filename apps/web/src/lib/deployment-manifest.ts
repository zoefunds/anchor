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
const EXPECTED_EVM_MANIFEST_HASH = "5116cdc5249607c71269e61c84faf6655ae7e26e51fcb1078b705beaca2fc1bc";
const EXPECTED_SOLANA_MANIFEST_HASH = "93637df98778c03d223cb2258ae4098bbc67d941c0ff5a4a0376cf8c73a440b5";

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
