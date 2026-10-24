#!/usr/bin/env bash
# Implanta no servidor a versão atual de origin/main: atualiza o checkout,
# gera o app web, reconstrói e sobe o semeador e o Caddy, confere a saúde e,
# se algo falhar, volta sozinho para a versão anterior (commit, imagem e www),
# sem reconstruir nada. Rode como root, da raiz do repositório ou não:
#   bash deploy/seeder/deploy.sh </dev/null       # implanta a ponta de main
#   printf '%s\n' <sha> | bash deploy/seeder/deploy.sh
# Com um SHA na entrada, só implanta se ele for exatamente a ponta de
# origin/main. Passo a passo no README, seção "Implantação automática pelo
# GitHub Actions".
#
# Modelo de confiança: a chave do GitHub Actions só consegue rodar este
# script (comando forçado no authorized_keys e sudoers sem argumentos), e
# este script só implanta a ponta de origin/main. Quem vazar a chave
# consegue, no máximo, reimplantar a mesma ponta. Quem controla o servidor de
# fato é quem faz merge em main: os compose, o Dockerfile e o build-web.sh
# vêm do checkout e rodam como root. A proteção real é a regra de main
# (revisão, code owners e os checks exigidos).
#
# Códigos de saída: 0 implantado; 1 falha (nada mudou, ou voltou para a
# versão anterior); 2 uso errado; 3 main já avançou além do SHA pedido (uma
# execução mais nova implanta).
set -Eeuo pipefail

# Caminho fixo: sob sudo ou com um ambiente estranho, os comandos são sempre
# os do sistema.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022
# Se a conexão SSH cair, a implantação segue até o fim (ou até a volta): um
# deploy pela metade é pior que um deploy sem ninguém olhando.
trap '' HUP PIPE

state=/var/lib/varanda-deploy
# Lock e registro dentro de $state (0700, root), nunca em /run/lock ou
# /var/log: lá outros usuários (ou o grupo syslog) criam arquivos, e um link
# simbólico ou FIFO plantado no nome seria aberto por root.
log_file="$state/deploy.log"
lock_file="$state/lock"
# Acima disto o registro vira .1 (só uma geração guardada).
log_max_bytes=5242880
sha_re='^[0-9a-f]{40}$'
# Minúsculas e sem ponto final: o semeador exige que https://<domínio> seja
# exatamente uma origem (originList em apps/cli/lib/cli.js) e não subiria.
domain_re='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
# A chave pública da associação, servida pelo Caddy em /varanda.json. Qualquer
# caixa, como na CLI e no app (que normalizam para minúsculas); a sonda compara
# o corpo com o valor exato do .env, que é o que o Caddy serve.
assoc_re='^[0-9a-fA-F]{64}$'
# O Content-Type de /account/health: JSON, com ou sem parâmetros (charset).
json_type_re='^application/json( *;.*)?$'

root=''
www=''
domain=''
assoc=''
expected=''
target=''
previous=''
sem_registro=0
image_anterior=''
isolado=0
# O que a implantação já mexeu: a volta só desfaz o que mudou (uma falha no
# build não reinicia o semeador nem o Caddy).
www_trocado=0
imagem_trocada=0
servicos_trocados=0

# Abre uma conexão WebSocket de verdade, com o Origin de produção, usando o
# ws da própria CLI dentro da imagem do semeador (que confere o TLS). Os
# valores chegam como argumentos, nunca interpolados no código.
ws_script='
const [url, origin] = process.argv.slice(1);
const WebSocket = require("ws");
const ws = new WebSocket(url, { origin });
const timer = setTimeout(() => process.exit(1), 10000);
ws.on("open", () => { clearTimeout(timer); ws.terminate(); process.exit(0); });
ws.on("error", () => process.exit(1));
'

# Antes de isolar a saída: só a mensagem, direto para quem chamou.
morrer_cedo() {
  local code=$1
  shift
  printf '%s\n' "$*" >&2
  exit "$code"
}

# Uma linha com data no registro e, se a conexão ainda existir, para quem
# chamou (fd 3). Escrever num SSH morto falha sem matar nada (|| true).
log() {
  local linha
  linha="$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
  printf '%s\n' "$linha" || true
  if [ "$isolado" = 1 ]; then
    printf '%s\n' "$linha" >&3 2>/dev/null || true
  fi
}

compose() {
  docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml "$@"
}

