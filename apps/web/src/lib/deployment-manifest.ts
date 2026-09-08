import evmManifestJson from "../../deployment-manifest.json";
import solanaManifestJson from "../../deployment-manifest.solana.json";

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
  flags: string[];
}

export interface SolanaDeploymentManifest {
  network: { cluster: string; rpcHost: string; genesisHash: string };
  decisionRelay: { attestors: { expected: string[]; threshold: number } };
  flags: string[];
}

export function loadEvmDeploymentManifest(): EvmDeploymentManifest {
  return evmManifestJson as EvmDeploymentManifest;
}

export function loadSolanaDeploymentManifest(): SolanaDeploymentManifest {
  return solanaManifestJson as SolanaDeploymentManifest;
}
