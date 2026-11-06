# One image for both runtimes: Node 20, bun, git, jq, Claude Code and opencode.
FROM node:20-bookworm-slim

# Pinned to the versions the checks were verified against (Claude Code 2.1.283, opencode 2.0.29).
ARG OPENCODE_VERSION=2.0.29
ARG CLAUDE_CODE_VERSION=2.1.283

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq unzip python3 \
 && rm -rf /var/lib/apt/lists/*

# bun into /usr/local so the plugin hooks and the entrypoint find it on PATH.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# opencode v2 from the v2 installer, moved out of /root so the node user can run it.
RUN curl -fsSL https://opencode.ai/v2/install | HOME=/root bash -s -- --version "${OPENCODE_VERSION}" --no-modify-path \
 && mv /root/.opencode /usr/local/lib/opencode \
 && ln -s /usr/local/lib/opencode/bin/opencode /usr/local/bin/opencode

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh && mkdir -p /work /out && chown node:node /work /out

USER node
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
