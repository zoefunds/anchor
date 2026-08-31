# Anchor's self-hosted Hyperlane relayer

The shared public Hyperlane testnet4 relayer does not reliably service the
Solana Testnet <-> Sepolia routes Anchor's cross-chain settlement path
depends on — two real dispatched messages sat undelivered for 7+ hours
before this was stood up. This is Anchor's own relayer, scoped to exactly
the chains it needs, plus two real bugs found and fixed along the way (see
Known issues fixed below).

(Solana Devnet support was carried here for a while — proven live once for
CaseOriginate — but was never used for anything real and has since been
removed entirely: `config.json`'s `solanadevnet` chain entry, the
`--relayChains`/`--chains.solanadevnet.*` flags below, and every
`solanadevnet`/`solanaDevnet` reference across `packages/hyperlane-relay`,
`apps/web`, and `chains/solana`'s deploy/dispatch scripts. If you need it
back, `git log` has the removal commit and the working config it reverts.)

**Status: both directions proven live end to end, fully automatic.**
CaseOriginate (Solana -> Sepolia) and DecisionRelay (Sepolia -> Solana) both
now auto-deliver with zero manual trigger. Getting DecisionRelay's
Sepolia -> Solana leg working took three real, independently-confirmed
fixes on top of the two below — see "Known issue, actually fixed" further
down for the full story (a stale relayer image missing `VerifyMetadataSpec`
support, a missing `identity` signer distinct from the payer, and a real
account-ordering bug in decision-relay's own Rust source).

| Test | Origin | Message ID | Destination tx | Delivered by |
|---|---|---|---|---|
| CaseOriginate | Solana Testnet | `0x7ca006278e77c09962ae930f4c3f5f5cbd80dc8234645a66b49cc78c0023d473` | [`0xe7b9b011...`](https://sepolia.etherscan.io/tx/0xe7b9b011c00af0311931ad07e49728d8e6801aa57a9ce18803ba9b25a75119a1) | this relayer |
| DecisionRelay (self) | Sepolia | (reconstructed, id `0xf2d09a34...`) | [`0x5116fdcc...`](https://sepolia.etherscan.io/tx/0x5116fdcc0fdf25b7abb7f596ce61fb90f3b75990bdf9790126f3d2b87348605e) | manual `cast send` (superseded — see below) |
| DecisionRelay | Sepolia | `0x0b1548f36ce39cc223e074af62f3cfa444491b775d62a79603167571c965d155` | Solana tx `0x94ae7a01...` — escrow case `CASE-RELAY-1788120485310` went `Disputed` -> `Settled` | this relayer, fully automatic |

All destination transactions succeeded and the recipient contract
(`SolanaCaseReceiver.handle()` or `DecisionRelay.handle()`) correctly
decoded the message and emitted the expected event — this proves the
recipient/decode/business-logic half genuinely works, independent of
whichever relayer submits the delivery transaction.

**Update (this session): root cause of the same-chain Sepolia→Sepolia
delivery stall found and fixed — real end-to-end delivery confirmed.**
DecisionRelay.sol was first redeployed to
`0xCDfF36cDA76e08BAd2EA0d5a3fDaDf3761Ed5041` with a destination-side
idempotency guard (`processedDecisions[proofHash]`), and a real
dispatched message to it sat undelivered despite every relayer-infra
fix in this file (whitelist, `CONFIG_FILES`, region move, dedicated RPC
key) being individually verified working. The actual cause turned out
to be unrelated to infra: `TrustedRelayerIsm.moduleType()` returned `0`
(`UNUSED`), which `hyperlane-core` documents as `INVALID ISM` and which
the relayer's own metadata builder has no handler for at all
(`agents/relayer/src/msg/metadata/message_builder.rs`) — every attempt
to build metadata for a message routed through this ISM failed
deterministically with `Unknown or invalid module type (Unused)`
(confirmed live in this relayer's own debug logs), so the message was
discovered, whitelisted, and endlessly "reprepared" but a `process()`
transaction was never even attempted. The correct value for an
always-valid, no-metadata ISM like this one is `6`
(`ModuleType::Null`, "no metadata required" — confirmed against the
vendored relayer source). `TrustedRelayerIsm.sol` was fixed and, since
`DecisionRelay.customIsm` is immutable, both contracts were redeployed
together: ISM `0x260DD5edD4F798C70F7dc6FA51f3F630B7FF05B3`, DecisionRelay
`0x4D1275686bB974830f397D43bB8Ae435AAD5a805` (the old
`0xCDfF36...`/`0x831D95e...` pair is permanently stuck for any message
already addressed to it — its ISM is immutable and cannot be patched).
A real decision dispatched through the app's own `dispatchDecisionForCase`
to the new contract was confirmed fully delivered: dispatch tx
`0x2b384a05...`, message ID `0xd63f2e5e...`, relayer `process()` tx
`0xc21095d5...` (status success), `Mailbox.delivered(messageId) ==
true`, `DecisionRelay.processedDecisions(decisionHash) == true`,
`DecisionReceived` emitted.

**This was a same-chain Sepolia→Sepolia test, not a cross-chain one —
it proves message discovery, ISM metadata building, and destination
execution all work, but does not exercise real cross-chain relaying
(different origin/destination domains).** A real Sepolia→Solana or
Sepolia→Base-Sepolia delivery has not been re-proven against the
current contracts (with the idempotency guard and the fixed ISM) this
session; the Sepolia→Solana row in the table above is from an earlier
version of the contracts, before this round's guard/payer/ISM changes.

## What this is

A single `hyperlane-agent` relayer container (`ghcr.io/hyperlane-xyz/hyperlane-agent:agents-v2.3.0`
— see "Known issue, actually fixed" for why not `agents-v2.2.0`), scoped to
two chains via `config.json`:
- `sepolia` (both an origin, for DecisionRelay, and a destination, for CaseOriginate)
- `solanatestnet` (an origin for CaseOriginate, a destination for DecisionRelay)

## Running it

**Production runs on Fly** (`anc-hor-relayer` — see `../../DEPLOYMENT.md`),
not this machine. Don't run the local `docker run` below at the same time
as the Fly deployment — both would sign transactions with the same
private keys, and two relayers racing on the same EVM nonce is a real
failure mode, not just wasted gas. Use the local container for
development/debugging only, stopped when you're done.

```bash
cd chains/hyperlane-relayer
docker run -d --name anchor-hyperlane-relayer \
  --restart unless-stopped \
  --platform linux/amd64 \
  -e CONFIG_FILES=/config/config.json \
  -v "$(pwd)/config.json:/config/config.json:ro" \
  -v "$(pwd)/db:/data" \
  ghcr.io/hyperlane-xyz/hyperlane-agent:agents-v2.3.0 \
  ./relayer \
  --db /data \
  --relayChains solanatestnet,sepolia \
  --defaultSigner.key "$RELAYER_EVM_PRIVATE_KEY" \
  --chains.solanatestnet.signer.type hexKey \
  --chains.solanatestnet.signer.key "$RELAYER_SOLANA_SEED_HEX" \
  --chains.solanatestnet.identity.type hexKey \
  --chains.solanatestnet.identity.key "$RELAYER_SOLANA_IDENTITY_SEED_HEX" \
  --allowLocalCheckpointSyncers true
```

`RELAYER_EVM_PRIVATE_KEY` needs Sepolia ETH to pay gas for `process()`
transactions on EVM destinations — the same funded key used to deploy
`SolanaCaseReceiver`/`DecisionRelay` (see `chains/evm/`).
`RELAYER_SOLANA_SEED_HEX` is the 32-byte ed25519 seed (hex-encoded, first
32 bytes of a standard `~/.config/solana/id.json` array) for a funded
Solana account. **Both are required** — the relayer needs its own signer
per destination-chain *protocol* family (EVM vs. Sealevel), not one key
overall. Without the Solana signer, delivery to any Sealevel destination
silently stalls with no clear top-level error (see Known issues fixed).

`RELAYER_SOLANA_IDENTITY_SEED_HEX` is a **second, distinct** Solana
seed — only needed on `solanatestnet` here because that's the chain whose
`decision-relay` recipient uses a `TrustedRelayer`-based ISM (see "Known
issue, actually fixed"). It must differ from `RELAYER_SOLANA_SEED_HEX` (the
payer): the relayer treats `identity == payer` as "no identity configured"
and won't drive `TrustedRelayer` checks at all in that case. The identity
key's pubkey must match whatever the ISM was configured to trust — doesn't
need its own funding, since it only co-signs, never pays fees.

`--restart unless-stopped` keeps it running across host reboots — this is
meant to be long-lived infrastructure, not a one-shot script. Check status
with `docker logs anchor-hyperlane-relayer` / `docker ps`.

## Known issues fixed

**1. Sepolia's default recipient ISM is unreachable for a self-hosted
single-relayer setup.** Any recipient that doesn't override
`interchainSecurityModule()` falls back to the Mailbox's default, which on
Sepolia is a 2-of-2 aggregation ISM (`modulesAndThreshold()` confirmed
live via `cast call`) requiring independent checkpoints from two separate
canonical validator sets. Our relayer could only assemble metadata for
one of the two — a real dispatched message stayed permanently
undeliverable through no fault of the dispatch. **Fix**: `DecisionRelay.sol`
now overrides `interchainSecurityModule()` to point at
`TrustedRelayerIsm.sol`, a minimal custom ISM whose `verify()` always
returns true. This is the standard Hyperlane pattern (a recipient chooses
its own ISM rather than depending on the chain default forever), but read
the security tradeoff comment in `TrustedRelayerIsm.sol` before reusing
this for anything holding real value — it performs no cryptographic
origin-authenticity check at all, appropriate only because Anchor
currently controls both the sole dispatcher and the sole relayer for
these messages.

**2. decision-relay's Solana program never returned data for the
`InterchainSecurityModule` query.** The handler in
`programs/decision-relay/src/lib.rs` used to just return `Ok(())` to mean
"use the Mailbox's default ISM." Per Hyperlane's own Sealevel interface
(confirmed against the reference `test-send-receiver` program's
`get_interchain_security_module` and the real error message this
produced: `"No return data from InboxGetRecipientIsm instruction"`),
that intent must be communicated by explicitly
`set_return_data(&borsh::to_vec(&Option::<Pubkey>::None))`. **Fix**:
implemented and redeployed (same program ID, upgraded in place); verified
correct via a direct `simulateTransaction` against the live program,
which now returns `AA==` (base64 for a single `0x00` byte, the correct
Borsh encoding of `None`).

**3. The relayer needs a per-protocol-family signer.** `--defaultSigner.key`
alone (an EVM hex key) silently doesn't cover Sealevel destinations — the
relayer needs `--chains.<solana-chain>.signer.type hexKey` +
`.signer.key` separately. Without it, messages sit indefinitely at
"checking delivered? false" with no error, easy to mistake for an
ISM/metadata problem (which is what issues #1/#2 above actually were,
found first). Fixed by adding the flags shown above.

## Known issue, actually fixed — Sepolia → Solana auto-delivery

This took three layered, independently-confirmed fixes to actually resolve
— each one was verified necessary by hitting the *next* failure only after
fixing the one before it, not assumed from reading source.

**Symptom, initially:** the relayer's own automatic delivery of
Sepolia-origin messages to a Solana destination logged
`Could not fetch metadata: Unable to reach quorum` — the default ISM for
that route is a multisig ISM (`config.json`'s
`solanatestnet.interchainSecurityModule`) requiring a validator checkpoint
Anchor doesn't publish (no validator agent run for this route). Swapping
the Sepolia RPC endpoint list (see below) didn't touch this — it was never
an RPC problem.

**Fix attempt, first pass — deploy a TrustedRelayer ISM.** Deployed
`hyperlane-sealevel-composite-ism` (a real, tested Hyperlane program, not
written from scratch — `rust/sealevel/programs/ism/composite-ism` in the
pinned monorepo rev) to Solana Testnet at
`PNMVXEfSvLYhF917ViQTSTf4MVmVjXs7zrVBNe2mfus`, initialized with root node
`IsmNode::TrustedRelayer { relayer: <our relayer's Solana signer pubkey> }`
(`chains/solana/tests/init-composite-ism.ts`), and pointed decision-relay's
`InterchainSecurityModule` query at it instead of the default. Confirmed
correct via direct `simulateTransaction`. Result: still silent stall, no
progress past `delivered()` checks — a *different* failure mode than the
quorum error, so genuine progress, but not a fix yet.

**Root cause #1 — the relayer image predates this ISM protocol.** Cloned
the actual `agents-v2.2.0` tag of `hyperlane-xyz/hyperlane-monorepo` (the
rev our Docker image, `ghcr.io/hyperlane-xyz/hyperlane-agent:agents-v2.2.0`,
was built from) and checked directly: `rust/sealevel/programs/ism/` there
has only `multisig-ism-message-id` and `test-ism` — `composite-ism` and
`VerifyMetadataSpec` don't exist at that rev at all. The relayer's metadata
builder at that version dispatches purely on the fixed `ModuleType` enum;
there's no code path for the newer fixpoint protocol at all, which is why
it stalled silently instead of erroring. Checked the next tag,
`agents-v2.3.0`: `composite-ism` is present, and its relayer source has a
dedicated `msg/metadata/sealevel_composite.rs` builder that actually drives
`VerifyMetadataSpec`. **Fix**: pulled and switched to
`ghcr.io/hyperlane-xyz/hyperlane-agent:agents-v2.3.0`.

**Root cause #2 — `TrustedRelayer` needs a distinct `identity` key, not
just `signer`.** Under `agents-v2.3.0`, delivery progressed further (the
composite ISM's `Verify` genuinely ran) but then failed with
`Dry-run simulation failed... Dynamic account metas contain payer account`.
Traced into `chains/hyperlane-sealevel/src/composite_ism.rs`:
`trusted_relayer_pubkey()` returns `None` — meaning "no identity
configured" — whenever the configured `identity` key equals the `signer`
(payer) key, or `identity` isn't set at all; we only ever set `.signer`.
Worse, our test data happened to reuse the exact same key as both the
relayer's payer *and* the escrow case's "claimant" pubkey, which the
relayer's dynamic-account sanitizer correctly rejects (a program shouldn't
be able to make the relayer's own payer account show up as an arbitrary
message-defined account). **Fix**: generated a second, distinct Solana
keypair, updated the composite ISM's config to trust its pubkey
(`UpdateConfig` instruction, not a redeploy), passed it via
`--chains.solanatestnet.identity.type hexKey --chains.solanatestnet.identity.key`,
and fixed `chains/solana/tests/run-create-case-for-relay-test.ts` to use a
genuinely separate claimant keypair instead of reusing the wallet.

**Root cause #3 — a real bug in decision-relay's own Rust source.** With
both of the above fixed, delivery progressed to actually invoking
decision-relay's `handle()` — which then failed on-chain with
`invalid program argument`. Comparing `handle()`'s expected account order
against what `handle_account_metas()` (the function that tells the relayer
which accounts to pass) actually returned: `handle_account_metas()` was
missing the `escrow_program` account entirely, silently shifting every
account after it by one slot. This was a genuine bug in
`chains/solana/programs/decision-relay/src/lib.rs`, unrelated to any of the
Hyperlane-side issues above — it just hadn't been reachable until the ISM
and identity-key problems were out of the way. **Fix**: added the missing
account, rebuilt, redeployed in place.

**Result, proven live:** a fresh DecisionRelay dispatch
(message `0x0b1548f3...`) was picked up, verified, and delivered by this
relayer with zero manual intervention — Solana tx `0x94ae7a01...`, and the
target escrow case (`CASE-RELAY-1788120485310`) genuinely transitioned
`Disputed` -> `Settled` on-chain. See the table at the top of this doc.

The Sepolia RPC endpoint list (`chains.sepolia.rpcUrls` above) was also
swapped for a more reliable set earlier in this investigation (dropped
`gateway.tenderly.co/public/sepolia` and `1rpc.io/sepolia`, both confirmed
dead via direct `eth_blockNumber` curl tests; added
`sepolia.gateway.tenderly.co` and `sepolia.rpc.thirdweb.com`, both confirmed
responsive) — unrelated to the three fixes above, but worth keeping.

## Recipient whitelist

`entrypoint.sh` passes `--whitelist`, restricting the relayer to
messages addressed to the two contracts this deployment actually
cares about (DecisionRelay on Sepolia, decision-relay on Solana
Testnet). Without it, the relayer's sequence-aware sync walks and
retries EVERY historical dispatched message on these chains forever —
including old ones sent to a recipient whose default ISM is a 2-of-2
aggregation multisig this self-hosted relayer can only ever produce 1
of 2 checkpoints for (permanently undeliverable, not just slow).
Observed live: without the whitelist, the relayer spent all its time
on "Aggregation threshold not met (2)" retries for old, unrelated
message IDs and never got a turn at a genuinely new, deliverable one.
Add new recipient/domain pairs here if this relayer ever needs to
service another contract.

## Known key-format gotcha

`--defaultSigner.key` / `--chains.*.signer.key` / `--chains.*.identity.key`
silently break for ANY hex value with no `0x` prefix that happens to
contain a literal `0` character — the key parser tries base58 before
hex, and base58 deliberately excludes `0`/`O`/`I`/`l` to avoid visual
ambiguity, so a bare hex string with an early `0` fails with a
"provided string contained invalid character '0'" error that reads
like the key itself is malformed. It isn't — it's a hex/base58 parsing
ambiguity in the relayer's own key parser. `entrypoint.sh`'s `hexify()`
helper prefixes every hex-key value with `0x` before passing it,
regardless of how the underlying Fly secret is stored, so this can't
recur here — but it's worth knowing if you're ever passing a raw hex
key to this binary some other way (a one-off `docker run`, a different
deployment).

## Chain configs

`config.json`'s `sepolia`/`solanatestnet` entries are copied verbatim from
Hyperlane's own agent config
(`rust/main/config/testnet_config.json` in `hyperlane-xyz/hyperlane-monorepo`) —
not hand-typed.

`sepolia.index.from` is set to a recent block (not 0) — indexing the
entire chain history isn't needed and the destination chain has real
transaction volume, unlike the young Solana Testnet mailbox.

## Verifying it's still working

```bash
docker logs anchor-hyperlane-relayer --tail 50
```

Or query the Hyperlane explorer for a specific message:

```bash
curl -s 'https://explorer4.hasura.app/v1/graphql' \
  -H 'Content-Type: application/json' \
  -d '{"query":"query { message_view(where: {msg_id: {_eq: \"<0x...>\"}}) { is_delivered destination_tx_hash } }"}'
```

Or check delivery directly against the destination Mailbox, independent
of the explorer's own indexing lag:

```bash
cast call <mailbox> "delivered(bytes32)(bool)" <messageId> --rpc-url <rpc>
```
