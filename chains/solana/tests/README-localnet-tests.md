# decision-relay localnet E2E suite

Exercises the real on-chain Ed25519/quorum logic in `attested_settle`
(`chains/solana/programs/decision-relay/src/lib.rs`) against a local
`solana-test-validator`, using throwaway attestor keys instead of the
real production `ATTESTOR_PUBKEYS`.

## Why a separate build

The real deployed `decision-relay` program's `ATTESTOR_PUBKEYS` are the
actual production Solana attestation keys (2 automated Fly-hosted
signers + 1 backend key). Testing the quorum logic for real needs
signatures from all 3, which must never leave their custody signing
services. Instead, `ATTESTOR_PUBKEYS`/`ATTESTOR_THRESHOLD` are gated:

```rust
#[cfg(not(feature = "test-attestors"))]
const ATTESTOR_PUBKEYS: [Pubkey; 3] = [ /* real production keys, unchanged */ ];

#[cfg(feature = "test-attestors")]
const ATTESTOR_PUBKEYS: [Pubkey; 3] = [ /* throwaway localnet-only keys */ ];
```

- Default build (no feature, `cargo-build-sbf -- -p decision-relay`):
  identical logic/keys to what's deployed today. Confirmed by comparing
  `target/deploy/decision_relay.so`'s hash before and after adding the
  `test-attestors` feature — the only bytes that differ are embedded
  panic-location line numbers (Rust bakes `file:line` into panic
  metadata, and this edit shifted later lines by a fixed offset); no
  instruction/logic bytes changed. Not byte-for-byte identical in the
  strict sense, but provably not a logic/key change.
- Test build: `cargo-build-sbf --features test-attestors -- -p decision-relay`
  swaps in the keys under `fixtures/localnet-test-attestors/`.

The real deployed program on Solana Testnet was never rebuilt or
touched by this work.

## Test attestor keys

`chains/solana/tests/fixtures/localnet-test-attestors/attestor{1,2,3}.json`
— plain `solana-keygen`-format keypairs, generated fresh for this task,
never used anywhere but `solana-test-validator`. Checked in in the
clear (not `*attestor*private*`-style production naming) since they
have zero value outside a local validator.

## Running locally

```bash
cd chains/solana

# 1. build both programs
cargo-build-sbf -- -p decision-relay                      # default keys -> target/deploy/
cargo-build-sbf --features test-attestors -- -p decision-relay
mkdir -p target/deploy-test-attestors
cp target/deploy/decision_relay.so target/deploy-test-attestors/
# (the second build overwrites target/deploy/decision_relay.so in place;
# copy it out before/after rebuilding the default variant if you need both)
cargo-build-sbf -- -p escrow

# 2. start a local validator
solana-test-validator --reset --quiet &
solana config set --url http://127.0.0.1:8899
solana airdrop 50

# 3. deploy (fresh keypairs — never the real testnet program ids)
solana-keygen new --no-bip39-passphrase --outfile target/deploy-test-attestors/decision_relay_localnet-keypair.json
solana program deploy target/deploy/escrow.so --program-id target/deploy/escrow-keypair.json
solana program deploy target/deploy-test-attestors/decision_relay.so \
  --program-id target/deploy-test-attestors/decision_relay_localnet-keypair.json

# 4. run
npx tsx tests/run-decision-relay-localnet-e2e.ts
```

## What's covered on-chain vs. not

`attested_settle` calls into escrow's `settle(claimant_share_bps,
respondent_share_bps)` — there is exactly ONE on-chain settlement code
path, parameterized by a bps split. "Release" (10000/0), "refund"
(0/10000), and "partial" (e.g. 6000/4000) are the same instruction with
different arguments, not distinct code paths — the suite tests all
three as different parameterizations of that one path, which is the
real, honest extent of on-chain distinction that exists.

Covered for real, on real Ed25519 native-program instructions and a
real quorum check:
- 2-of-3 valid attestor signatures settles (release/refund/partial bps
  splits)
- 1-of-3 is rejected (quorum not met)
- the same attestor signing twice does not count as 2 distinct signers
- a real, validly-signed message from a non-registered key does not
  count toward quorum

Not covered here (out of scope for this suite): the Hyperlane
dispatch/handle notification path, `InitReplayGuard`, and the
`no-entrypoint`/direct-Rust unit tests already in `lib.rs`'s own `#[cfg(test)]`
module (run via `cargo test -p decision-relay`) — note one of those
existing unit tests (`count_distinct_registered_signers` around line
~1136) hardcodes `assert_eq!(ATTESTOR_PUBKEYS.len(), 2, ...)`, which is
already stale against the real 3-key/2-threshold production array and
would fail regardless of this task's changes; not touched here since
it's pre-existing and out of this task's scope.
