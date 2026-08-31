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

exec ./relayer \
  --db /data \
  --relayChains solanatestnet,sepolia \
  --defaultSigner.key "$(hexify "$RELAYER_EVM_PRIVATE_KEY")" \
  --chains.solanatestnet.signer.type hexKey \
  --chains.solanatestnet.signer.key "$(hexify "$RELAYER_SOLANA_SEED_HEX")" \
  --chains.solanatestnet.identity.type hexKey \
  --chains.solanatestnet.identity.key "$(hexify "$RELAYER_SOLANA_IDENTITY_SEED_HEX")" \
  --allowLocalCheckpointSyncers true
