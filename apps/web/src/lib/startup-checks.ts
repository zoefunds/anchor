import { loadEvmDeploymentManifest, loadSolanaDeploymentManifest } from "@/lib/deployment-manifest";
import { ANCHOR_ENVIRONMENTS, isTestnetEnvironment, type AnchorEnvironmentId } from "@/lib/environment-registry";
import { ACTIVE_SEPOLIA_TOPOLOGY } from "@/lib/deployment-registry";

// Phase 1, item 1: startup checks every signing/worker process runs
// BEFORE it signs or dispatches anything. Every function here either
// returns normally or throws — there is no "warn and continue" path.
// Callers (scripts/auto-attestor-sign*.ts, lib/worker.ts) are expected
// to let the throw propagate to process exit / worker-start failure,
// never catch-and-continue. See lib/deployment-manifest.ts's own doc
// comment for why this checks a COMMITTED manifest, not a live RPC read.

export class StartupCheckError extends Error {}

/**
 * The EVM signer/worker check: this process's configured attestor
 * address must be a registered attestor in the expected manifest, and
 * the manifest itself must carry no unresolved governance-drift flags
 * (see scripts/generate-deployment-manifest.ts's flags[] — e.g. owner
 * reassigned away from the Safe, threshold exceeding active attestors).
 * A flagged manifest means the committed expectation is itself known to
 * be in a bad state, so failing closed on ANY flag — not just ones
 * related to this specific address — is deliberate: a process that
 * signs while the deployed relay's own governance is in a flagged state
 * has no way to know whether the specific mismatch also compromises the
 * property this check exists to protect.
 */
/**
 * Runtime topology enforcement (2026-09-13 remediation plan, item 4):
 * the committed manifest and deployment-registry.ts's ACTIVE_SEPOLIA_TOPOLOGY
 * are two independently-maintained sources of the same facts (the
 * manifest is regenerated FROM the registry, but nothing previously
 * stopped the two files drifting apart after that point — exactly the
 * class of bug this whole incident kept re-discovering by hand, three
 * relay/escrow generations in two days). Purely static (no RPC call,
 * safe and fast to run on every process boot) — this is deliberately
 * NOT the same check as verify-active-topology.ts's live chain reads;
 * it only proves the two COMMITTED sources agree with each other.
 */
export function assertManifestMatchesRegistry(): void {
  const manifest = loadEvmDeploymentManifest();
  const t = ACTIVE_SEPOLIA_TOPOLOGY;
  if (manifest.decisionRelay.address.toLowerCase() !== t.decisionRelay.toLowerCase()) {
    throw new StartupCheckError(
      `committed deployment-manifest.json's DecisionRelay (${manifest.decisionRelay.address}) does not match deployment-registry.ts's ACTIVE_SEPOLIA_TOPOLOGY.decisionRelay (${t.decisionRelay}) — regenerate the manifest (scripts/generate-deployment-manifest.ts) before starting`
    );
  }
  if (manifest.decisionRelay.interchainSecurityModule.toLowerCase() !== t.ism.toLowerCase()) {
    throw new StartupCheckError(
      `committed deployment-manifest.json's ISM (${manifest.decisionRelay.interchainSecurityModule}) does not match the registry's ACTIVE_SEPOLIA_TOPOLOGY.ism (${t.ism}) — refusing to start`
    );
  }
  if (Number(manifest.decisionRelay.attestorThreshold) !== t.attestorThreshold) {
    throw new StartupCheckError(
      `committed deployment-manifest.json's attestorThreshold (${manifest.decisionRelay.attestorThreshold}) does not match the registry's (${t.attestorThreshold}) — refusing to start`
    );
  }
}

export function assertEvmSignerRegistered(signerAddress: string): void {
  assertManifestMatchesRegistry();
  const manifest = loadEvmDeploymentManifest();
  if (manifest.flags.length > 0) {
    throw new StartupCheckError(
      `EVM deployment manifest has unresolved flags — refusing to start: ${manifest.flags.join(" | ")}`
    );
  }
  const active = manifest.decisionRelay.attestors.active.map((a) => a.toLowerCase());
  if (!active.includes(signerAddress.toLowerCase())) {
    throw new StartupCheckError(
      `configured EVM signer address ${signerAddress} is not in the expected deployment manifest's active attestor set (${active.join(", ")}) — refusing to start`
    );
  }
}

