FROM node:24.22.3-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/patch-just-bash.mts scripts/
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:24.22.3-alpine

WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 backend

# Node reads package.json at run time as the non-root user; a fixed mode keeps it readable when the
# checkout was made under a strict umask (077).
COPY --chmod=0444 package.json package-lock.json ./
COPY scripts/patch-just-bash.mts scripts/
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
# The standalone (self-hosted) entrypoint wrapper, from the `selfhost` named build context that
# infra/selfhost/compose.yml supplies (infra/selfhost). Baked in with a fixed mode rather than
# bind-mounted, so the non-root user can run it whatever umask the checkout was made under.
COPY --from=selfhost --chmod=0555 runtime-env.sh /selfhost/runtime-env.sh

USER backend
EXPOSE 8080
CMD ["node", "dist/entrypoints/index.js"]
