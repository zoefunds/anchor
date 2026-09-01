# ReplayGuard Testnet deployment procedure

Status: **procedure only — not executed.** Per the brief this responds
to: "stop before production deployment and report the exact transaction
signatures/results for review." Nothing below has been run against
Testnet or any live program. `decision-relay`'s program ID, ISM,
attestor set, and Safe governance are untouched by this document.

## Scope guardrail

This deploys a **program upgrade** to `decision-relay` (same program ID —
Solana program upgrades replace the executable, not the address) that
adds the `ReplayGuard` account and its `handle()`/`required_handle_account_metas()`
integration already implemented and tested (12/12 `cargo test -p
decision-relay` passing — see git history). It does **not**:
- change `attested_settle`, the Ed25519 2-of-2 attestation path, or any
  fund-moving logic,
- touch the Solana ISM (`TRUSTED_ISM` stays exactly as-is — see
  `ISM_MIGRATION.md`, unrelated to this),
- change the EVM Safe, attestor set, or threshold.

## Procedure

### 1. Upgrade the program
```bash
cd chains/solana
anchor build --program-name decision-relay   # or the project's real build command — confirm against chains/solana/README.md before running
solana program deploy \
  --program-id <decision-relay-program-id> \
  target/deploy/decision_relay.so \
  --url https://api.testnet.solana.com \
  --keypair <upgrade-authority-keypair>
```
Record: the deploy transaction signature, and the resulting program's
on-chain hash (`solana program show <program-id> --url
https://api.testnet.solana.com` — compare `Last Deployed In Slot` and
the program data hash against the freshly built `.so`, not just "the
command exited 0").

### 2. Call `InitReplayGuard`
A normal payer-funded instruction (see `lib.rs`'s `init_replay_guard`
doc comment) — not through Hyperlane, called directly by Anchor's own
backend/operator tooling the same way `Init` already is.
```bash
# Exact invocation depends on this project's existing instruction-building
# tooling (see chains/solana/tests/ for the pattern used to call Init) —
# accounts required: [system_program, payer(signer), replay_guard_pda(writable)]
```
Record: the `InitReplayGuard` transaction signature.

### 3. Verify the ReplayGuard PDA directly
```bash
solana account <replay-guard-pda-address> --url https://api.testnet.solana.com --output json
```
Confirm, from the raw account data (not just "the call succeeded"):
- **Owner**: `decision-relay`'s program ID (not System Program — proves
  `create_pda_account` actually assigned ownership, not just funded the
  account).
- **Size**: exactly `32 * REPLAY_GUARD_CAPACITY + 1` = `1025` bytes (see
  `ReplayGuard::size()`).
- **Initial state**: deserialize the account data as `ReplayGuard`
  (Borsh) and confirm `seen` is all-zero and `next_index == 0` — proves
  `ReplayGuard::default()` was actually what got stored, not
  uninitialized memory.

### 4. Confirm `handle_account_metas` includes the fixed PDA, no payer/signer
```bash
# Simulate the HandleAccountMetas query the same way the relayer does —
# see handle_account_metas_never_includes_a_signer's test for the
# expected shape (3 accounts: storage, escrow_program, replay_guard;
# none is_signer).
```
This is also directly covered by the existing unit test — re-running
`cargo test -p decision-relay -- handle_account_metas_tests` against the
newly built program's source (not just trusting the pre-upgrade test run)
is the cheap way to confirm this before spending a real devnet
transaction on it.

### 5. Deliver a real notification through Hyperlane
Dispatch a real `DECISION_RELAY` message from Sepolia targeting this
Testnet `decision-relay` deployment (same pattern
`chains/hyperlane-relay`'s `dispatchDecisionRelayToSealevel` already
uses — see `docs/hyperlane-integration.md`'s "Real Solana settlement
destination" section for the prior proof of this exact path). Record:
the Sepolia dispatch tx hash, the Hyperlane message ID, and the Solana
`process()` transaction signature that ultimately calls `handle()`.

### 6. Verify ReplayGuard state changed
```bash
solana account <replay-guard-pda-address> --url https://api.testnet.solana.com --output json
```
Confirm the dispatched message's `decision_hash` now appears in `seen`
and `next_index` advanced by one from its step-3 value.

### 7. Retry the same notification and prove rejection
Re-dispatch (or replay the same already-delivered message, if Hyperlane's
own `Processed` PDA doesn't block replay at the Mailbox level first —
either outcome is informative) and confirm `handle()` returns an error
this time, and that ReplayGuard's `seen`/`next_index` did **not** change
a second time for the same hash. Record the failed transaction's
signature and logged error.

### 8. Verify `handle()` remains notification-only
After step 7, directly confirm no escrow state changed as a result of
either delivery:
```bash
solana account <escrow-case-pda-address> --url https://api.testnet.solana.com --output json
```
Compare against its state from before step 5 — it must be byte-for-byte
identical. This is the load-bearing invariant the whole ReplayGuard
feature was built not to violate; verifying it directly (not just
trusting the code review) is the actual proof requested.

## What "stop before production" means here

Do not run any step above against Solana mainnet, and do not update
`decision-relay`'s production deployment.json/mainnet program ID with
these results without a separate, explicit go-ahead — this document
covers Testnet only. Report the transaction signatures from steps 1-8
for review before considering any mainnet follow-up.
