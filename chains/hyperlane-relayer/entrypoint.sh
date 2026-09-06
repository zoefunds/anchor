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
#
# Sepolia recipient updated to the current DecisionRelay deployment
# (0x94f3FF552CC879a36B19b829af3325Ea72cbC71C) — the real 2-of-2
# StaticMerkleRootMultisigIsm redeploy (see
# docs/self-hosted-validator-setup.md), replacing the permissive
# TrustedRelayerIsm. Every prior address in this whitelist's history is
# a superseded deployment on an older trust model; only the current
# live contract needs to be whitelisted here, since old ones no longer
# receive real dispatches.
# Real gap found by the new reliability-monitoring infrastructure
# (chains/hyperlane-validator/scripts/verify-deployment.ts's
# relayer:whitelist check, 2026-09-06): redeployed again for the
# validator2 replacement (real A/B/C validator independence — see
# chains/hyperlane-validator/VALIDATOR2_REPLACEMENT.md). Previous relay
# 0x12495e1C55e6257fdE1e1ED0be463477DAFA9907 retired, not deleted.
WHITELIST='[
  {"destinationDomain":"11155111","recipientAddress":"0x1fc130416Dc09dff60e0Ea3C8dE8474e8428b3E2"},
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
#
# config.json is baked into the image and can't hold a real API key
# (that would commit a live credential to git). It has a
# __SEPOLIA_RPC_URL__ placeholder instead, substituted here at
# container start — never baked into the image, never written to disk
# except this generated runtime copy.
#
# Fail-closed policy (same as chains/hyperlane-validator/entrypoint.sh
# and chains/hyperlane-validator/scripts/resolve-rpc-url.ts): a
# dedicated endpoint (HYPERLANE_SEPOLIA_RPC_URL) is required in
# production. An earlier version of this substitution fell back to an
# unreachable placeholder host when unset, which "worked" only by
# accident (the fallback provider list in config.json just kept
# skipping the dead entry) — that's a silent misconfiguration, not a
# real fallback. The shared public endpoint is now only used with an
# explicit ALLOW_PUBLIC_RPC_FALLBACK=true opt-in (local development).
# Only the host is ever logged — never the full URL (a dedicated
# endpoint's path/query can carry an API key).
if [ -n "$HYPERLANE_SEPOLIA_RPC_URL" ]; then
  RESOLVED_RPC_URL="$HYPERLANE_SEPOLIA_RPC_URL"
  RESOLVED_RPC_HOST=$(printf '%s' "$HYPERLANE_SEPOLIA_RPC_URL" | sed -E 's#^[a-zA-Z]+://##; s#/.*##')
  echo "[rpc] using dedicated endpoint: $RESOLVED_RPC_HOST"
elif [ "$ALLOW_PUBLIC_RPC_FALLBACK" = "true" ]; then
  RESOLVED_RPC_URL="https://ethereum-sepolia.publicnode.com"
  echo "[rpc] using PUBLIC FALLBACK (local-dev only) endpoint: ethereum-sepolia.publicnode.com"
else
  echo "FATAL: HYPERLANE_SEPOLIA_RPC_URL is not set. A dedicated RPC endpoint is required in" >&2
  echo "production. To use the public endpoint anyway (local development ONLY), set" >&2
  echo "ALLOW_PUBLIC_RPC_FALLBACK=true." >&2
  exit 1
fi
sed "s#__SEPOLIA_RPC_URL__#${RESOLVED_RPC_URL}#g" /config/config.json > /tmp/config.json
export CONFIG_FILES=/tmp/config.json

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
