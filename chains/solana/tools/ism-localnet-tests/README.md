# multisig-ISM localnet scenario tests

Real, repeatable, local coverage for `hyperlane-sealevel-multisig-ism-message-id`
— the program `decision-relay`'s `InterchainSecurityModule` handler now
points at as `REAL_MULTISIG_ISM` (see `chains/solana/ISM_MIGRATION.md` and
`programs/decision-relay/src/lib.rs:80`) — that `ISM_MIGRATION.md`'s own
8-step Testnet proof checklist had never actually had run against it.

## Run

```bash
cd chains/solana
cargo test -p ism-localnet-tests --release
```

No `solana-test-validator`, no deployment, no funded keypair needed — see
"Why not solana-test-validator" below.

## What this proves

Six scenarios, all against the REAL `hyperlane-sealevel-multisig-ism-message-id`
program's real `process_instruction` entrypoint (fetched as a pinned git
dependency from `github.com/hyperlane-xyz/hyperlane-monorepo` at the same
revision `decision-relay` itself pins), using real secp256k1 ECDSA
signatures (Hyperlane's own upstream test fixture keys/signatures,
`multisig_ism::test_data::get_multisig_ism_test_data()` — not invented
here):

| Test | Proves |
|---|---|
| `scenario_1_first_delivery_accepted_with_quorum` | 2-of-3 real validator signatures over the real EVM-compatible checkpoint digest → accepted |
| `scenario_5_quorum_loss_rejected` | 1-of-3 (below threshold) → rejected, `ThresholdNotMet` |
| `scenario_5b_non_validator_signature_does_not_count_toward_quorum` | a real, validly-formed signature from a real key NOT in the registered validator set doesn't count toward quorum |
| `scenario_4_malformed_metadata_rejected` | truncated metadata (signature region not a multiple of 65 bytes) → rejected at parse time, `InvalidMetadata` |
| `scenario_4b_corrupted_signature_bytes_rejected` | a bit-flipped signature (right shape, wrong content) → rejected |
| `scenario_6_recovery_after_quorum_loss_with_sufficient_signatures` | after a genuine quorum-loss rejection, a second call with a different sufficient signature pair succeeds — recovery is just "try again with enough real signatures," no extra state to reset |

All six pass. Real captured output (2026-09-12, `cargo test -p
ism-localnet-tests --release`):

```
running 6 tests
test scenario_4_malformed_metadata_rejected ... ok
test scenario_5_quorum_loss_rejected ... ok
test scenario_6_recovery_after_quorum_loss_with_sufficient_signatures ... ok
test scenario_5b_non_validator_signature_does_not_count_toward_quorum ... ok
test scenario_1_first_delivery_accepted_with_quorum ... ok
test scenario_4b_corrupted_signature_bytes_rejected ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.21s
```
(program log lines around each failure show the real custom error codes:
`0x7` = `ThresholdNotMet`, `0xa` = `InvalidMetadata`, both defined in the
real program's own `error.rs`, not asserted from memory.)

## Why solana-program-test (BanksClient), not solana-test-validator

`run-decision-relay-localnet-e2e.ts` (this repo's existing localnet
pattern, see `../../tests/README-localnet-tests.md`) needs a real
`solana-test-validator` because `attested_settle` depends on the runtime's
own Ed25519 native-program instruction-sysvar introspection over the wire.
The multisig ISM's `Verify` instruction has no such requirement — it's one
instruction whose entire job is "parse this metadata, recover ECDSA
signers, check quorum." Hyperlane's own upstream test suite for this exact
program (`rust/sealevel/programs/ism/multisig-ism-message-id/tests/functional.rs`
in the pinned monorepo checkout) tests it exactly this way:
`solana_program_test::ProgramTest` + `processor!`, which calls the real
`process_instruction` function in-process against a real (simulated) Bank.
This is "the real entrypoint, directly invoked" — not a mock of the
program, only of the network transport around it — and it's dramatically
faster and more repeatable than spinning up a validator for logic that
doesn't touch the network layer at all. `initialize`/`set_validators_and_threshold`
in `tests/multisig_ism_scenarios.rs` are adapted nearly verbatim from that
upstream file (same instruction encoding, same PDA seeds); the six
scenario tests and their negative-case assertions are new — upstream only
tests the single happy path.

## What this does NOT prove

- **No Mailbox `process()` CPI.** This tests the ISM's `Verify` instruction
  directly, not a full `Mailbox::process()` call that itself CPIs into the
  ISM and then into `decision-relay::handle()`. Building that locally needs
  a local Mailbox deployment (Inbox/Outbox PDA init, `Processed`-PDA replay
  state, `ValidatorAnnounce`) wired to a local ISM and a local
  `decision-relay` — real infra, all individually present in this repo's
  dependency tree (`hyperlane-sealevel-mailbox` is already a dependency of
  `decision-relay` itself), but assembling the full chain was out of this
  task's budget. This is `ISM_MIGRATION.md` checklist items 1, 4, 5, and
  6's Mailbox-side half.
- **No "delayed delivery" scenario.** Neither `ISM_MIGRATION.md` nor the
  ISM/Mailbox source define any delay-specific behavior — Hyperlane
  messages are either accepted or rejected by `process()`/`Verify()` at
  whatever time they're submitted; there is no on-chain notion of
  "delayed" distinct from "not yet submitted." Nothing was built for this
  scenario because there is no code path for it to exercise — see
  `ISM_MIGRATION.md` for the full picture of what this migration does and
  doesn't change.
- **No live validator checkpoint inspection** (checklist item 1) — that
  needs the real running Fly-hosted validator agents' own state on
  Testnet, not something a local test can stand in for.

`decision-relay`'s own `ReplayGuard` (its independent recipient-side replay
defense, separate from Hyperlane's own `Processed`-PDA layer) is covered
by its own pre-existing unit tests, not anything in this crate — see
`ISM_MIGRATION.md` checklist item 6 for exactly which tests and their
result.
