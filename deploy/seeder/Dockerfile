# Imagem do semeador Varanda (`varanda seed`, apps/cli).
#
# Build a partir da raiz do repositório: o contexto precisa dos workspaces
# packages/core, packages/rpc e apps/cli e do LICENSE, e o .dockerignore da
# raiz deixa o resto de fora. O LICENSE vai para /app/LICENSE: a PolyForm
# Noncommercial 1.0.0 exige que os termos acompanhem cada cópia.
#   docker build -f deploy/seeder/Dockerfile -t varanda-seeder .
#
# Só as dependências de produção da CLI, sem scripts de instalação. Roda como
# o usuário node, com os dados em /data (um volume) e o endpoint de saúde em
# 127.0.0.1:8788, que o HEALTHCHECK consulta. Uso no README, seção "Operar o
# semeador", e em deploy/seeder/compose.yaml.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/rpc/package.json packages/rpc/
COPY apps/cli/package.json apps/cli/
RUN npm ci --omit=dev --workspace apps/cli --ignore-scripts --no-audit --no-fund

FROM base
ENV NODE_ENV=production \
    VARANDA_DATA=/data \
    VARANDA_HEALTH_PORT=8788
WORKDIR /app
LABEL org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"
COPY LICENSE ./
COPY --from=deps /app /app
COPY packages/core packages/core
COPY packages/rpc packages/rpc
COPY apps/cli apps/cli
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
USER node
VOLUME /data
# SIGTERM fecha o semeador (store, quarentena e lock) e ele sai com 0.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.VARANDA_HEALTH_PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "apps/cli/bin/varanda.js"]
CMD ["seed", "--json"]
