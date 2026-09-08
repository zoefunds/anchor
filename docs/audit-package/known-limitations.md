# Known limitations

Consolidated, not restated from scratch — this is a pointer index into
gaps already documented elsewhere in this session's work, plus the two
new gaps this track itself found (bytecode verification, compiler
pinning). Treat the linked documents as authoritative; this file exists
so a reviewer doesn't have to know all their names in advance.

## Custody / governance

- Safe is 2-of-2 with only two owners; operator independence between
  them is unverified. See `apps/web/deployment-manifest.json`'s own
  `flags` field and `docs/mainnet-custody-design.md`.
- No real custody of funds exists or has ever existed on this system —
  it is testnet-only by design, not merely by current configuration.

## Signer / validator independence

- See `docs/multisig-attestor-setup.md` for exactly which attestor
  roles are, and are not, run by independently-operated parties today.
- `reliability-monitor.ts`'s `checkValidatorIndependence` is the live,
  automated version of the same check for Hyperlane validators.

## Infrastructure

- RPC providers for Sepolia/Hyperlane reads are free public endpoints
  with no SLA, no dedicated rate limit, and no failover
  (`rpc-provider-risk` check in `reliability-monitor.ts`,
  `docs/mainnet-readiness-runbook.md` §3).
- No multi-provider cross-check exists for on-chain reads — a dishonest
  or compromised single RPC response is currently trusted.
- Validator machine metadata (uptime, restart count, image digest) is
  only available for Fly-hosted validators, and only when
  `FLY_API_TOKEN` is configured — currently reports `unknown` rather
  than a fabricated healthy status when absent.

## Bytecode / compiler verification (found by this track)

- No exact `solc_version`/optimizer settings are pinned in
  `chains/evm/foundry.toml` — see `bytecode-verification.md`.
- No public Etherscan/Sourcify verification exists for any deployed
  contract — see `bytecode-verification.md`.

## Reliability observation window (this track)

- The observation script and its scheduler exist but the scheduler app
  (`fly.reliability-observer.toml`) has not been deployed from this
  environment — see `README.md`'s honest-status section and this
  track's final report for the precise, current state.
- The window's pass/fail rule (`docs/reliability-observation-window.md`)
  treats missed observations as failures rather than gaps, but it
  cannot detect an outage shorter than its own 15-minute tick interval —
  a component that fails and recovers entirely between two ticks leaves
  no trace.

## Regulatory / compliance

- See `docs/regulated-fintech-prerequisites.md` for the full list —
  not restated here.
