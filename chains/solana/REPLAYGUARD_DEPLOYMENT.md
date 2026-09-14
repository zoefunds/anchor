# ReplayGuard Testnet deployment procedure

> **2026-09-14: superseded.** Anchor's live Solana deployment moved from
> Testnet to Devnet after a multi-day Testnet cluster halt — see
> `../../docs/incidents/2026-09-14-solana-devnet-migration.md`. Every
> `--url https://api.testnet.solana.com` command below targets a cluster
> Anchor no longer settles on; substitute `https://api.devnet.solana.com`
> (or the live target at the time you're reading this) if repeating any
> of these steps today. Kept as-is below as an accurate historical
> record of what was actually run and verified on 2026-09-02.

Status: **executed on Testnet, 2026-09-02.** Real transaction
signatures and verified on-chain state below. `decision-relay`'s ISM,
attestor set, and Safe governance were untouched by this deployment —
only the program's own executable was upgraded (same program ID, per
how Solana upgrades work) and the new `ReplayGuard` PDA was allocated.

## Real results

| Step | Evidence |
|---|---|
| Program upgrade | tx `5imuwmjnWeT2mCgvEXxbBj9qY76mQjwz3QEdS4teNc3w5c4LbYpjCSicu818JaiD6EfbcD54vxM3ZCuaFbheJFxX` — confirmed via `solana program show`: `Last Deployed In Slot` advanced 436779993 → 437275766 |
| `InitReplayGuard` | tx `4i2Topfj1YWFBduuEK7Js2dc5eYqWJE8U8cZw5WyWPXsfZKziTiBUpEqEeX8EbEbzCZGgRFTDM2AUcDfFtmB34Bo` — PDA `CKriFFG52NBt4bXA1bjspn1viYo1TkswhHttYNyRQj9v`, verified owner = `decision-relay` program, `seen` all-zero, `next_index` 0 |
| Real delivery | Sepolia dispatch tx `0x36973552aa14c6d0d88f59c495a059f1eb83acbf41220e34cc1f943614e73a7c` (message ID `0x2676915c4106fff9acc0d4e79ee096d9c81bac6e919adc0d56e0f28191ae5a9c`), reusing the real GenLayer decision from case `CASE-LIVE-TEST-SOL-1` (decisionHash `0x059c9879d5b415c004f10298997ef897cbd0de6ff4cc0b9e2a2fbfe2ec46bee7`). Solana `process()` tx `2p8zGoiyvrW8xRt5CA2t8PDhmj4UzHVXL5vxEEe3YSnELvxq9yCA7qaR7F4e1irpwEUpfDNVC1RU5xW1b28dsZ4f` — confirmed via `solana confirm -v` (slot 437277513, ReplayGuard PDA present as a writable account). PDA state after: `next_index` 0 → 1, slot 0 = the dispatched decisionHash byte-for-byte. |
| Replay attempt (same decision content, fresh message) | Second Sepolia dispatch tx `0x67762c7dccf50626ccfc38c0d4c209b7125633441e1214e34a0f2f4e85674e70` (message ID `0xb6d6bf41fe994f81684b2dd15f3cc5a7f4ec46beb681088cdb2f091713b9a172`), same decisionHash. **Corrected result, checked with the right tool**: an earlier version of this record said "no `process()` transaction ever appeared" based on `solana transaction-history`, which does not reliably surface failed transactions. Re-checked directly via the raw `getSignaturesForAddress` RPC method (whose `err` field explicitly reports both success and failure) — as of this correction, `decision-relay`'s entire transaction history is 15 signatures, all with `err: null`, and **no new signature at all since the first delivery's `process()` call**. This is a more precise (and different) finding than "rejected on-chain": **the relayer never submitted a `process()` transaction for this message at all** — not a failure, an absence. The ReplayGuard PDA's state remaining unchanged is therefore evidence of "nothing happened yet on this specific message," not evidence of an on-chain rejection. **A genuinely deterministic on-chain rejection proof was not achieved this pass** — doing so would require either the relayer eventually attempting it (not observed despite substantial elapsed time) or manually constructing a real Hyperlane ISM-verified `process()` call outside the relayer, which is out of scope for this pass. The rejection code path itself IS deterministically proven, just not via an on-chain relayer-submitted transaction — see below. |
| Deterministic proof of the rejection logic (not the same as an on-chain relayer transaction) | `cargo test -p decision-relay -- replay_guard_tests::rejects_replay_of_the_same_decision_hash` — a real, passing unit test that exercises the exact same `ReplayGuard::contains()`/`record()` logic `handle()` calls, with a decision hash recorded once and then checked again, asserting it's found and correctly not re-recorded. This is deterministic and real, but it's a direct Rust-level test of the guard's own logic, not proof that a real Hyperlane-relayed `process()` transaction carrying a duplicate decision hash gets rejected end-to-end on live Testnet — that specific, stronger proof remains outstanding. |
| No-escrow-side-effect | Escrow case PDA `njL4rgdzRJvBgt6pr8zw5RPgpSnhxme2NxRtocCdkg8` checked before and after all of the above: `11963230` lamports, owner `825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn` (the escrow program), unchanged data length throughout. No settlement, no fund movement, no state change — confirms `handle()` remained notification-only across both real deliveries attempted in this test. |

**Honest overall verdict**: 2 of 3 required properties are directly,
conclusively proven on-chain (real delivery works; `handle()` never
touches escrow). The third (replay rejection) is **not proven on-chain**
— the relayer never submitted a `process()` transaction for the replay
message at all (confirmed via `getSignaturesForAddress`'s `err` field,
not just an unchanged PDA), so there is no on-chain rejection to point
to, successful or failed. The rejection logic itself is proven
deterministically at the Rust unit-test level
(`rejects_replay_of_the_same_decision_hash`, passing), which is real
evidence the code is correct, but is not equivalent to an end-to-end
on-chain proof. Do not treat this as "replay rejection proven" without
that distinction — it isn't, yet.

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
cargo-build-sbf -- -p decision-relay
```
**Verified live this pass**: this build succeeds and produces a real,
valid `target/deploy/decision_relay.so` (151024 bytes, confirmed
`file`-checked as a valid ELF binary; `cargo test -p decision-relay`
also re-confirmed 12/12 passing including all 3 ReplayGuard tests
immediately before this build). It prints `Error: Function ...
Stack offset ... exceeded max offset` for functions inside the
`hyperlane_core` dependency — not this program's own code — but this
is non-fatal; the build still finishes and the `.so` is real and
usable. (`anchor build --program-name decision-relay`, this doc's
previous suggestion, was never actually confirmed to work — replaced
with the verified command.)

```bash
solana program show <decision-relay-program-id> --url https://api.testnet.solana.com
```
Confirm the `Authority` field matches whoever is about to run the next
command — **not yet executed this pass**, since this project's own
upgrade authority key was not available to this session (see
`docs/production-readiness-hardening-pass.md` for why: two unrelated
secrets were accidentally exposed to this session's own tool output
during an attempt to check for it, prompting a stop rather than
continuing to search for the authority key by inspecting local
secrets — both were flagged for rotation, and the authority key itself
was never found or used).

```bash
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
