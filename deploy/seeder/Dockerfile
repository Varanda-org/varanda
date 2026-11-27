# Imagem do semeador Varanda (`varanda seed`, apps/cli).
#
# Build a partir da raiz do repositório: o contexto precisa dos workspaces
# packages/core, packages/rpc e apps/cli, do package.json e do lib de
# packages/web-member (o `account review` deriva a chave e o código de
# recuperação com eles; o npm ci já instala as dependências desse workspace)
# e do LICENSE, e o .dockerignore da raiz deixa o resto de fora. O LICENSE vai
# para /app/LICENSE: a PolyForm Noncommercial 1.0.0 exige que os termos
# acompanhem cada cópia.
#   docker build -f deploy/seeder/Dockerfile -t varanda-seeder .
#
# Só as dependências de produção da CLI, sem scripts de instalação. Roda como
# o usuário node, com os dados em /data (um volume) e o endpoint de saúde em
# 127.0.0.1:8788, que o HEALTHCHECK consulta. Uso no README, seção "Operar o
# semeador", e em deploy/seeder/compose.yaml.
#
# Versão publicada (ghcr.io/varanda-org/varanda-seeder): o workflow passa
# VARANDA_COMMIT (40 hex minúsculos), VARANDA_SEQ (inteiro positivo, até 10
# dígitos) e VARANDA_WEB_IMAGE (ghcr.io/varanda-org/varanda-web@sha256:<64 hex>),
# e a imagem ganha /app/release.json, uma linha só, que nomeia o commit e fixa
# a imagem web por digest: uma assinatura cobre a versão inteira. Sem esses
# argumentos (build local, compose.yaml e deploy.sh) nada muda e não há
# release.json. O pacote de implantação (compose, Caddyfile, scripts) vai para
# /app/deploy/seeder, de root, para o servidor não precisar do repositório.
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
LABEL org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0" \
      org.opencontainers.image.source="https://github.com/Varanda-org/varanda"
COPY LICENSE ./
COPY --from=deps /app /app
COPY packages/core packages/core
COPY packages/rpc packages/rpc
COPY packages/web-member packages/web-member
COPY apps/cli apps/cli
# Só os arquivos que o .dockerignore da raiz admite em deploy/seeder; o COPY
# mantém os bits de execução e o dono root.
COPY deploy/seeder deploy/seeder
# O finish-web.js e o modelo do service worker, de root: com
# VARANDA_MEDIA_ORIGIN, o update.sh refaz com eles o sw.js e a versão do app
# web da imagem web, que sai sem a origem (aplicar_origem_midia).
COPY apps/app/scripts/finish-web.js apps/app/scripts/sw.js apps/app/scripts/
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
# Declarados aqui para não invalidar o cache das camadas acima. Os valores
# chegam ao RUN como variáveis de ambiente e só entram no arquivo como
# argumentos do printf, nunca como código. Os servidores conferem a linha
# inteira com uma regex (lá não há jq), então o formato é fixo: chaves nesta
# ordem, sem espaços, um LF no fim.
ARG VARANDA_COMMIT=""
ARG VARANDA_SEQ=""
ARG VARANDA_WEB_IMAGE=""
RUN set -eu; \
    if [ -z "$VARANDA_COMMIT" ]; then \
      if [ -n "$VARANDA_SEQ$VARANDA_WEB_IMAGE" ]; then \
        echo 'release.json: VARANDA_SEQ e VARANDA_WEB_IMAGE exigem VARANDA_COMMIT' >&2; exit 1; \
      fi; \
      exit 0; \
    fi; \
    case "$VARANDA_COMMIT" in *[!0-9a-f]*) echo 'release.json: VARANDA_COMMIT inválido' >&2; exit 1 ;; esac; \
    [ "${#VARANDA_COMMIT}" -eq 40 ] || { echo 'release.json: VARANDA_COMMIT inválido' >&2; exit 1; }; \
    case "$VARANDA_SEQ" in ''|0*|*[!0-9]*) echo 'release.json: VARANDA_SEQ inválido' >&2; exit 1 ;; esac; \
    [ "${#VARANDA_SEQ}" -le 10 ] || { echo 'release.json: VARANDA_SEQ inválido' >&2; exit 1; }; \
    digest="${VARANDA_WEB_IMAGE#ghcr.io/varanda-org/varanda-web@sha256:}"; \
    case "$digest" in ''|*[!0-9a-f]*) echo 'release.json: VARANDA_WEB_IMAGE inválido' >&2; exit 1 ;; esac; \
    if [ "$digest" = "$VARANDA_WEB_IMAGE" ] || [ "${#digest}" -ne 64 ]; then \
      echo 'release.json: VARANDA_WEB_IMAGE inválido' >&2; exit 1; \
    fi; \
    printf '{"v":1,"commit":"%s","seq":%s,"web":"%s"}\n' "$VARANDA_COMMIT" "$VARANDA_SEQ" "$VARANDA_WEB_IMAGE" > /app/release.json; \
    chmod 0444 /app/release.json
# A imagem do Caddy (Dockerfile.caddy), fixada por digest num arquivo à parte:
# o release.json fica com o formato que os servidores já instalados conferem.
# Com ela, o update.sh roda o web dessa imagem e só o recria quando ela ou o
# Caddyfile mudam. Sem o argumento, nada muda e não há caddy.json.
ARG VARANDA_CADDY_IMAGE=""
RUN set -eu; \
    [ -n "$VARANDA_CADDY_IMAGE" ] || exit 0; \
    [ -n "$VARANDA_COMMIT" ] || { echo 'caddy.json: VARANDA_CADDY_IMAGE exige VARANDA_COMMIT' >&2; exit 1; }; \
    digest="${VARANDA_CADDY_IMAGE#ghcr.io/varanda-org/varanda-caddy@sha256:}"; \
    case "$digest" in ''|*[!0-9a-f]*) echo 'caddy.json: VARANDA_CADDY_IMAGE inválido' >&2; exit 1 ;; esac; \
    if [ "$digest" = "$VARANDA_CADDY_IMAGE" ] || [ "${#digest}" -ne 64 ]; then \
      echo 'caddy.json: VARANDA_CADDY_IMAGE inválido' >&2; exit 1; \
    fi; \
    printf '{"v":1,"caddy":"%s"}\n' "$VARANDA_CADDY_IMAGE" > /app/caddy.json; \
    chmod 0444 /app/caddy.json
USER node
VOLUME /data
# SIGTERM fecha o semeador (store, quarentena e lock) e ele sai com 0.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.VARANDA_HEALTH_PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "apps/cli/bin/varanda.js"]
CMD ["seed", "--json"]
