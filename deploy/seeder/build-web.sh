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
log() { printf '%s\n' "$*" >&2; }
# shellcheck source=deploy/seeder/well-known.sh
. "$root/deploy/seeder/well-known.sh"
# Publicando em www (sem argumento), as associações do app nativo vêm de
# deploy/seeder/.env com as mesmas regras do deploy.sh (well-known.sh), e um
# valor malformado para tudo antes do build.
if [ "$#" -eq 0 ]; then
  ler_associacoes "$root/deploy/seeder/.env"
fi
# O commit mostrado em Ajustes. O deploy.sh passa o alvo já conferido; sem a
# variável, vale o HEAD de $root, que é o checkout que o deploy.sh acabou de
# levar ao alvo (a primeira implantação desta mudança ainda roda o deploy.sh
# anterior, que não passa nada). Sem git ou sem .git o build segue, só sem
# commit; um valor passado fora da forma para tudo antes do build.
commit="${EXPO_PUBLIC_VARANDA_COMMIT:-}"
if [ -n "$commit" ] && ! [[ $commit =~ ^[0-9a-f]{40}$ ]]; then
  log 'EXPO_PUBLIC_VARANDA_COMMIT inválido (40 hexadecimais minúsculos)'
  exit 1
fi
if [ -z "$commit" ] && [ -e "$root/.git" ]; then
  commit=$(git -C "$root" rev-parse --verify HEAD 2>/dev/null || true)
  if ! [[ $commit =~ ^[0-9a-f]{40}$ ]]; then
    commit=''
  fi
fi
# A mesma imagem Node, fixada por digest, do Dockerfile do semeador.
image="node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"

# --ignore-scripts: nenhum script de instalação de dependência roda no build
# (cadeia de suprimentos); os binários nativos usados já vêm nos pacotes.
# --init: com um init como PID 1, um Ctrl-C ou SIGTERM repassado pelo docker
# para de fato o build (sh como PID 1 ignoraria o sinal e seguiria gravando).
# A data do build quem carimba é o Metro, dentro do contêiner.
envs=(-e HOME=/tmp -e npm_config_cache=/tmp/npm-cache)
if [ -n "$commit" ]; then
  envs+=(-e EXPO_PUBLIC_VARANDA_COMMIT="$commit")
fi
docker run --rm --init \
  --user "$user" \
  "${envs[@]}" \
  -v "$src":/src \
  -w /src \
  "$image" \
  sh -c 'npm ci --no-audit --no-fund --ignore-scripts && npm run export:web -w apps/app'

test -f "$src/apps/app/dist/index.html"
test -f "$src/apps/app/dist/varanda-node.js"
test -f "$src/apps/app/dist/sw.js"
# O version.json do build é sempre reescrito aqui, do commit conferido: o
# contêiner roda código das dependências. E nunca através de um link que ele
# tenha deixado no caminho (o mesmo cuidado de construir_web no deploy.sh).
dist="$src/apps/app/dist"
for p in "$src/apps" "$src/apps/app" "$dist"; do
  if [ -L "$p" ] || [ ! -d "$p" ]; then
    log "o build deixou $p como link simbólico ou não diretório"
    exit 1
  fi
done
gravar_versao "$dist" "$commit"
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
gravar_associacoes "$www"
gravar_versao "$www" "$commit"
test -f "$www/index.html"
echo "app web publicado em deploy/seeder/www"
