FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.base.json ./
COPY artifacts ./artifacts
COPY lib ./lib
COPY attached_assets ./attached_assets

RUN printf '%s\n' \
    'only-built-dependencies[]=esbuild' \
    'only-built-dependencies[]=@swc/core' \
    > .npmrc \
    && pnpm install --frozen-lockfile \
    && pnpm rebuild esbuild

ENV BASE_PATH=/ PORT=8080 NODE_ENV=production

RUN pnpm --filter @workspace/api-server run build
RUN pnpm --filter @workspace/carrier run build

FROM node:24-alpine AS runner

WORKDIR /app

COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=builder /app/artifacts/carrier/dist/public ./artifacts/carrier/dist/public

ENV NODE_ENV=production
ENV PORT=8080
ENV STATIC_DIR=/app/artifacts/carrier/dist/public

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/healthz" >/dev/null 2>&1 || exit 1

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]