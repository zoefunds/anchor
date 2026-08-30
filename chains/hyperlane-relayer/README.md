# Anchor's self-hosted Hyperlane relayer

The shared public Hyperlane testnet4 relayer does not reliably service the
Solana Testnet/Devnet -> Sepolia route Anchor's cross-chain settlement
path depends on — two real dispatched messages sat undelivered for 7+
hours before this was stood up (see the message IDs below). This is
Anchor's own relayer, scoped to exactly the chains it needs.

**Status: live, proven.** Both previously-stuck messages were delivered
within minutes of starting this relayer:

| Origin | Message ID | Destination tx |
|---|---|---|
| Solana Testnet (nonce 873) | `0x7ca006278e77c09962ae930f4c3f5f5cbd80dc8234645a66b49cc78c0023d473` | [`0xe7b9b011...`](https://sepolia.etherscan.io/tx/0xe7b9b011c00af0311931ad07e49728d8e6801aa57a9ce18803ba9b25a75119a1) |
| Solana Devnet (nonce 14) | `0xf77581accc03d17fd3ea76bcbd3ed16d336566310fe31a863a961fb21350e252` | [`0x4ef81e79...`](https://sepolia.etherscan.io/tx/0x4ef81e7972309147aef11687eb2fb2204b18c32d672bceb9e0247b1941bbd1a6) |

Both destination transactions succeeded and `SolanaCaseReceiver.handle()`
correctly decoded the Borsh-encoded message and emitted the right case ID
(`CASE-SOL-...`) — this proves the full round trip, not just Mailbox
delivery: dispatch on Solana -> Hyperlane relay -> `handle()` decode on
Sepolia, genuinely working end to end.

## What this is

A single `hyperlane-agent` relayer container (`ghcr.io/hyperlane-xyz/hyperlane-agent:agents-v2.2.0`),
scoped to three chains via `config.json`:
- `sepolia` (destination — where `SolanaCaseReceiver` lives)
- `solanatestnet`, `solanadevnet` (origins — where the Solana decision-relay
  program dispatches from)

It only needs a signer for the chain it submits transactions *to*
(`sepolia`) — origin chains are read-only for this relayer, it never
signs anything on Solana.

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
  --allowLocalCheckpointSyncers true
```

`RELAYER_EVM_PRIVATE_KEY` needs Sepolia ETH to pay gas for the `process()`
delivery transactions it submits — this is the same funded key used to
deploy `SolanaCaseReceiver` in the first place (see `chains/evm/`).

`--restart unless-stopped` keeps it running across host reboots — this is
meant to be long-lived infrastructure, not a one-shot script. Check status
with `docker logs anchor-hyperlane-relayer` / `docker ps`.

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