/** Solana equivalent of assertEvmSignerRegistered — see deployment-manifest.solana.json's own note on why this can only check against a source-controlled mirror of the Rust program's consts, not a live on-chain read. */
export function assertSolanaSignerRegistered(signerPublicKey: string): void {
  const manifest = loadSolanaDeploymentManifest();
  if (manifest.flags.length > 0) {
    throw new StartupCheckError(
      `Solana deployment manifest has unresolved flags — refusing to start: ${manifest.flags.join(" | ")}`
    );
  }
  if (!manifest.decisionRelay.attestors.expected.includes(signerPublicKey)) {
    throw new StartupCheckError(
      `configured Solana signer public key ${signerPublicKey} is not in the expected deployment manifest's attestor set (${manifest.decisionRelay.attestors.expected.join(", ")}) — refusing to start`
    );
  }
}

/**
 * The worker's own check: it must hold STRICTLY FEWER attestor keys
 * than the deployed threshold on both chains — a worker holding
 * threshold-or-more keys unilaterally could dispatch settlements without
 * ever needing an independent external attestor's signature, defeating
 * the entire point of M-of-N custody being split across separate
 * holders (see docs/multisig-attestor-setup.md). Every held key must
 * also itself be a registered attestor (assertEvmSignerRegistered /
 * assertSolanaSignerRegistered per-key) — a worker holding an
 * unregistered/stale key is a misconfiguration, not a soft warning.
 */
export function assertWorkerKeyCountBelowThreshold(params: {
  evmSignerAddresses: string[];
  solanaSignerPublicKey: string | null;
}): void {
  const evmManifest = loadEvmDeploymentManifest();
  const evmThreshold = Number(evmManifest.decisionRelay.attestorThreshold);
  if (params.evmSignerAddresses.length >= evmThreshold) {
    throw new StartupCheckError(
      `worker holds ${params.evmSignerAddresses.length} EVM attestor key(s), which is >= the deployed threshold (${evmThreshold}) — this worker could unilaterally reach quorum, defeating M-of-N custody separation; refusing to start`
    );
  }
  for (const addr of params.evmSignerAddresses) {
    assertEvmSignerRegistered(addr);
  }

  if (params.solanaSignerPublicKey) {
    const solanaManifest = loadSolanaDeploymentManifest();
    const solanaThreshold = solanaManifest.decisionRelay.attestors.threshold;
    // The worker holds exactly one Solana key by construction (a single
    // SOLANA_ATTESTOR_PRIVATE_KEY env var, not a comma list like the EVM
    // side) — checked as 1 against the threshold rather than a variable
    // count for that reason.
    if (1 >= solanaThreshold) {
      throw new StartupCheckError(
        `Solana attestor threshold (${solanaThreshold}) is <= 1 — the worker's single held key could unilaterally reach quorum; refusing to start`
      );
    }
    assertSolanaSignerRegistered(params.solanaSignerPublicKey);
  }
}

/**
 * Phase 6's single most load-bearing invariant: booting against a
 * non-testnet environment (genlayer-mainnet, ethereum-mainnet,
 * solana-mainnet — see environment-registry.ts) with settlement
 * unpaused must throw, never warn. This is what makes "mainnet
 * defaults always paused" (docs/mainnet-readiness-gate.md, item 2) a
 * real enforced property instead of a config convention someone could
 * silently flip. A testnet environment is exempt by construction —
 * this repo's actual current, intentional mode is live-testnet
 * settlement, which is why studio-next-testnet/sepolia/solana-testnet
 * all carry settlementPaused: false today.
 */
export function assertEnvironmentSafeToBoot(envId: AnchorEnvironmentId): void {
  const env = ANCHOR_ENVIRONMENTS[envId];
  if (!env) {
    throw new StartupCheckError(`unknown Anchor environment id "${envId}" — refusing to start`);
  }
  // Runtime topology enforcement (2026-09-13 remediation plan, item 4):
  // every worker boot, not just attestor signer processes, refuses to
  // start against a stale committed manifest — see
  // assertManifestMatchesRegistry's own doc comment.
  if (envId === "sepolia") assertManifestMatchesRegistry();
  if (isTestnetEnvironment(envId)) return;
  if (env.settlementPaused !== true) {
    throw new StartupCheckError(
      `environment "${envId}" is non-testnet (live=${env.live}) but settlementPaused is not strictly true — ` +
        `refusing to start. Mainnet environments must remain paused until docs/mainnet-readiness-gate.md is satisfied ` +
        `and an operator has explicitly authorized unpausing.`
    );
  }
}
