#!/bin/sh
# Reads secrets from environment variables (set as Fly secrets, never
# baked into the image or passed as plain CLI args) and launches the
# validator agent. One VALIDATOR_KEY per deployed app — see README.md.
set -e

# Same hex/base58 ambiguity workaround as chains/hyperlane-relayer/entrypoint.sh
# — see that file's own comment for the full story (a real bug, not
# defensive boilerplate).
hexify() {
  case "$1" in
    0x*) printf '%s' "$1" ;;
    *) printf '0x%s' "$1" ;;
  esac
}

# S3 (real AWS S3, not Cloudflare R2 — see README.md's "Why AWS S3, not
# R2" section for the real, live-reproduced bug that ruled R2 out: the
# Hyperlane agent's bundled AWS SDK fails S3-compatible endpoint
# override with InvalidAccessKeyId/NoSuchBucket against R2, confirmed
# even though a real @aws-sdk/client-s3 client with the exact same
# credentials/bucket/endpoint works fine — an upstream compatibility
# bug, not a config error) is what makes this validator's checkpoints
# fetchable by a relayer running on a DIFFERENT machine —
# checkpointSyncer.type=localStorage announces a file:// URI on-chain,
# only readable on the same filesystem as the validator itself. S3_FOLDER
# keeps each validator's checkpoints in its own prefix within one
# shared bucket, since a single free-tier bucket is enough for a small
# validator set.
#
# Same real bug chains/hyperlane-relayer/entrypoint.sh's own comment
# documents in detail: the settings loader ALWAYS reads its bundled
# config/*.json defaults first (which include drpc.org — a provider
# that rejects Sepolia on its free plan, confirmed live) and CLI flags
# like --chains.sepolia.customRpcUrls do NOT override that; only
# CONFIG_FILES actually replaces it.
export CONFIG_FILES=/config/config.json

exec ./validator \
  --db /data \
  --originChainName sepolia \
  --checkpointSyncer.type s3 \
  --checkpointSyncer.bucket "$S3_BUCKET" \
  --checkpointSyncer.region "$S3_REGION" \
  --checkpointSyncer.folder "$S3_FOLDER" \
  --validator.key "$(hexify "$VALIDATOR_KEY")"
