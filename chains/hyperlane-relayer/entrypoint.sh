#!/bin/sh
# Reads secrets from environment variables (set as Fly secrets, never
# baked into the image or passed as plain CLI args) and launches the
# actual relayer binary with them. See README.md for what each key is.
set -e

exec ./relayer \
  --db /data \
  --relayChains solanatestnet,sepolia \
  --defaultSigner.key "$RELAYER_EVM_PRIVATE_KEY" \
  --chains.solanatestnet.signer.type hexKey \
  --chains.solanatestnet.signer.key "$RELAYER_SOLANA_SEED_HEX" \
  --chains.solanatestnet.identity.type hexKey \
  --chains.solanatestnet.identity.key "$RELAYER_SOLANA_IDENTITY_SEED_HEX" \
  --allowLocalCheckpointSyncers true