# O contêiner do serviço seeder, rodando ou parado. Por rótulo, para não
# pegar os avulsos de um docker compose run sem --rm (o compose ps -a os
# lista junto). O projeto é o name: de compose.yaml.
conteiner_semeador() {
  docker ps -a -q \
    --filter label=com.docker.compose.project=varanda-seeder \
    --filter label=com.docker.compose.service=seeder \
    --filter label=com.docker.compose.oneoff=False
}

# Numa falha, quem chamou já viu as linhas de log(); a saída crua do build e
# do docker fica só no servidor, porque o log do GitHub Actions de um
# repositório público é público.
# shellcheck disable=SC2329 # chamada pelo trap EXIT.
ao_sair() {
  local rc=$?
  if [ "$isolado" = 1 ] && [ "$rc" = 1 ]; then
    printf '%s\n' "detalhes no servidor: $log_file" >&3 2>/dev/null || true
  fi
}

# ERR antes de qualquer mudança: só o snapshot foi gravado, o que está no ar
# continua igual. Numa subshell (uma substituição de comando) só sai: quem
# trata é o shell principal, quando a falha chega até ele.
# shellcheck disable=SC2329 # chamada pelo trap ERR.
erro_antes() {
  if [ "${BASH_SUBSHELL:-0}" -gt 0 ]; then
    exit 1
  fi
  trap - ERR
  log "falha antes de qualquer mudança (linha ${BASH_LINENO[0]:-?}); nada foi alterado"
  exit 1
}

preparar_estado() {
  (umask 077 && mkdir -p "$state")
  chmod 0700 "$state"
}

# Depois do lock: uma segunda execução esperando não gira o registro de
# quem está implantando.
preparar_registro() {
  if [ -f "$log_file" ] && [ "$(wc -c <"$log_file")" -gt "$log_max_bytes" ]; then
    mv -f "$log_file" "$log_file.1"
  fi
  (umask 077 && : >>"$log_file")
  chmod 0600 "$log_file"
}

# Toda a saída (a nossa, a do git, do build e do docker) vai para o registro;
# só log() escreve no SSH, pelo fd 3. Motivo: os filhos herdam o SIGPIPE
# ignorado, e um build escrevendo num SSH que caiu falharia com EPIPE no meio
# da implantação.
isolar_saida() {
  exec 3>&1
  exec >>"$log_file" 2>&1
  isolado=1
}

pegar_lock() {
  exec 9>"$lock_file"
  if flock -n 9; then
    return 0
  fi
  log 'esperando outra implantação terminar (até 600 s)'
  if ! flock -w 600 9; then
    log 'outra implantação em curso'
    exit 1
  fi
}

# O SHA testado chega pela entrada padrão (nunca por argumento: o sudoers não
# aceita nenhum). Vazio quer dizer "implante a ponta" (o caminho manual).
ler_sha() {
  IFS= read -r -t 30 expected || true
  # Daqui em diante ninguém lê do SSH.
  exec 0</dev/null
  if [ -n "$expected" ] && ! [[ $expected =~ $sha_re ]]; then
    log 'uso: a entrada deve ser vazia ou um SHA de 40 dígitos hexadecimais'
    exit 2
  fi
}

# Só a ponta de origin/main é implantada. Um SHA que main já deixou para trás
# sai com 3 (a execução mais nova implanta); um que ainda não chegou ao fetch
# ganha algumas tentativas antes de falhar.
escolher_alvo() {
  local tentativa=0
  git fetch -q --prune origin main
  target=$(git rev-parse origin/main)
  if [ -z "$expected" ] || [ "$expected" = "$target" ]; then
    return 0
  fi
  while :; do
    if git merge-base --is-ancestor "$expected" "$target" 2>/dev/null; then
      log "obsoleto: origin/main já está em $target"
      exit 3
    fi
    if [ "$tentativa" -ge 5 ]; then
      log "origin/main ainda não contém $expected"
      exit 1
    fi
    tentativa=$((tentativa + 1))
    sleep 10
    git fetch -q --prune origin main
    target=$(git rev-parse origin/main)
    if [ "$expected" = "$target" ]; then
      return 0
    fi
  done
}

