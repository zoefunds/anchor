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
# Same fail-closed RPC policy as chains/hyperlane-validator/scripts/resolve-rpc-url.ts
# and chains/hyperlane-relayer/entrypoint.sh — a dedicated endpoint is
# required in production; the shared public endpoint caused real
# rate-limiting that degraded checkpoint indexing (see
# docs/production-readiness-hardening-pass.md), so this no longer
# defaults to it silently. Only ALLOW_PUBLIC_RPC_FALLBACK=true (local
# development) permits the fallback. Never echo the resolved URL itself
# — only its host, so an API key embedded in the URL's path/query never
# reaches logs.
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

exec ./validator \
  --db /data \
  --originChainName sepolia \
  --checkpointSyncer.type s3 \
  --checkpointSyncer.bucket "$S3_BUCKET" \
  --checkpointSyncer.region "$S3_REGION" \
  --checkpointSyncer.folder "$S3_FOLDER" \
  --validator.key "$(hexify "$VALIDATOR_KEY")"
