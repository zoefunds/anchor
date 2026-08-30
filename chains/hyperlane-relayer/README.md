# Anchor's self-hosted Hyperlane relayer

The shared public Hyperlane testnet4 relayer does not reliably service the
Solana Testnet/Devnet <-> Sepolia routes Anchor's cross-chain settlement
path depends on — two real dispatched messages sat undelivered for 7+
hours before this was stood up. This is Anchor's own relayer, scoped to
exactly the chains it needs, plus two real bugs found and fixed along the
way (see Known issues fixed below).

**Status: CaseOriginate (Solana -> Sepolia) proven live end to end.**
DecisionRelay (Sepolia -> \*) dispatch is proven and one real delivery has
been proven manually; automatic delivery via this relayer for
Sepolia-origin messages is still unreliable (see Known issues below) even
after fixing the two root causes we could actually fix ourselves.

| Test | Origin | Message ID | Destination tx | Delivered by |
|---|---|---|---|---|
| CaseOriginate | Solana Testnet | `0x7ca006278e77c09962ae930f4c3f5f5cbd80dc8234645a66b49cc78c0023d473` | [`0xe7b9b011...`](https://sepolia.etherscan.io/tx/0xe7b9b011c00af0311931ad07e49728d8e6801aa57a9ce18803ba9b25a75119a1) | this relayer |
| CaseOriginate | Solana Devnet | `0xf77581accc03d17fd3ea76bcbd3ed16d336566310fe31a863a961fb21350e252` | [`0x4ef81e79...`](https://sepolia.etherscan.io/tx/0x4ef81e7972309147aef11687eb2fb2204b18c32d672bceb9e0247b1941bbd1a6) | this relayer |
| DecisionRelay (self) | Sepolia | (reconstructed, id `0xf2d09a34...`) | [`0x5116fdcc...`](https://sepolia.etherscan.io/tx/0x5116fdcc0fdf25b7abb7f596ce61fb90f3b75990bdf9790126f3d2b87348605e) | manual `cast send` (see below) |

All three destination transactions succeeded and the recipient contract
(`SolanaCaseReceiver.handle()` or `DecisionRelay.handle()`) correctly
decoded the message and emitted the expected event — this proves the
recipient/decode/business-logic half genuinely works, independent of
whichever relayer submits the delivery transaction.

## What this is

A single `hyperlane-agent` relayer container (`ghcr.io/hyperlane-xyz/hyperlane-agent:agents-v2.2.0`),
scoped to three chains via `config.json`:
- `sepolia` (both an origin, for DecisionRelay, and a destination, for CaseOriginate)
- `solanatestnet`, `solanadevnet` (origins for CaseOriginate, destinations for DecisionRelay)

## Running it

```bash
cd chains/hyperlane-relayer
docker run -d --name anchor-hyperlane-relayer \
  --restart unless-stopped \
  --platform linux/amd64 \
  -e CONFIG_FILES=/config/config.json \
  -v "$(pwd)/config.json:/config/config.json:ro" \
  -v "$(pwd)/db:/data" \
  ghcr.io/hyperlane-xyz/hyperlane-agent:agents-v2.2.0 \
  ./relayer \
  --db /data \
  --relayChains solanatestnet,solanadevnet,sepolia \
  --defaultSigner.key "$RELAYER_EVM_PRIVATE_KEY" \
  --chains.solanatestnet.signer.type hexKey \
  --chains.solanatestnet.signer.key "$RELAYER_SOLANA_SEED_HEX" \
  --chains.solanadevnet.signer.type hexKey \
  --chains.solanadevnet.signer.key "$RELAYER_SOLANA_SEED_HEX" \
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

## Known issue NOT fixed — Sepolia → Solana auto-delivery needs a validator

Diagnosed further after the RPC endpoint swap below didn't help: this
relayer's own automatic delivery of Sepolia-origin messages to a Solana
destination is blocked on a different, deeper cause than RPC flakiness.
Its logs show `Could not fetch metadata: Unable to reach quorum` for the
Solana-bound message — the default ISM configured for that route is a
multisig ISM (`config.json`'s `solanatestnet.interchainSecurityModule`)
that requires a signed checkpoint from a Hyperlane validator agent for
the message's origin/destination pair. Anchor doesn't run a validator
agent for this route, so no checkpoint exists anywhere for the relayer to
fetch, and no RPC endpoint quality fixes that — the relayer isn't failing
to *reach* the checkpoint, there simply isn't one.

The Sepolia RPC endpoint list (`chains/sepolia.rpcUrls` above) was
swapped for a more reliable set (dropped `gateway.tenderly.co/public/sepolia`
and `1rpc.io/sepolia`, both confirmed dead via direct `eth_blockNumber`
curl tests; added `sepolia.gateway.tenderly.co` and
`sepolia.rpc.thirdweb.com`, both confirmed responsive) — worth keeping
regardless, but it does not touch this issue.

Two real fixes exist, neither implemented yet:
1. Run a Hyperlane validator agent for the sepolia→solanatestnet route,
   publishing checkpoints the relayer can fetch (the standard Hyperlane
   answer, but real additional infrastructure to operate).
2. Apply the same `TrustedRelayerIsm.sol` pattern used for the Sepolia
   *destination* (see issue #1 above) on the Solana side instead — a
   custom Sealevel ISM that always verifies true, since Anchor is both
   the sole dispatcher and sole relayer for this route. This needs a new
   instruction handler in decision-relay's Solana program (or a sibling
   program) and pointing `solanatestnet`'s recipient at it, analogous to
   `DeployDecisionRelay.s.sol` deploying `TrustedRelayerIsm` on the EVM
   side.

The one DecisionRelay→Solana dispatch proven end-to-end earlier in this
doc reached the destination program correctly (confirmed via direct
`simulateTransaction`), but was never auto-delivered by this relayer —
verify delivery again before depending on it unattended.

## Chain configs

`config.json`'s `sepolia`/`solanatestnet` entries are copied verbatim from
Hyperlane's own agent config
(`rust/main/config/testnet_config.json` in `hyperlane-xyz/hyperlane-monorepo`) —
not hand-typed. `solanadevnet` isn't part of Hyperlane's official
testnet4 config (devnet is a separate, less-maintained tier — no active
public relayer or validator infra is guaranteed there), so that entry was
built manually from the Hyperlane registry's
`chains/solanadevnet/{metadata,addresses}.yaml`, matching the same schema
shape.

`sepolia.index.from` is set to a recent block (not 0) — indexing the
entire chain history isn't needed and the destination chain has real
transaction volume, unlike the two young Solana test mailboxes.

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
