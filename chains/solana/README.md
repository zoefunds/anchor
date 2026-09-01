# Solana side

## Status: real, deployed, and settling funds on Solana Testnet

Both programs below are deployed to **Solana Testnet** (moved from the
original devnet deployment) and have moved real funds in a real
disputed-escrow test case. See the root `README.md`'s "Live deployment"
section for every current address, and `../../docs/multisig-attestor-setup.md`
for the full M-of-N attestation story that gates real settlement.

## `programs/escrow` — the fund-holding program

An Anchor (framework) program at `825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn`.

Instructions:
- `initialize_case(case_id, respondent, adjudicator, amount_lamports)` —
  claimant deposits the disputed amount (native SOL) into a per-case PDA
  (seeds `["case", case_id]`).
- `raise_dispute()` — either party marks the case disputed (status only;
  no auto-release timeout yet).
- `settle(claimant_share_bps, respondent_share_bps)` — callable only by
  the case's designated `adjudicator` authority, splits the vault per the
  bps values (0–10000, matching `docs/decision-schema.md`'s
  `claimant_share_bps`/`respondent_share_bps` exactly — same units as the
  GenLayer contract, no float anywhere in this chain either).

For real cases, `adjudicator` is `decision-relay`'s own escrow-authority
PDA (`decision_relay_escrow_authority_pda_seeds!()`) — `settle()` can
only ever be reached via that program's `attested_settle` instruction,
never by any keypair that happens to know a case's adjudicator address.

`tests/run-escrow-e2e.ts` proves the full lifecycle against a real
network (not a local validator): deposit → dispute → settle with a
65/35 split, asserting real balance deltas down to the exact lamport.
Run:
```bash
cd chains/solana
npx tsx tests/run-escrow-e2e.ts
```
(Not via `ts-mocha`/`anchor test` — the bundled mocha/yargs breaks under
newer Node's stricter ESM/CJS interop; `tsx` runs the same assertions as
a plain script instead.)

## `programs/decision-relay` — the settlement-gating program

A **native** Solana program (raw `solana_program`, not Anchor — see
below for why) at `DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN`.

- **`DispatchCaseOriginate`** — CPIs into the live Hyperlane Mailbox's
  `OutboxDispatch` instruction to send a `CASE_ORIGINATE` message toward
  Anchor's EVM domain, kicking off GenLayer adjudication.
- **`Handle`** (inbound, via Hyperlane's
  `MessageRecipientInstruction`) — **notification-only**. Verifies the
  Mailbox's process authority per Hyperlane's PDA scheme, decodes the
  `DECISION_RELAY` message, logs it. Does **not** move any funds — see
  the next instruction for why.
- **`AttestedSettle`** — the real fund-moving path, submitted directly
  by Anchor's backend (not via Hyperlane, since this program has no
  control over how the Hyperlane relayer builds its own `process()`
  transaction and therefore can't attach the Ed25519 verify
  instructions this depends on). Requires `ATTESTOR_THRESHOLD`-many
  (currently 2) real, non-redirected Ed25519 signature-verification
  instructions immediately preceding it in the same transaction, from
  distinct keys in `ATTESTOR_PUBKEYS` — verified via Solana instruction
  introspection, matching a message independently recomputed from the
  instruction's own body (never trusting claimed message bytes). Once
  verified, CPIs into `escrow.settle()`, signing as `adjudicator` via
  its own PDA.

### Why `handle()` stopped moving funds

Earlier in this project, `handle()` itself CPI'd into `escrow.settle()`
directly off of Hyperlane delivery alone. A re-audit found this
insufficient: Hyperlane delivery only proves a message came through
whatever ISM was configured (which, before the multisig-ISM work in
`docs/self-hosted-validator-setup.md`, was a permissive placeholder) —
it says nothing about whether the *decision content* is genuine. A
compromised relay/dispatch pipeline could get any settlement accepted.
`AttestedSettle` closes that: real Ed25519 signatures from independently
held attestor keys, over the decision's own content, are what actually
authorize moving funds now — see `docs/multisig-attestor-setup.md`.

### The real forgery vulnerability found and fixed here

