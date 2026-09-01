# Anchor's Sepolia contracts

Foundry project. Real, deployed contracts — not scaffolding. See the root
`README.md`'s "Live deployment" section for every current address, and
`../../docs/multisig-attestor-setup.md` / `../../docs/self-hosted-validator-setup.md`
for the full security story behind why these contracts are shaped the
way they are.

## Contracts (`contracts/`)

- **`DecisionRelay.sol`** — receives finalized Anchor decisions relayed
  via Hyperlane from the backend and settles them against a configurable
  settlement target. The real trust boundary: `handle()` requires
  `attestorThreshold`-many distinct, valid ECDSA signatures (verified via
  `ecrecover`) over the decision's own content from a registered
  `isAttestor` set, independent of who dispatched the Hyperlane message
  or which ISM accepted it. `owner` (able to add/remove attestors or
  change the threshold) is a real governance Safe, not a wallet — see
  that contract's own extensive doc comments for the full reasoning,
  including the signature-array size cap (gas-hardening) and the
  governance-change events.
- **`TrustedRelayerIsm.sol`** — a minimal custom ISM whose `verify()`
  always returns `true`. Documented explicitly as a placeholder/MVP
  tradeoff in its own comment — **do not reuse this for anything holding
  real value**. The live `DecisionRelay` deployment no longer uses this;
  it's wired to a real `StaticMerkleRootMultisigIsm` deployed via
  Hyperlane's own canonical factory instead. This file/deploy path is
  kept for local iteration and as the fallback `DeployDecisionRelay.s.sol`
  uses when `CUSTOM_ISM` isn't set.
- **`AuditAnchor.sol`** — a minimal contract storing, per organization,
  the latest hash of its audit-log chain and when it was anchored.
  `onlyOwner`-gated `anchor()`. Explicitly documented as NOT defending
  against a fully malicious operator who controls both the database and
  this contract's key (same operator today) — only accidental
  corruption / partial compromise, and gives external auditors an
  independently-checkable record.
- **`SolanaCaseReceiver.sol`** — the EVM-side receiver for
  `CASE_ORIGINATE` messages dispatched from Solana (the reverse
  direction: a dispute raised on Solana, carried to Sepolia).

## Deploy scripts (`deploy/`)

- **`DeployDecisionRelay.s.sol`** — deploys `DecisionRelay`. Required env:
  `HYPERLANE_MAILBOX`, `GOVERNANCE_OWNER`, `ATTESTOR_ADDRESSES`
  (comma-separated), `ATTESTOR_THRESHOLD`. Optional: `CUSTOM_ISM` — pass
  an already-deployed ISM address (e.g. a real multisig ISM) to use it
  instead of deploying a fresh `TrustedRelayerIsm`.
  ```bash
  forge script deploy/DeployDecisionRelay.s.sol --rpc-url sepolia --broadcast --private-key $PRIVATE_KEY
  ```
- **`DeployAuditAnchor.s.sol`** — deploys `AuditAnchor`, owned by the
  broadcasting key.
- **`DeploySolanaCaseReceiver.s.sol`** — deploys `SolanaCaseReceiver`.

## Tests (`test/`)

- **`DecisionRelay.t.sol`** — 26 tests covering the M-of-N attestation
  logic specifically (threshold met/not-met, duplicate-signature
  dedup, mixed valid/invalid signers, wrong-content rejection,
  oversized-array rejection) plus governance admin functions
  (add/remove attestor, change threshold, all with event-emission
  checks) and the original settlement/idempotency guarantees.
- **`AuditAnchor.t.sol`** — 7 tests: ownership, per-org hash isolation,
  overwrite behavior, access control, owner rotation, event emission.
- **`TrustedRelayerIsm.t.sol`** — 2 tests confirming the placeholder
  ISM's `moduleType()`/`verify()` behavior (the real fix for a genuine
  Sepolia delivery bug found early in this project — see git history
  around `TrustedRelayerIsm.moduleType()` returning `UNUSED` instead of
  `Null`).

Run all of them:
```bash
forge test
```

## Standard Foundry usage

```bash
forge build              # compile
forge test                # run tests
forge fmt                 # format
forge snapshot             # gas snapshots
cast <subcommand>          # interact with deployed contracts / chain data
anvil                      # local Ethereum node
```

Full Foundry documentation: https://book.getfoundry.sh/