conferir_antes() {
  local env_file="$root/deploy/seeder/.env" google_id google_secret
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log "alterações locais em $root: guarde ou descarte"
    exit 1
  fi
  # Uma árvore limpa ainda pode ter commits que não estão em origin/main; o
  # reset os deixaria só no reflog.
  if ! git merge-base --is-ancestor HEAD "$target"; then
    log "commits locais em $root que não estão em origin/main: guarde-os num branch"
    exit 1
  fi
  if [ ! -f "$env_file" ]; then
    log "falta deploy/seeder/.env (copie de .env.example e defina VARANDA_DOMAIN)"
    exit 1
  fi
  # Lido, nunca executado: só a última linha VARANDA_DOMAIN=, sem aspas.
  domain=$(sed -n 's/^VARANDA_DOMAIN=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'")
  if ! [[ $domain =~ $domain_re ]]; then
    log 'VARANDA_DOMAIN ausente ou inválido em deploy/seeder/.env'
    exit 1
  fi
  # Do mesmo jeito: lida, nunca executada. Conferida antes de qualquer
  # mudança, para o compose up não falhar no meio da implantação.
  assoc=$(sed -n 's/^VARANDA_ASSOCIATION=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'")
  if ! [[ $assoc =~ $assoc_re ]]; then
    log 'VARANDA_ASSOCIATION ausente ou inválida em deploy/seeder/.env'
    exit 1
  fi
  # O cliente OAuth do serviço de conta (compose.web.yaml exige os dois).
  # Lidos do mesmo jeito, só para ver se estão vazios: o valor nunca vai para
  # o registro nem para quem chamou (o segredo, em especial).
  google_id=$(sed -n 's/^VARANDA_GOOGLE_CLIENT_ID=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'")
  if [ -z "$google_id" ]; then
    log 'VARANDA_GOOGLE_CLIENT_ID ausente em deploy/seeder/.env'
    exit 1
  fi
  google_secret=$(sed -n 's/^VARANDA_GOOGLE_CLIENT_SECRET=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'")
  if [ -z "$google_secret" ]; then
    log 'VARANDA_GOOGLE_CLIENT_SECRET ausente em deploy/seeder/.env'
    exit 1
  fi
}

# A versão no ar é a última implantada por este script. Um git pull manual
# move HEAD sem mudar o que roda, então HEAD é só o último recurso.
versao_anterior() {
  local registro="$state/implantado"
  if [ -s "$registro" ]; then
    previous=$(head -n 1 "$registro")
    if [[ $previous =~ $sha_re ]] && git cat-file -e "$previous^{commit}" 2>/dev/null; then
      return 0
    fi
    log "registro da versão em produção inválido em $registro"
    exit 1
  fi
  previous=$(git rev-parse HEAD)
  sem_registro=1
  log "sem registro da versão em produção; usando HEAD ($previous)"
}

# Tudo que a volta precisa é guardado e conferido antes de mudar qualquer
# coisa: nunca se restaura um snapshot pela metade.
guardar_snapshots() {
  local tmp="$state/www-anterior.tmp" cid
  # A imagem do contêiner do semeador, não a etiqueta: um docker compose build
  # sem reiniciar move varanda-seeder:local para uma imagem que nunca rodou.
  # Parado também serve: um semeador que caiu ainda é a versão anterior.
  cid=$(conteiner_semeador)
  case "$cid" in
    '')
      log 'não há contêiner do semeador: suba-o uma vez à mão (README)'
      exit 1
      ;;
    *[!0-9a-f]*)
      log "mais de um contêiner do serviço seeder: $(printf '%s' "$cid" | tr '\n' ' ')"
      exit 1
      ;;
  esac
  image_anterior=$(docker inspect -f '{{.Image}}' "$cid")
  if [ -z "$image_anterior" ]; then
    log 'não foi possível ler a imagem do semeador em execução'
    exit 1
  fi
  docker image tag "$image_anterior" varanda-seeder:anterior
  if [ "$(docker image inspect -f '{{.Id}}' varanda-seeder:anterior)" != "$image_anterior" ]; then
    log 'a cópia da imagem anterior não confere'
    exit 1
  fi

  if [ ! -f "$www/index.html" ] || [ ! -f "$www/varanda-node.js" ]; then
    log 'deploy/seeder/www sem o app publicado: rode build-web.sh uma vez à mão (README)'
    exit 1
  fi
  rm -rf "$tmp"
  mkdir -m 0700 "$tmp"
  cp -a "$www/." "$tmp/"
  if [ ! -f "$tmp/index.html" ] || [ ! -f "$tmp/varanda-node.js" ]; then
    log 'a cópia de deploy/seeder/www não confere'
    exit 1
  fi
  rm -rf "$state/www-anterior"
  mv "$tmp" "$state/www-anterior"
  log "snapshot: commit $previous, imagem $image_anterior, www"
}

# Saúde do semeador pelo endpoint local: 200 só depois de seed ready.
aguardar_health() {
  local fim=$((SECONDS + 180)) code
  while [ "$SECONDS" -lt "$fim" ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 \
      http://127.0.0.1:8788/health || true)
    if [ "$code" = 200 ]; then
      return 0
    fi
    sleep 3
  done
  log 'o semeador não respondeu 200 em 127.0.0.1:8788/health em 180 s'
  return 1
}

# O Caddy responde o index.html (200) para qualquer caminho sem extensão, e
# um arquivo com extensão que falta é um 404 de verdade; mesmo assim um 200
# não prova nada: os bytes servidos precisam ser os de www. Sem --compressed
# o Caddy não comprime e a comparação é direta.
servido_igual() {
  local arquivo=$1 baixado="$state/sonda.tmp"
  rm -f "$baixado"
  if curl -fsS --connect-timeout 5 --max-time 10 -o "$baixado" "https://$domain/$2" \
    && cmp -s "$baixado" "$www/$arquivo"; then
    rm -f "$baixado"
    return 0
  fi
  rm -f "$baixado"
  return 1
}

# /varanda.json vem do Caddyfile, não de www. Pelo mesmo motivo, só um 200
# não basta (sem o handle, o fallback serviria index.html): o corpo precisa ser
# byte a byte o JSON com a associação de deploy/seeder/.env.
servido_json() {
  local baixado="$state/sonda.tmp" esperado="$state/sonda-esperado.tmp"
  rm -f "$baixado" "$esperado"
  if printf '{"v":1,"association":"%s"}' "$assoc" >"$esperado" \
    && curl -fsS --connect-timeout 5 --max-time 10 -o "$baixado" "https://$domain/varanda.json" \
    && cmp -s "$baixado" "$esperado"; then
    rm -f "$baixado" "$esperado"
    return 0
  fi
  rm -f "$baixado" "$esperado"
  return 1
}

# O serviço de conta pelo domínio: prova o handle /account/* do Caddy e o
# contêiner account. O fallback do Caddy também responderia 200, então o corpo
# precisa ser exatamente {"status":"ok"} seguido de LF (o serviço termina todo
# corpo JSON com uma quebra de linha: apps/cli/lib/account/server.js, send) e
# o tipo, JSON. /account/health responde ok mesmo sem emissor configurado (a
# cerimônia vem depois do deploy). Só esta URL fixa, sem consulta: nenhum
# código do Google passa aqui.
servido_conta() {
  local baixado="$state/sonda.tmp" esperado="$state/sonda-esperado.tmp" tipo
  rm -f "$baixado" "$esperado"
  if printf '%s\n' '{"status":"ok"}' >"$esperado" \
    && tipo=$(curl -fsS --connect-timeout 5 --max-time 10 -o "$baixado" -w '%{content_type}' \
      "https://$domain/account/health") \
    && [[ $tipo =~ $json_type_re ]] \
    && cmp -s "$baixado" "$esperado"; then
    rm -f "$baixado" "$esperado"
    return 0
  fi
  rm -f "$baixado" "$esperado"
  return 1
}

# O Caddyfile lido é o do checkout atual: depois que a volta faz o reset para
# um commit anterior ao /varanda.json (ou ao /account/*), a sonda dele não
# roda e a volta ainda passa na saúde. A primeira implantação com uma sonda
# nova roda o deploy.sh anterior (o bash já leu o arquivo inteiro antes do
# git reset), sem ela: essa primeira vez é conferida à mão, com curl.
# O mesmo vale para o sw.js e para o bundle com hash em /_expo/: a primeira
# implantação que traz estas sondas ainda roda o deploy.sh anterior, então
# elas só valem a partir da implantação seguinte, e essa primeira vez é
# conferida à mão, com curl. Uma volta para um www sem sw.js (ou sem bundle
# citado no index.html) ainda passa: a sonda só roda se o arquivo existe.
# O bundle prova que o Caddy serve o arquivo com hash, não o index.html.
aguardar_web() {
  local fim=$((SECONDS + 60)) json=0 conta=0 bundle
  if grep -q 'handle /varanda.json' "$root/deploy/seeder/Caddyfile"; then
    json=1
  fi
  if grep -q 'handle /account/\*' "$root/deploy/seeder/Caddyfile"; then
    conta=1
  fi
  bundle=$(grep -o '/_expo/static/js/web/index-[0-9a-f]*\.js' "$www/index.html" | head -n 1 || true)
  while [ "$SECONDS" -lt "$fim" ]; do
    if servido_igual index.html '' && servido_igual varanda-node.js varanda-node.js \
      && { [ "$json" = 0 ] || servido_json; } \
      && { [ ! -f "$www/sw.js" ] || servido_igual sw.js sw.js; } \
      && { [ -z "$bundle" ] || servido_igual "${bundle#/}" "${bundle#/}"; } \
      && { [ "$conta" = 0 ] || servido_conta; }; then
      return 0
    fi
    sleep 3
  done
  if [ "$conta" = 1 ]; then
    log "https://$domain/ não serve o app de deploy/seeder/www, /varanda.json com VARANDA_ASSOCIATION e /account/health em 60 s"
  elif [ "$json" = 1 ]; then
    log "https://$domain/ não serve o app de deploy/seeder/www e /varanda.json com VARANDA_ASSOCIATION em 60 s"
  else
    log "https://$domain/ não serve o app de deploy/seeder/www em 60 s"
  fi
  return 1
}

# Um upgrade de verdade pelo domínio, com o Origin de produção: prova o TLS,
# o proxy do Caddy e a lista de origens do semeador. GET sem upgrade não
# serve (o semeador responde 426 e só confere o Origin no upgrade).
sondar_ws() {
  local tentativa=0
  while [ "$tentativa" -lt 3 ]; do
    tentativa=$((tentativa + 1))
    if compose exec -T seeder node -e "$ws_script" "wss://$domain/seeder" "https://$domain"; then
      return 0
    fi
    sleep 5
  done
  log "o WebSocket wss://$domain/seeder não abriu com Origin https://$domain"
  return 1
}

# Sem && entre as etapas: cada falha precisa voltar com código diferente de
# zero para quem chamou (o main, onde ela dispara a volta).
verificar_saude() {
  if ! aguardar_health; then
    return 1
  fi
  if ! aguardar_web; then
    return 1
  fi
  if ! sondar_ws; then
    return 1
  fi
  log 'saúde: health 200, app servido, WebSocket aberto'
}

# O build do app web roda npm ci, com os scripts de instalação das
# dependências, como root num contêiner. Ele recebe só uma cópia exportada do
# commit, nunca o checkout: uma dependência maliciosa não reescreve os
# compose, o Caddyfile nem este script antes do compose up. Quem gera é o
# build-web.sh do checkout (já no commit testado), não o da cópia, e a cópia
# para www é feita aqui, só de arquivos e diretórios comuns: um link
# simbólico deixado pelo build levaria a cópia para fora (gravando como root
# no servidor) ou publicaria arquivos do servidor.
construir_web() {
  local base="$root/.deploy-build" stage dist p
  stage="$base/src"
  rm -rf "$base"
  mkdir -m 0700 "$base"
  mkdir "$stage"
  git archive "$target" | tar -x -C "$stage"
  # O build roda como nobody, o dono da cópia (o build-web.sh usa o dono do
  # diretório): sem root no contêiner, ele não deixa binário setuid de root.
  # E $base (0700, de root, fora do contêiner) impede que outro usuário do
  # servidor alcance o que o build deixar em $stage.
  chown -R 65534:65534 "$stage"
  bash deploy/seeder/build-web.sh "$stage"
  dist="$stage/apps/app/dist"
  for p in "$stage/apps" "$stage/apps/app" "$dist"; do
    if [ -L "$p" ] || [ ! -d "$p" ]; then
      log "o build deixou $p como link simbólico ou não diretório"
      return 1
    fi
  done
  if [ -n "$(find "$dist" ! -type f ! -type d -print -quit)" ]; then
    log 'o build gerou links simbólicos ou arquivos especiais em apps/app/dist'
    return 1
  fi
  if [ ! -f "$dist/index.html" ] || [ ! -f "$dist/varanda-node.js" ] || [ ! -f "$dist/sw.js" ]; then
    log 'o build não gerou index.html, varanda-node.js e sw.js'
    return 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=no)" ] \
    || [ "$(git rev-parse HEAD)" != "$target" ]; then
    log 'o checkout mudou durante o build'
    return 1
  fi
}

# Publica em www o app que construir_web gerou e conferiu. Fica para depois
# do build da imagem: se ele falhar, o site nunca serviu o app novo.
publicar_web() {
  local base="$root/.deploy-build"
  # www é um bind mount: troca-se o conteúdo, nunca o diretório.
  www_trocado=1
  find "$www" -mindepth 1 -delete
  cp -R "$base/src/apps/app/dist/." "$www/"
  rm -rf "$base"
}

# O sudoers dá root a este arquivo, que fica dentro do checkout: se alguém
# além de root puder escrevê-lo (ou aos diretórios acima dele no checkout),
# ganha root.
conferir_dono() {
  local p
  # O .git também: root roda git aqui, e quem escreve .git/config (um
  # core.fsmonitor, por exemplo) roda código como root.
  for p in "$root" "$root/deploy" "$root/deploy/seeder" "$root/deploy/seeder/deploy.sh" \
    "$root/.git" "$root/.git/config"; do
    if [ "$(stat -c '%u' "$p")" != 0 ] || [ -n "$(find "$p" -maxdepth 0 -perm /022)" ]; then
      morrer_cedo 1 "$p precisa ser de root e sem escrita para grupo ou outros"
    fi
  done
}

# A volta: roda com set +e, confere cada passo à mão e sempre sai com 1.
# Restaura o que foi guardado, sem reconstruir nada, e só o que a
# implantação chegou a mexer.
# shellcheck disable=SC2329 # chamada pelos traps ERR, INT e TERM.
voltar() {
  local falhas=0 motivo cid image_rodando
  if [ "${BASH_SUBSHELL:-0}" -gt 0 ]; then
    exit 1
  fi
  trap - ERR
  trap '' INT TERM
  set +e
  if [ "${1:-}" = sinal ]; then
    motivo='interrompida por sinal'
  else
    motivo="falha na linha ${BASH_LINENO[0]:-?}"
  fi
  log "implantação de $target: $motivo; voltando para $previous"
  # O motivo de uma falha do Caddy ou do semeador fica no registro do servidor.
  if [ "$servicos_trocados" = 1 ]; then
    compose logs --no-color --tail 50 seeder web account
    # Com um Caddyfile inválido o caddy run sai sem dizer por quê; o adapt
    # diz. Só diagnóstico: o resultado não muda a volta.
    compose run --rm --no-deps -T web caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  fi
  rm -rf "$root/.deploy-build"

  if ! git reset -q --hard "$previous"; then
    falhas=$((falhas + 1))
    log "volta: git reset para $previous falhou"
  fi
  # Sem registro, $previous é só o HEAD de antes, que um git pull manual pode
  # ter movido sem mudar o que rodava: imagem e www voltam, o commit não é
  # garantido.
  if [ "$sem_registro" = 1 ]; then
    falhas=$((falhas + 1))
    log "volta: sem registro da versão anterior; confira se $previous é o commit que rodava"
  fi
  if [ "$www_trocado" = 1 ]; then
    # www é um bind mount: troca-se o conteúdo, nunca o diretório.
    if ! { mkdir -p "$www" \
      && find "$www" -mindepth 1 -delete \
      && cp -a "$state/www-anterior/." "$www/"; }; then
      falhas=$((falhas + 1))
      log "volta: restaurar deploy/seeder/www falhou (a cópia está em $state/www-anterior)"
    fi
  fi
  # Um docker compose up --no-build depois usaria a etiqueta: ela volta a
  # apontar para a imagem anterior mesmo que os serviços não tenham mudado.
  if [ "$imagem_trocada" = 1 ]; then
    if ! docker image tag varanda-seeder:anterior varanda-seeder:local; then
      falhas=$((falhas + 1))
      log 'volta: restaurar a imagem varanda-seeder:anterior falhou'
    fi
  fi
  if [ "$servicos_trocados" = 0 ]; then
    log 'volta: o semeador e o Caddy não chegaram a ser trocados'
  else
    if ! compose up -d --no-build --force-recreate --remove-orphans; then
      falhas=$((falhas + 1))
      log 'volta: compose up falhou'
    fi
    if ! verificar_saude; then
      falhas=$((falhas + 1))
      log 'volta: a versão anterior não passou na verificação de saúde'
    fi
    cid=$(conteiner_semeador)
    image_rodando=''
    if [ -n "$cid" ]; then
      image_rodando=$(docker inspect -f '{{.Image}}' "$cid")
    fi
    if [ "$image_rodando" != "$image_anterior" ]; then
      falhas=$((falhas + 1))
      log "volta: o semeador roda a imagem ${image_rodando:-nenhuma}, não $image_anterior"
    fi
  fi

  if [ "$falhas" -eq 0 ]; then
    log "voltou para $previous"
  else
    log "volta falhou ($falhas passos): intervenção manual"
  fi
  exit 1
}

main() {
  if [ "$#" -ne 0 ]; then
    morrer_cedo 2 'uso: sem argumentos'
  fi
  if [ "$(id -u)" -ne 0 ]; then
    morrer_cedo 1 'exigido root'
  fi
  local cmd
  for cmd in git docker curl flock; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      morrer_cedo 1 "falta $cmd"
    fi
  done
  root="$(cd "$(dirname "$0")/../.." && pwd)"
  # Os compose e o build-web.sh usam caminhos relativos à raiz; sob sudo o
  # diretório atual é o $HOME de quem chamou.
  cd "$root"
  www="$root/deploy/seeder/www"
  conferir_dono

  preparar_estado
  pegar_lock
  preparar_registro
  isolar_saida
  trap ao_sair EXIT
  trap erro_antes ERR
  log "início (pid $$)"
  ler_sha
  escolher_alvo
  conferir_antes
  versao_anterior
  # A ponta já está no ar: só confere a saúde. Repetir a implantação não
  # muda nada e derruba o serviço por instantes (uma chave vazada não deve
  # conseguir isso em laço). Sem saúde, implanta de novo para consertar.
  if [ "$sem_registro" = 0 ] && [ "$previous" = "$target" ] \
    && [ "$(git rev-parse HEAD)" = "$target" ]; then
    if verificar_saude; then
      log "já implantado $target e saudável; nada a fazer"
      exit 0
    fi
    log "já implantado $target, mas sem saúde: implantando de novo"
  fi
  guardar_snapshots

  # Daqui em diante, qualquer falha volta para a versão anterior. Cada passo é
  # um comando solto (fora de if, || e &&) para que a falha chegue ao trap.
  # Um Ctrl-C ou SIGTERM no meio (a troca de www esvazia o diretório antes de
  # copiar) também volta.
  log "implantando $target (antes: $previous)"
  trap voltar ERR
  trap 'voltar sinal' INT TERM
  git reset -q --hard "$target"
  construir_web
  # Primeiro só a imagem: se o build dela falhar, nada que roda foi tocado.
  # Mas a etiqueta varanda-seeder:local já pode ter mudado: a volta a restaura.
  imagem_trocada=1
  compose build
  publicar_web
  servicos_trocados=1
  # Sem --remove-orphans aqui: ele também remove os contêineres avulsos de um
  # docker compose run (um seed list do operador, por exemplo). A volta usa.
  compose up -d --no-build
  # O Caddy só lê o Caddyfile ao iniciar (admin off): se ele mudou, ou se não
  # se sabe o que roda, o Caddy é recriado.
  if [ "$sem_registro" = 1 ] || ! git diff --quiet "$previous" "$target" -- deploy/seeder/Caddyfile; then
    compose up -d --force-recreate --no-deps web
  fi
  verificar_saude
  trap - ERR INT TERM

  # No ar e saudável: o resto não justifica voltar. Mas um registro velho
  # faria a próxima volta misturar versões: sem gravar o novo, apaga-se o
  # velho (a próxima implantação usa HEAD, que agora é $target).
  if ! { printf '%s\n' "$target" >"$state/implantado.tmp" \
    && mv -f "$state/implantado.tmp" "$state/implantado"; }; then
    if ! rm -f "$state/implantado"; then
      log "implantado $target, mas $state/implantado ficou com a versão antiga: apague-o à mão"
      exit 1
    fi
    log "aviso: não foi possível gravar $state/implantado; registro apagado"
  fi
  if ! docker image prune -f; then
    log 'aviso: docker image prune falhou'
  fi
  log "implantado $target"
  exit 0
}

main "$@"
