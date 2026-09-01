# Fly-deployable image for one of Anchor's self-hosted Hyperlane
# validators — same official agent image as chains/hyperlane-relayer/,
# just running --entrypoint /app/validator instead of /app/relayer.
# One image, deployed as TWO separate Fly apps (one per validator), each
# with its own VALIDATOR_KEY secret and its own R2 folder — see
# ../hyperlane-relayer/README.md's pattern and this directory's README.md.
FROM ghcr.io/hyperlane-xyz/hyperlane-agent:agents-v2.3.0

COPY config.json /config/config.json
COPY entrypoint.sh /entrypoint.sh

USER root
RUN chmod +x /entrypoint.sh
USER 1000

ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
