# Fly-deployable image for Anchor's self-hosted Hyperlane relayer (see
# README.md — this replaces the local `docker run` invocation documented
# there for prod). Bakes config.json in (Fly volumes don't support host
# bind-mounts the way local `docker run -v` does) and reads its signer/
# identity keys from environment variables via entrypoint.sh instead of
# CLI args, which would otherwise leak private keys into `ps`/process
# listings on the host.
FROM ghcr.io/hyperlane-xyz/hyperlane-agent:agents-v2.3.0

COPY config.json /config/config.json
COPY entrypoint.sh /entrypoint.sh

USER root
RUN chmod +x /entrypoint.sh
USER 1000

ENTRYPOINT ["tini", "--", "/entrypoint.sh"]
