# Threat model

Testnet-only system. This threat model covers the settlement/custody
path's design intent — it is not a claim that every listed mitigation
has been independently penetration-tested.

## In scope / defended against

- **Single-signer compromise of the automated settlement path** — 2-of-3
  attestor quorum required before DecisionRelay accepts a settlement
  (`decisionRelay.attestorThreshold` in the manifest); one compromised
  or offline attestor cannot unilaterally settle or block settlement
  (short of a stale-signing SLA breach, which is detected — see
  `STALE_PENDING_SIGNATURE` reconciliation findings).
- **Replay of a decision** — `DecisionRelay.processedDecisions(proofHash)`
  is checked before settlement; a message cannot be replayed to settle
  twice.
- **Escrow ABI drift / redeploy-at-same-address** — `ESCROW_VERSION_MISMATCH`
  reconciliation findings probe live ABI shape against the recorded
  `escrowVersion`, failing closed (refusing to decode with a possibly-wrong
  ABI) rather than guessing.
- **Silent DB/chain drift** — `DISPATCHED_BUT_DB_STALE` and
  `GOVERNANCE_DRIFT` findings catch the database's record of settlement
  state, or of DecisionRelay's own governance config, silently diverging
  from live on-chain truth.
- **Undetected settlement-path outage** — the automated testnet canary
  (`scripts/testnet-canary.ts`) and the broader reliability observation
  window (`docs/reliability-observation-window.md`) exist specifically
  so "the automated signing/settlement/delivery path stopped working" is
  a detected, alerted, and durably recorded event, not something only
  discovered when a real case gets stuck.
- **Unacknowledged critical operational findings going unnoticed** — the
  auto-escalation cadence on `ReconciliationFinding` and this track's
  reliability-window unacknowledged-critical-finding fail condition both
  exist to prevent a critical finding from sitting open, alerted, but
  ignored indefinitely.

## Explicitly out of scope / not defended against today

- **Collusion between the Safe's two owners** — a 2-of-2 Safe with
  colluding (or coerced) owners can move governance however they choose.
  No mitigation beyond organizational trust exists today. See
  `topology.md` and `known-limitations.md`.
- **Compromise of the RPC provider(s)** used for on-chain reads — no
  multi-provider cross-check exists; a dishonest or compromised RPC
  response is currently trusted at face value by every check that
  depends on it (manifest generation, reliability sweep, canary).
- **Malicious GenLayer adjudicator output** — this package does not
  cover GenLayer intelligent-contract adjudication logic's own
  correctness/security; see `genlayer/contracts` and its own test
  coverage for that surface, which is a separate concern from the
  settlement/custody path this document focuses on.
- **Real-money custody risk of any kind** — out of scope by
  construction, since this system is testnet-only and has never
  custodied real value. See `docs/mainnet-custody-design.md` and
  `docs/mainnet-readiness-gate.md` for what would need to be true before
  that changes.
- **Physical/host-level compromise of validator or attestor machines** —
  `checkValidatorIndependence`/`checkValidatorMachineMetadata` in
  `reliability-monitor.ts` verify operator/account/provider diversity
  and (where `FLY_API_TOKEN` is configured) basic machine state, but do
  not constitute a security audit of any individual host.

## Residual risk explicitly flagged elsewhere and not restated in full here

- `docs/mainnet-readiness-gate.md` — the full list of items required
  before any mainnet consideration.
- `docs/regulated-fintech-prerequisites.md` — regulatory/compliance gaps.
