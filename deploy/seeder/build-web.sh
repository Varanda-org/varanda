#!/usr/bin/env bash
# Gera o app web (o PWA com o nó no navegador) em apps/app/dist, num
# contêiner Node: o servidor não precisa de Node instalado. Rode da raiz do
# repositório, antes de subir deploy/seeder/compose.web.yaml (e de novo a
# cada atualização do código).
#   bash deploy/seeder/build-web.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
# A mesma imagem Node, fixada por digest, do Dockerfile do semeador.
image="node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"

docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e npm_config_cache=/tmp/npm-cache \
  -v "$root":/src \
  -w /src \
  "$image" \
  sh -c 'npm ci --no-audit --no-fund && npm run export:web -w apps/app'

test -f "$root/apps/app/dist/index.html"
test -f "$root/apps/app/dist/varanda-node.js"

# O Caddy monta deploy/seeder/www. O export do Expo apaga e recria
# apps/app/dist, e um bind mount ficaria preso ao diretório apagado; por isso
# o app é copiado para www, que nunca é recriado: só o conteúdo é trocado.
www="$root/deploy/seeder/www"
mkdir -p "$www"
find "$www" -mindepth 1 -delete
cp -R "$root/apps/app/dist/." "$www/"
test -f "$www/index.html"
echo "app web publicado em deploy/seeder/www"
