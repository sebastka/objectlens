# syntax=docker/dockerfile:1
#
# Multi-stage build on Docker Hardened Images (pulling from dhi.io needs `docker login dhi.io`
# with a Docker Hub account):
#   build      dev image (npm, root): installs all dependencies and builds the UI
#   prod-deps  dev image: production dependencies only
#   runtime    hardened image (non-root uid 1000, no shell, no package manager)
#
# Both build stages run on the builder's native platform (--platform=$BUILDPLATFORM): their
# output is architecture independent (built assets, pure-JS dependencies), so the arm64 and
# amd64 images are produced without emulation. Typecheck, lint and tests run in CI, not here.
#
#   docker build -t objectlens .        (or: npm run docker:build)
#   docker run --rm -p 127.0.0.1:3000:3000 --env-file .env objectlens
#
# ObjectLens has no login: publish the port on 127.0.0.1 only (see README).
# Images are pinned by digest (multi-arch index); Dependabot keeps them up to date.

FROM --platform=$BUILDPLATFORM dhi.io/node:26-alpine-dev@sha256:393f63498dc3739e4a1cc9e618261927d74663ab023b96b38d29c57199702dc6 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.server.json tsconfig.web.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM --platform=$BUILDPLATFORM dhi.io/node:26-alpine-dev@sha256:393f63498dc3739e4a1cc9e618261927d74663ab023b96b38d29c57199702dc6 AS prod-deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM dhi.io/node:26-alpine@sha256:5c86dab3a84b76e8ae134d04adf87bd23c5356a4d24f2005f57aa0aa305d7773 AS runtime
ARG REVISION=unknown
LABEL org.opencontainers.image.title="objectlens" \
      org.opencontainers.image.description="Web file explorer for S3-compatible object storage" \
      org.opencontainers.image.source="https://github.com/sebastka/objectlens" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${REVISION}"

# 0.0.0.0 inside the container; the host decides who can reach it (-p 127.0.0.1:3000:3000).
ENV NODE_ENV=production \
    LISTEN_HOST=0.0.0.0 \
    PORT=3000

# Same /app layout as the release archive (scripts/bundle.sh). Everything is owned by root
# and world-readable, so the app user (1000) cannot modify it: a read-only root filesystem works.
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY src/server ./src/server
COPY src/shared ./src/shared

EXPOSE 3000

# No shell or curl in the image, so the probe is written in Node.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "/app/src/server/index.ts"]
