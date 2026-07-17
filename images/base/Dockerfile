# Base sandbox image for hotcell — a general-purpose agent workspace.
# Python 3.11 + Node 20 + git/bash and common build tools.
FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    NODE_VERSION=20

# socat backs the preview-URL proxy's binary-safe TCP bridge (clean half-close);
# the daemon falls back to a bash /dev/tcp bridge on images without it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git bash build-essential procps \
        ripgrep jq tini socat \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Workspace is where agent code lives and persists for the sandbox lifetime.
WORKDIR /workspace

# tini as PID 1 → clean signal handling / zombie reaping for many concurrent execs.
ENTRYPOINT ["/usr/bin/tini", "--"]
# Keep the container alive so the daemon can exec into it on demand.
CMD ["sleep", "infinity"]
