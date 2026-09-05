# Signed live deployment manifest — v2, 2026-09-05

**Environment: Sepolia testnet.** This is a live testnet deployment, not production. Do not represent it as production in customer-facing material — see v1 manifest's own note for the same caveat, restated here since this file is read independently.

Supersedes `docs/deployment-manifest-2026-09-05.md` (kept, unmodified, as the prior signed record — this does not retract it, it extends it). Produced in response to the re-audit's Phase 0, item 4: extends the original manifest with an explicit independence matrix, attestor threshold restated alongside the matrix, and a machine-readable JSON companion (`deployment-manifest-2026-09-05-v2.json`) so the same facts are checkable programmatically, not only by a human reading a table.

Every value below was read directly from the live Sepolia chain or the production database at capture time — nothing here is inferred from source code or prior documentation. `SETTLEMENT_PAUSED` remains `true` throughout; this manifest does not authorize lifting it, and does not itself change any of the facts already recorded in the v1 manifest (contract addresses, bytecode hashes, Safe/ISM/attestor config, active integrations) — those are restated here by reference, not re-verified redundantly in this file. Re-run both the v1 checks and this matrix before relying on either for a real decision, since on-chain and infrastructure state can change between captures.

## Independence matrix (re-audit item, explicit)

The single fact this table exists to make impossible to miss: **every row below shares the same operator.** No component of this system currently has independent custody or independent infrastructure from any other.

| Component | Operator | Cloud account | Provider | Storage/bucket | Signing key custody |
|---|---|---|---|---|---|
| validator1 | Same operator | Same Fly account | Fly.io | `anchor-hyperlane-validator-checkpoints` (shared) | Backend-controlled (`VALIDATOR_KEY` secret on `anc-hor-validator1`) |
| validator2 | Same operator | Same Fly account | Fly.io | `anchor-hyperlane-validator-checkpoints` (shared, same bucket as validator1) | Backend-controlled (`VALIDATOR_KEY` secret on `anc-hor-validator2`) |
| Safe owner 1 (`0x7401c129...`) | Same operator | — | — | — | Operator-held EOA key |
| Safe owner 2 (`0xEDc300fb...`) | Same operator | — | — | — | Operator-held EOA key (documented elsewhere as "held offline," but by the same operator — not a second independent party) |
| Attestor 1 (`0x3261CEF8...`) | Same operator | Same Fly account | Fly.io | — | Backend-held (`ATTESTOR_PRIVATE_KEYS` on `anc-hor-worker`) |
| Attestor 2 (`0x229d46B4...`) | Same operator | — | — | — | Operator-held, offline (same operator, not a second independent party) |
| S3 bucket (both validators' checkpoints) | Same operator | Same AWS account | AWS | `eu-north-1` | — |

**Attestor threshold**: 2-of-2 (both EVM decision/emergency-refund signing and the ISM's validator signature requirement). Restated here because a 2-of-N threshold with every N under one operator provides zero real protection against that operator's own compromise or unavailability — the number "2" only means something once the two are actually independent.

**Net independence claim this system can honestly make today: none.** Every threshold (Safe 2-of-2, ISM 2-of-2, attestors 2-of-2) is currently a single-operator control wearing the shape of a multi-party one. This is the re-audit's Phase 2 gate, unmet.

## Machine-readable companion

See `docs/deployment-manifest-2026-09-05-v2.json` (checked in alongside this file) — the same facts above, structured for programmatic verification rather than a human reading a markdown table.

## Everything else

Contract addresses, bytecode hashes, `DecisionRelay`/`Escrow` wiring, Safe address/threshold, ISM address, active `SettlementIntegration` rows, and alert routing are unchanged from and fully covered by `docs/deployment-manifest-2026-09-05.md` — not duplicated here to avoid two documents drifting out of sync on the same facts.

## Signature

This file's own SHA-256 hash, of the content above this section:
