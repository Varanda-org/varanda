#!/usr/bin/env bash
# Gera o app web (o PWA com o nó no navegador e o service worker, sw.js) em
# apps/app/dist, num contêiner Node: o servidor não precisa de Node instalado.
# Rode da raiz do repositório, antes de subir deploy/seeder/compose.web.yaml (e
# de novo a cada atualização do código).
#   bash deploy/seeder/build-web.sh
# Com um diretório como argumento (é o que deploy/seeder/deploy.sh faz), gera
# o app nesse diretório, uma cópia exportada do commit, e não publica nada:
# quem chamou copia o resultado de <dir>/apps/app/dist com cuidado, porque o
# conteúdo passou pelos scripts de instalação das dependências.
#   bash deploy/seeder/build-web.sh <dir>
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
# Caminho absoluto: um nome relativo viraria um volume do Docker, não o diretório.
src="$(cd "${1:-$root}" && pwd)"
# Quem roda o build no contêiner: sem argumento, quem chamou (os arquivos
# gerados ficam com o dono do checkout); com um diretório, o dono dele (o
# deploy.sh entrega a cópia a nobody, para que o build nunca rode como root).
if [ "$#" -gt 0 ]; then
  user="$(stat -c '%u:%g' "$src")"
else
  user="$(id -u):$(id -g)"
fi
# A mesma imagem Node, fixada por digest, do Dockerfile do semeador.
image="node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"

# --init: com um init como PID 1, um Ctrl-C ou SIGTERM repassado pelo docker
# para de fato o build (sh como PID 1 ignoraria o sinal e seguiria gravando).
docker run --rm --init \
  --user "$user" \
  -e HOME=/tmp \
  -e npm_config_cache=/tmp/npm-cache \
  -v "$src":/src \
  -w /src \
  "$image" \
  sh -c 'npm ci --no-audit --no-fund && npm run export:web -w apps/app'

test -f "$src/apps/app/dist/index.html"
test -f "$src/apps/app/dist/varanda-node.js"
test -f "$src/apps/app/dist/sw.js"
if [ "$#" -gt 0 ]; then
  echo "app web gerado em $src/apps/app/dist (não publicado)"
  exit 0
fi

# O Caddy monta deploy/seeder/www. O export do Expo apaga e recria
# apps/app/dist, e um bind mount ficaria preso ao diretório apagado; por isso
# o app é copiado para www, que nunca é recriado: só o conteúdo é trocado.
www="$root/deploy/seeder/www"
mkdir -p "$www"
find "$www" -mindepth 1 -delete
cp -R "$root/apps/app/dist/." "$www/"
test -f "$www/index.html"
echo "app web publicado em deploy/seeder/www"
