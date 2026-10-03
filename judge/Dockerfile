# Build from the repo root so the workspace engine is in the context:
#   docker build -f judge/Dockerfile -t kirchhoff/judge:dev .
# The Judge runs its TypeScript directly with Node's type stripping; there is no build step.
FROM node:26-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm@12.8.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY engine/package.json engine/package.json
COPY judge/package.json judge/package.json
RUN pnpm install --frozen-lockfile --prod --filter @kirchhoff/judge...

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/engine/node_modules ./engine/node_modules
COPY --from=deps /app/judge/node_modules ./judge/node_modules
COPY package.json ./
COPY engine/package.json engine/package.json
COPY engine/src engine/src
COPY engine/specs engine/specs
COPY judge/package.json judge/package.json
COPY judge/src judge/src
COPY judge/openapi judge/openapi
USER node
EXPOSE 8080
WORKDIR /app/judge
HEALTHCHECK --interval=10s --timeout=2s CMD wget -qO- http://127.0.0.1:${JUDGE_PORT:-8080}/healthz >/dev/null || exit 1
CMD ["node", "src/main.ts"]
