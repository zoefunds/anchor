#!/bin/sh
# Reads secrets from environment variables (set as Fly secrets, never
# baked into the image or passed as plain CLI args) and launches the
# actual relayer binary with them. See README.md for what each key is.
set -e

# The relayer's key parser tries hex/base58/bech32 in some order and,
# for a bare hex string with no "0x" prefix, can apparently attempt
# base58 first — which rejects any literal '0' character (base58
# deliberately excludes '0'/'O'/'I'/'l' to avoid visual ambiguity, see
# https://en.wikipedia.org/wiki/Base58). A hex seed that happens to
# contain a '0' then fails with a wildly misleading "invalid character
# '0'" error blamed on the seed itself. Confirmed by reproducing the
# exact same ParsingError locally with a real hex value, then
# confirmed fixed by adding the prefix — real hex/base58 ambiguity in
# the parser, not a malformed key. Ensuring the "0x" prefix here (once,
# idempotently) makes every hex-key flag unambiguous regardless of
# what's actually stored in the Fly secret.
hexify() {
  case "$1" in
    0x*) printf '%s' "$1" ;;
    *) printf '0x%s' "$1" ;;
  esac
}

# Without a whitelist, the relayer's sequence-aware sync walks and
# retries EVERY historical dispatched message on these chains forever
# — including old ones sent to a recipient that never had a working
# ISM configured (their default ISM is a 2-of-2 aggregation multisig
# this self-hosted relayer can only ever produce 1 of 2 checkpoints
# for, so those are permanently undeliverable, not just slow). Observed
# live: the relayer spending all its time on "Aggregation threshold
# not met (2)" retries for old stuck messages instead of ever reaching
# a genuinely new, deliverable one. Restricting to the actual live
# recipients this deployment cares about makes those old entries get
# skipped outright instead of retried forever.
WHITELIST='[
  {"destinationDomain":"11155111","recipientAddress":"0xCDfF36cDA76e08BAd2EA0d5a3fDaDf3761Ed5041"},
  {"destinationDomain":"1399811150","recipientAddress":"DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN"}
]'

# Without this, config.json is never actually read. The relayer's
# settings loader ALWAYS reads its own bundled `./config/*.json`
# defaults (mainnet_config.json/testnet_config.json baked into the
# image at /app/config/) first, and only merges in additional files
# from the CONFIG_FILES env var on top — confirmed straight from the
# vendored source (hyperlane-base/src/settings/loader/mod.rs). This
# was never set here, so every customization in this directory's
# config.json (in particular, dropping a permanently-dead RPC provider
# from sepolia's rpcUrls) silently never took effect — the relayer ran
# on 100% bundled defaults the whole time, which is why removing a
# dead provider from config.json alone didn't fix anything until this
# was added.
export CONFIG_FILES=/config/config.json

exec ./relayer \
  --db /data \
  --relayChains solanatestnet,sepolia \
  --defaultSigner.key "$(hexify "$RELAYER_EVM_PRIVATE_KEY")" \
  --chains.solanatestnet.signer.type hexKey \
  --chains.solanatestnet.signer.key "$(hexify "$RELAYER_SOLANA_SEED_HEX")" \
  --chains.solanatestnet.identity.type hexKey \
  --chains.solanatestnet.identity.key "$(hexify "$RELAYER_SOLANA_IDENTITY_SEED_HEX")" \
  --allowLocalCheckpointSyncers true \
  --whitelist "$WHITELIST"
