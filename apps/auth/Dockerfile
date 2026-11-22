FROM node:24.22.3-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:24.22.3-alpine AS runtime

WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 auth

# Node reads package.json at run time as the non-root user; a fixed mode keeps it readable when the
# checkout was made under a strict umask (077).
COPY --chmod=0444 package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/

USER auth
EXPOSE 8081
CMD ["node", "dist/index.js"]

# Self-hosted image (infra/selfhost/compose.yml builds this with `target: standalone`): the runtime
# image plus the standalone entrypoint wrapper from the `selfhost` named build context
# (infra/selfhost). Baked in with a fixed mode rather than bind-mounted, so the non-root user can
# run it whatever umask the checkout was made under. COPY ignores USER, so the file is root-owned.
FROM runtime AS standalone
COPY --from=selfhost --chmod=0555 runtime-env.sh /selfhost/runtime-env.sh

# Default target, kept last: a plain `docker build` (or a Compose service without `target`) gets the
# runtime image and needs no named context; BuildKit skips the unreferenced standalone stage.
FROM runtime
