# The Actual MCP server, serving MCP over HTTP at :3600/mcp.
#
# The build context is the repository root, and the bundles must already be
# built (CI does this on the runner, as for the sync-server image):
#
#   yarn build:api
#   yarn workspace @actual-app/mcp-server build
#
# Modelled on packages/sync-server/docker/ubuntu.Dockerfile. Nothing about a
# particular deployment goes in the image (it is public): the Actual server's
# address and password, the sync id and the optional bearer token are passed as
# environment variables, see packages/mcp-server/README.md.

FROM node:24-bookworm AS builder

WORKDIR /app

COPY .yarn ./.yarn
COPY yarn.lock package.json .yarnrc.yml ./
COPY packages ./packages

# Install only what the MCP server needs at runtime.
RUN yarn workspaces focus @actual-app/mcp-server --production

# Dereference yarn's workspace:* symlinks so the final stage can copy just node_modules.
RUN cp -RL node_modules node_modules.real \
    && rm -rf node_modules \
    && mv node_modules.real node_modules

# Strip dev-only content from the dereferenced workspace packages. The API and
# the MCP server are bundles; nothing reads the sources at runtime.
RUN find node_modules/@actual-app -maxdepth 2 -type d \
    \( -name src -o -name e2e -o -name __tests__ -o -name __mocks__ -o -name tests -o -name test -o -name build-stats \) \
    -exec rm -rf {} +

FROM node:24-bookworm-slim AS prod

# Minimal runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends tini && apt-get clean -y && rm -rf /var/lib/apt/lists/*

# Create a non-root user
ARG USERNAME=actual
ARG USER_UID=1001
ARG USER_GID=$USER_UID
RUN groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m $USERNAME \
    && mkdir /data && chown -R ${USERNAME}:${USERNAME} /data

WORKDIR /app

# Listen on every interface (the container's network is private; the Tailscale
# sidecar is what reaches it). ACTUAL_DATA_DIR holds the local copy of the
# budget and should be a volume.
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3600 \
    ACTUAL_DATA_DIR=/data

COPY --from=builder /app/node_modules ./node_modules
# package.json carries "type": "module", which the bundle needs.
COPY --from=builder /app/packages/mcp-server/package.json ./
COPY --from=builder /app/packages/mcp-server/dist/index.js ./

USER ${USERNAME}
VOLUME /data

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||3600)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
EXPOSE 3600
CMD ["node", "index.js"]
