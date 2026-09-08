# Runbook: key exposure response

**Trigger:** Any suspicion or confirmation that an attestor private key
(`ATTESTOR_PRIVATE_KEY(S)`, `SOLANA_ATTESTOR_PRIVATE_KEY`) or a Safe
owner key has been exposed — committed to git, leaked in a log line,
present on a compromised machine, etc.

This is the highest-priority runbook in this directory. Act on
suspicion; do not wait for confirmation.

## Immediate actions (minutes, not hours)

1. **Do not wait to "confirm" the leak is real** — treat exposure as
   real the moment it's plausible.
2. If it's an **attestor key** (backend automated signer, or one of
   the anc-hor-attestor2/3 keys): the attacker alone cannot move funds
   — `DecisionRelay`'s `attestorThreshold` requires M-of-N (see
   `docs/multisig-attestor-setup.md`), so a single exposed attestor key
   is serious but not immediately catastrophic. Still:
   - Immediately stop the process using that key (`fly machine stop`
     for the affected attestor app, or the worker if it's the backend
     key).
   - Do NOT generate a replacement key and just swap it in-place
     without going through the Safe — the exposed key must be formally
     removed from `DecisionRelay`'s attestor set via a governed
     transaction (see step below), not just stopped from being used.
3. If it's a **Safe owner key**: this can unilaterally (if threshold
   allows, or in combination with one other compromised owner) change
   governance, including `attestorThreshold` and `owner()` itself.
   Escalate as a full incident immediately — this is the scenario
   [safe-governance-config-change.md](safe-governance-config-change.md)'s
   "unexpected drift" path exists to catch if it's already been used.

## Containment

1. Via the Safe (requires the Safe's own threshold of REMAINING
   good owners): call `removeAttestor(exposedAddress)` on
   `DecisionRelay` to revoke the exposed key's signing power on-chain —
   this is the actual fix; stopping the process only stops Anchor's own
   use of it, not an attacker's.
2. Generate a fresh key for the affected role using the same custody
   model documented in `docs/multisig-attestor-setup.md` (env-key,
   process-isolated) — never reuse the exposed key's storage location
   or generation method if that's what led to exposure (e.g. if it was
   committed to git, rotate the entire repo history concern separately
   — see step 4).
3. Add the new key via `addAttestor(newAddress)` through the same Safe
   process, then regenerate `deployment-manifest.json`
   (`npx tsx apps/web/scripts/generate-deployment-manifest.ts`) so
   `assertEvmSignerRegistered`/`assertWorkerKeyCountBelowThreshold`
   reflect the new set — every process using the old key will otherwise
   fail closed at next restart, which is correct, but confirm this is
   understood as expected rather than treated as a fresh incident.
4. If the key was exposed via a git commit: rotating the key is
   necessary but not sufficient — the exposed value stays in history.
   Treat it as permanently public; do not attempt history rewriting as
   a substitute for rotation.

## Recovery verification

- Confirm the exposed address returns `false` from `isAttestor()` on
  `DecisionRelay` (`cast call ... "isAttestor(address)(bool)"
  <exposedAddress>`).
- Confirm `/settings/ops` and the reconciliation sweep show no
  `STALE_PENDING_SIGNATURE` findings caused by the transition (a brief
  dip in available signers during rotation is expected — watch it
  clear within one poll interval of the new key coming online).
- Confirm every attestor-holding process restarted cleanly against the
  new manifest (no `StartupCheckError`).

## Escalation

This runbook IS the escalation path — there is no "handle it quietly"
option for key exposure. Notify whoever holds the other Safe
owner key(s) and anyone with attestor-key custody the moment exposure
is suspected, in parallel with containment, not after.