Solana's Ed25519 native-program instruction format lets
`signature_instruction_index`/`public_key_instruction_index`/
`message_instruction_index` each independently redirect to a
*different* instruction in the same transaction. A naive parser reading
pubkey/message bytes from the current instruction's own data — without
checking those three indices are all `u16::MAX` (meaning "no
redirection") — is forgeable: an attacker references a real,
genuinely-signed but unrelated instruction for the actual cryptographic
check, while placing forged attestor-pubkey/forged-message bytes at
readable offsets in the *current* instruction for a naive parser to
read instead. Fixed by requiring all three indices equal `u16::MAX`.
Verified via an adversarial regression test that was deliberately
proven meaningful: reverting the fix and confirming the test genuinely
fails, then restoring the fix and confirming it passes (see
`verify_decision_attestation_rejects_cross_instruction_redirection` /
now `parse_valid_ed25519_attestation_rejects_cross_instruction_redirection`
in `programs/decision-relay/src/lib.rs`'s test module).

### Cluster and program binding

The attestation message includes Solana Testnet's real genesis hash
(confirmed live via `getGenesisHash` RPC, not guessed) and the
executing program's own `program_id` — so a signature minted for this
exact deployment on this exact cluster can never be replayed against a
different cluster or a different `decision-relay` deployment of the
same code, even though a program can't query its own genesis hash at
runtime (this is a compile-time tag, defense in depth rather than a
live runtime check).

### Transaction-size limit — a real constraint, worked around

Each Ed25519 verify instruction embeds the full attestation message
inline (Solana's architecture gives no way around this duplication), so
2+ of them plus `AttestedSettle` reliably exceeds Solana's 1232-byte
legacy transaction limit for any realistic case ID. `apps/web/src/lib/solana-settle.ts`
builds a v0 (versioned) transaction against a real Address Lookup Table
(pre-loaded with the static accounts: instructions sysvar, Ed25519
native program, escrow program, `decision-relay`'s own program id, and
its two PDAs) and auto-extends the same table with a decision's
specific claimant/respondent the first time each address is seen.

### Proven live

```bash
npx tsx tests/run-decision-relay-dispatch.ts
```
dispatches a real `CASE_ORIGINATE` message through the actual Hyperlane
Mailbox. A real disputed-escrow case has been settled end-to-end via
`AttestedSettle` with 2-of-2 real attestor signatures (one backend-held,
one held entirely offline by the operator), confirmed via the program's
own log line (`decision-relay: attested-settled case <id>`) and a
correctly-rejected replay attempt against the same case.

### Real findings from building this

1. **Solana-program version must match Hyperlane's workspace pin
   exactly.** A first attempt used `solana-program = "2.3.0"` for the
   program's own direct dependency; Hyperlane's crates pin `=3.0.0`.
   Different major versions of the same crate produce distinct,
   incompatible Rust types (`AccountMeta`, `Pubkey`, etc.) even though
   they look identical — `cargo check` caught this immediately with
   `From<AccountMeta>` not satisfied errors. Fixed by pinning every
   shared dependency (`solana-program`, `borsh`,
   `solana-system-interface`, `solana-instructions-sysvar`) to the
   exact versions in Hyperlane's own `rust/sealevel/Cargo.toml`
   workspace.
2. **`HandleAccountMetas` can only decode the message, not read other
   accounts.** Hyperlane's interface passes exactly one fixed PDA into
   that query — there's no way to read our own storage account to look
   up the escrow program ID at that stage. Fixed by including
   `escrow_program` (and `claimant`/`respondent`) directly in the
   `DecisionRelayBody` message itself, so the account list can be
   derived from the message alone.
3. **A relayer-payer-owned dynamic account in `handle_account_metas`
   caused a real production incident.** Hyperlane's Sealevel relayer
   unconditionally rejects any recipient dynamic account meta whose
   pubkey equals its own payer ("Dynamic account metas contain payer
   account") — every real inbound message simulation failed before a
   transaction was ever attempted. Since `handle()` is notification-only
   now and needs no payer/signer accounts at all, this is structurally
   impossible to hit again — see the regression test
   `handle_account_metas_never_includes_a_signer`.
4. **Real Ed25519 forgery vulnerability** — see "The real forgery
   vulnerability found and fixed here" above.
5. **Transaction-size limit against a real M-of-N transaction** — see
   above; found live while verifying the 2-of-2 upgrade, not
   anticipated in advance.

### Why native Solana, not Anchor

Hyperlane's Sealevel libraries (`hyperlane-sealevel-mailbox`,
`hyperlane-sealevel-message-recipient-interface`, `account-utils`, etc.)
are raw `solana_program` — no Anchor dependency at all — and **not
published to crates.io** (confirmed via `cargo add --dry-run`). Consumed
here via a `git` dependency pinned to a specific commit
(`b58c7eb7275cd61467805f8841d26682118b6f1b`); cargo resolves the sibling
`path = "../.."` deps within their monorepo correctly once the whole
repo is fetched, so this works despite not being a simple `cargo add`.
The Anchor `escrow` program and this native `decision-relay` program
live in the same Cargo workspace (`chains/solana/Cargo.toml`, `members
= ["programs/*"]`) without conflict — Cargo happily resolves both
`anchor-lang`'s and Hyperlane's separately-pinned `solana-program`
versions side by side since they don't share types across a build
boundary.

### Building and testing

```bash
cd chains/solana
cargo build-sbf -p decision-relay          # produces target/deploy/decision_relay.so
cargo test -p decision-relay                # 9 unit tests: attestation parsing/dedup,
                                             # handle_account_metas regression
```

### Redeploying (program upgrade, same program ID)

```bash
solana program deploy \
  --program-id target/deploy/decision_relay-keypair.json \
  --upgrade-authority ~/.config/solana/id.json \
  --keypair ~/.config/solana/id.json \
  --url https://api.testnet.solana.com \
  target/deploy/decision_relay.so
```
If the new binary is larger than the currently allocated program data
account, extend it first (a real step hit during this work):
```bash
solana program extend <PROGRAM_ID> <ADDITIONAL_BYTES> --url https://api.testnet.solana.com --keypair ~/.config/solana/id.json
```

### Not yet done

- **Solana-side M-of-N transport verification (the ISM).** `TRUSTED_ISM`
  (a `TrustedRelayer`-only composite ISM node) still always accepts —
  see `docs/self-hosted-validator-setup.md`'s "Solana side — still
  permissive" section. Narrower exposure than the EVM side had before
  its own fix, since `AttestedSettle` already independently gates real
  fund movement, but not closed.
- **Automated co-signing queue.** `submitAttestedSettle`'s
  `externalAttestations` parameter is proven working, but nothing in
  the automatic dispatch path calls it yet — unlike the EVM side's
  `/api/internal/pending-attestations` API, a real Solana settlement
  today needs the second signature collected manually.
