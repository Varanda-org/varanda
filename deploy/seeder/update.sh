#!/usr/bin/env bash
# Atualizador por imagem (pull) do semeador e da web, para servidores que
# deixam o deploy por SSH (.github/workflows/deploy.yml). Roda como root, pelo
# timer varanda-update.timer ou à mão, e só precisa de docker com o plugin
# compose v2, curl e flock: sem git, sem Node e sem jq no servidor.
#
#   update.sh install --image ghcr.io/varanda-org/varanda-seeder@sha256:<64 hex>
#   update.sh run          # o que o timer roda
#   update.sh check        # baixa, confere a assinatura e anota a versão disponível
#   update.sh apply        # aplica a versão do canal (ignora as recusadas)
#   update.sh reconfigure  # depois de editar /etc/varanda/varanda.env
#   update.sh rollback     # volta para a versão anterior
#   update.sh status
#   update.sh compose <argumentos do docker compose>
#
# Modelo de confiança: só roda uma imagem de ghcr.io/varanda-org/varanda-seeder
# assinada (cosign keyless) pelo workflow do canal em main. A assinatura é
# conferida com o cosign fixado no cosign.ref ao lado deste script (nunca o
# da imagem candidata), e o release.json da imagem assinada fixa por digest a
# imagem da web. Passo a passo no README, seção "Atualização por imagem (pull)".
#
# Códigos de saída: 0 feito ou nada a fazer; 1 falha (nada mudou, ou voltou
# para a versão anterior); 2 uso errado.
set -Eeuo pipefail

# Caminho fixo: sob sudo, pelo systemd ou com um ambiente estranho, os
# comandos são sempre os do sistema.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022
# Uma sessão SSH que cai não interrompe uma troca pela metade.
trap '' HUP PIPE

state=/var/lib/varanda-update
log_file="$state/update.log"
# O mesmo lock de deploy.sh: as duas ferramentas nunca rodam juntas.
lock_dir=/var/lib/varanda-deploy
lock_file="$lock_dir/lock"
# Enquanto este arquivo existir, deploy.sh se recusa a rodar.
marcador="$lock_dir/modo-pull"
conf_file=/etc/varanda/update.conf
env_padrao=/etc/varanda/varanda.env
releases=/opt/varanda-release
units_dir=/etc/systemd/system
# Acima disto o registro vira .1 (só uma geração guardada).
log_max_bytes=5242880
seeder_repo=ghcr.io/varanda-org/varanda-seeder
emissor=https://token.actions.githubusercontent.com
identidade_edge=https://github.com/Varanda-org/varanda/.github/workflows/release.yml@refs/heads/main
identidade_stable=https://github.com/Varanda-org/varanda/.github/workflows/promote.yml@refs/heads/main
sha_re='^[0-9a-f]{40}$'
digest_re='^sha256:[0-9a-f]{64}$'
seq_re='^[1-9][0-9]{0,9}$'
seeder_ref_re='^ghcr\.io/varanda-org/varanda-seeder@(sha256:[0-9a-f]{64})$'
web_ref_re='^ghcr\.io/varanda-org/varanda-web@sha256:[0-9a-f]{64}$'
# A linha inteira de /app/release.json (sem jq no servidor): chaves nesta
# ordem, sem espaços, a web só de ghcr.io/varanda-org/varanda-web por digest.
release_re='^\{"v":1,"commit":"([0-9a-f]{40})","seq":([1-9][0-9]{0,9}),"web":"(ghcr\.io/varanda-org/varanda-web@sha256:[0-9a-f]{64})"\}$'
cosign_re='^ghcr\.io/sigstore/cosign/cosign:v[0-9]+\.[0-9]+\.[0-9]+@sha256:[0-9a-f]{64}$'
# Dono root e nenhum acesso de grupo ou outros (saída de dono_modo).
privado_re='^0 ([0-7]*00|0)$'
# Dono root e sem escrita de grupo ou outros.
so_root_escreve_re='^0 [0-7]*[0145][0145]$'
# As regras de .env de deploy.sh, aqui para /etc/varanda/varanda.env (os
# testes comparam as faixas com cli.js e account.js, como os de deploy.sh).
domain_re='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
origem_re='^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[1-9][0-9]{0,4})?$'
assoc_re='^[0-9a-fA-F]{64}$'
json_type_re='^application/json( *;.*)?$'
moderator_re='^[^[:space:],@]+@[^[:space:],@]+$'
limite_re='^[1-9][0-9]{0,7}$'
limites_conta='VARANDA_MAX_MEMBERS:1:4096 VARANDA_ACCOUNT_MAX_CONNECTIONS:1:4096 VARANDA_ACCOUNT_RATE:1:10000 VARANDA_ACCOUNT_BURST:1:100000 VARANDA_ACCOUNT_MAX_PENDING:1:100000 VARANDA_INVITES_PER_WEEK:1:100 VARANDA_INVITE_DROPS:1:1 VARANDA_FEIRA_INVITES_PER_WEEK:1:100'
uso='uso: update.sh install --image ghcr.io/varanda-org/varanda-seeder@sha256:<64 hex> | run | check | apply | reconfigure | rollback | status | compose <argumentos>'

# O diretório real deste script: cosign.ref e well-known.sh vêm daqui, nunca
# da imagem candidata.
aqui=''
ref_install=''
modo=''
canal=''
perfil=''
identidade=''
cosign_ref=''
env_file=''
domain=''
assoc=''
# Preenchidos por ler_associacoes e lidos por gravar_associacoes (well-known.sh).
# shellcheck disable=SC2034
android_cert=''
# shellcheck disable=SC2034
ios_app_id=''
isolado=0
cand_digest=''
cand_seeder=''
cand_commit=''
cand_seq=''
cand_web=''
cand_dir=''
em_dia=0
# 1 quando preparar_versao substituiu um diretório que já existia.
recriar=0
# 0 em install --image: a preparada não é piso de uma imagem escolhida.
piso_preparada=1
# Para onde apontam o compose e a verificação de saúde: uma versão em
# $releases ou, na volta de um servidor que veio do checkout, o checkout.
alvo_dir=''
alvo_seeder=''
alvo_web=''
alvo_checkout=0
www=''
caddyfile=''
anterior_trocado=0
# Lidos de um registro de estado por ler_registro.
r_commit=''
r_seq=''
r_seeder=''
r_web=''

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

# Uma linha com data no registro e, depois de isolar a saída, também para
# quem chamou (fd 3: o terminal ou o journal do timer).
log() {
  local linha
  linha="$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"
  printf '%s\n' "$linha" || true
  if [ "$isolado" = 1 ]; then
    printf '%s\n' "$linha" >&3 2>/dev/null || true
  fi
}

# shellcheck disable=SC2329 # chamada pelo trap EXIT.
ao_sair() {
  local rc=$?
  if [ "$isolado" = 1 ] && [ "$rc" = 1 ]; then
    printf '%s\n' "detalhes no servidor: $log_file" >&3 2>/dev/null || true
  fi
}

# ERR antes do compose up: o que roda continua igual. Numa subshell só sai:
# quem trata é o shell principal, quando a falha chega até ele.
# shellcheck disable=SC2329 # chamada pelo trap ERR.
erro_antes() {
  if [ "${BASH_SUBSHELL:-0}" -gt 0 ]; then
    exit 1
  fi
  trap - ERR
  log "falha inesperada (linha ${BASH_LINENO[0]:-?}); nada do que roda foi alterado"
  exit 1
}

# O dono (uid) e o modo octal de um caminho, numa linha: "0 600".
dono_modo() {
  stat -c '%u %a' -- "$1"
}

preparar_estado() {
  (umask 077 && mkdir -p "$state" "$lock_dir")
  chmod 0700 "$state" "$lock_dir"
}

# Depois do lock: uma segunda execução esperando não gira o registro de
# quem está trabalhando.
preparar_registro() {
  if [ -f "$log_file" ] && [ "$(wc -c <"$log_file")" -gt "$log_max_bytes" ]; then
    mv -f "$log_file" "$log_file.1"
  fi
  (umask 077 && : >>"$log_file")
  chmod 0600 "$log_file"
}

# Toda a saída (a nossa e a do docker) vai para o registro; só log() escreve
# para quem chamou, pelo fd 3.
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
  log 'esperando outra atualização ou implantação terminar (até 600 s)'
  if ! flock -w 600 9; then
    log 'outra atualização ou implantação em curso'
    exit 1
  fi
}

# Tudo que um comando que mexe no servidor faz antes de começar.
comecar() {
  preparar_estado
  pegar_lock
  preparar_registro
  isolar_saida
  trap ao_sair EXIT
  trap erro_antes ERR
  log "$1 (pid $$, canal $canal, perfil $perfil, modo $modo)"
}

# Um valor de update.conf: lido, nunca executado. A última linha, espaço em
# volta do = aceito, aspas, CR e comentário no fim descartados.
ler_conf_valor() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$conf_file" | tail -n 1 | tr -d '\r"'"'" |
    sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//'
}

ler_conf() {
  modo=''
  canal=''
  perfil=''
  if [ -f "$conf_file" ]; then
    modo=$(ler_conf_valor VARANDA_UPDATE)
    canal=$(ler_conf_valor VARANDA_CHANNEL)
    perfil=$(ler_conf_valor VARANDA_PROFILE)
  fi
  # Sem padrão de propósito: trocar de versão sozinho é uma escolha de quem
  # opera o servidor.
  case $modo in
    auto | manual) ;;
    *) morrer_cedo 2 "defina VARANDA_UPDATE=auto ou manual em $conf_file" ;;
  esac
  case ${canal:-stable} in
    stable) canal=stable identidade=$identidade_stable ;;
    edge) identidade=$identidade_edge ;;
    *) morrer_cedo 2 "VARANDA_CHANNEL inválido em $conf_file (stable ou edge)" ;;
  esac
  case ${perfil:-seeder} in
    seeder) perfil=seeder ;;
    full) ;;
    *) morrer_cedo 2 "VARANDA_PROFILE inválido em $conf_file (seeder ou full)" ;;
  esac
}

# O arquivo de ambiente do compose. Tudo que o lê passa por $env_file, e só
# esta função decide qual é.
arquivo_env() {
  local dm
  env_file=''
  if [ -e "$env_padrao" ] || [ -L "$env_padrao" ]; then
    if [ -L "$env_padrao" ] || [ ! -f "$env_padrao" ]; then
      morrer_cedo 1 "$env_padrao precisa ser um arquivo comum"
    fi
    # Guarda segredos (o do OAuth, por exemplo): só root lê.
    dm=$(dono_modo "$env_padrao") || morrer_cedo 1 "não foi possível ler o dono de $env_padrao"
    if ! [[ $dm =~ $privado_re ]]; then
      morrer_cedo 1 "$env_padrao precisa ser de root, sem acesso para grupo ou outros (chmod 600)"
    fi
    env_file=$env_padrao
  elif [ "$perfil" = full ]; then
    morrer_cedo 1 "falta $env_padrao (o perfil full exige)"
  fi
}

# Root roda well-known.sh e confia em cosign.ref: se alguém além de root
# puder escrevê-los (ou ao diretório), ganha root.
conferir_dono_aqui() {
  local p dm
  for p in "$aqui" "$aqui/update.sh" "$aqui/well-known.sh" "$aqui/cosign.ref"; do
    if [ -L "$p" ] || [ ! -e "$p" ]; then
      morrer_cedo 1 "$p ausente ou link simbólico"
    fi
    dm=$(dono_modo "$p") || morrer_cedo 1 "não foi possível ler o dono de $p"
    if ! [[ $dm =~ $so_root_escreve_re ]]; then
      morrer_cedo 1 "$p precisa ser de root e sem escrita para grupo ou outros"
    fi
  done
}

# O checkout de onde o servidor veio, antes de root rodar o compose dele: o
# diretório e cada ancestral até a raiz, e os arquivos que o compose lê, de
# root e sem escrita para grupo ou outros (a regra de conferir_dono de
# deploy.sh). Fora dela, retorna 1.
conferir_checkout() {
  local dir=$1 p dm
  local -a caminhos=()
  p=$dir
  while :; do
    caminhos+=("$p")
    if [ "$p" = / ] || [ -z "$p" ]; then
      break
    fi
    p=$(dirname "$p")
  done
  for p in compose.yaml compose.web.yaml Caddyfile .env; do
    if [ -e "$dir/$p" ] || [ -L "$dir/$p" ]; then
      caminhos+=("$dir/$p")
    fi
  done
  for p in "${caminhos[@]}"; do
    if [ -L "$p" ]; then
      log "$p é um link simbólico; o checkout não é usado"
      return 1
    fi
    if ! dm=$(dono_modo "$p") || ! [[ $dm =~ $so_root_escreve_re ]]; then
      log "$p precisa ser de root e sem escrita para grupo ou outros; o checkout não é usado"
      return 1
    fi
  done
}

# Um campo de um registro de estado (linhas nome=valor). Lido, nunca executado.
ler_estado() {
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

# Lê commit, seq, seeder e web de um registro (atual, anterior, preparada) e
# confere a forma de cada um; fora dela, retorna 1.
ler_registro() {
  r_commit=''
  r_seq=''
  r_seeder=''
  r_web=''
  if [ ! -f "$1" ]; then
    return 1
  fi
  r_commit=$(ler_estado "$1" commit)
  r_seq=$(ler_estado "$1" seq)
  r_seeder=$(ler_estado "$1" seeder)
  r_web=$(ler_estado "$1" web)
  [[ $r_commit =~ $sha_re ]] && [[ $r_seq =~ $seq_re ]] \
    && [[ $r_seeder =~ $seeder_ref_re ]] && [[ $r_web =~ $web_ref_re ]]
}

# Grava um registro de estado com um rename: nunca fica pela metade.
gravar_estado() {
  local destino=$1
  if ! { printf 'commit=%s\nseq=%s\nseeder=%s\nweb=%s\n' "$2" "$3" "$4" "$5" >"$destino.tmp" \
    && mv -f "$destino.tmp" "$destino"; }; then
    rm -f "$destino.tmp" 2>/dev/null || true
    log "não foi possível gravar $destino"
    return 1
  fi
}

# Anota o motivo e o que fazer. Enquanto o arquivo existir, run não troca
# nada; um apply ou rollback explícito que dê certo o apaga.
marcar_intervencao() {
  local checkout=''
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >"$state/intervencao" 2>/dev/null || true
  log "intervenção manual: $1"
  if [ -f "$state/anterior" ] && [ "$(ler_estado "$state/anterior" origem)" = checkout ]; then
    checkout=$(ler_estado "$state/anterior" checkout)
    log "este servidor veio do checkout em $checkout: para voltar ao deploy por SSH, apague $marcador e rode 'bash deploy/seeder/deploy.sh </dev/null' na raiz do checkout antigo"
  fi
}

registrar_recusa() {
  if [ -z "$1" ]; then
    return 0
  fi
  if [ -f "$state/recusadas" ] && grep -qxF -- "$1" "$state/recusadas"; then
    return 0
  fi
  printf '%s\n' "$1" >>"$state/recusadas" || log "aviso: não foi possível anotar $1 em $state/recusadas"
}

recusada() {
  [ -f "$state/recusadas" ] && grep -qxF -- "$1" "$state/recusadas"
}

# O cosign fixado ao lado deste script, só na forma exata.
ler_cosign() {
  local linha=''
  if [ -f "$aqui/cosign.ref" ] && [ ! -L "$aqui/cosign.ref" ]; then
    linha=$(head -n 1 "$aqui/cosign.ref" | tr -d '\r')
  fi
  if ! [[ $linha =~ $cosign_re ]]; then
    log "cosign.ref ausente ou fora da forma ghcr.io/sigstore/cosign/cosign:v<versão>@sha256:<64 hex> em $aqui"
    return 1
  fi
  cosign_ref=$linha
}

# Assinatura keyless do workflow do canal, conferida por um contêiner do
# cosign sem privilégios, com raiz só leitura e um HOME em tmpfs para o cache.
verificar_assinatura() {
  local ref=$1
  if ! ler_cosign; then
    return 1
  fi
  if ! docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /cosign-home:rw,nosuid,nodev,noexec,size=64m,mode=1777 -e HOME=/cosign-home \
    "$cosign_ref" verify --certificate-identity "$identidade" \
    --certificate-oidc-issuer "$emissor" "$ref"; then
    log "a assinatura de $ref não confere com $identidade; nada mudou"
    return 1
  fi
  log "assinatura conferida: $ref ($identidade)"
}

# O digest para onde o canal aponta agora, lido da saída do próprio pull (o
# que foi baixado), nunca de uma consulta posterior à etiqueta.
baixar_canal() {
  local saida d
  if ! saida=$(docker pull "$seeder_repo:$canal" 2>&1); then
    printf '%s\n' "$saida"
    log "não foi possível baixar $seeder_repo:$canal"
    return 1
  fi
  printf '%s\n' "$saida"
  d=$(printf '%s\n' "$saida" | sed -n 's/^Digest: //p' | tail -n 1 | tr -d '\r')
  if ! [[ $d =~ $digest_re ]]; then
    log "o pull de $seeder_repo:$canal não informou um digest"
    return 1
  fi
  cand_digest=$d
  cand_seeder="$seeder_repo@$d"
}

# Uma imagem fixada por digest, dada por quem opera (install --image).
definir_candidato() {
  if ! [[ $1 =~ $seeder_ref_re ]]; then
    log "imagem fora da forma $seeder_repo@sha256:<64 hex>"
    return 1
  fi
  cand_digest=${BASH_REMATCH[1]}
  cand_seeder=$1
  if ! docker pull "$cand_seeder"; then
    log "não foi possível baixar $cand_seeder"
    return 1
  fi
}

# /app/release.json da imagem já conferida, lido por um contêiner sem rede,
# sem privilégios e com raiz só leitura. Os bytes precisam ser exatamente uma
# linha na forma de release_re mais LF.
ler_release() {
  local arquivo="$state/release.json.tmp" linha=''
  rm -f "$arquivo"
  if ! docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint cat "$cand_seeder" /app/release.json | head -c 1024 >"$arquivo"; then
    rm -f "$arquivo"
    log "não foi possível ler /app/release.json de $cand_seeder"
    return 1
  fi
  IFS= read -r linha <"$arquivo" || true
  if ! [[ $linha =~ $release_re ]]; then
    rm -f "$arquivo"
    log "release.json de $cand_seeder fora do formato esperado"
    return 1
  fi
  cand_commit=${BASH_REMATCH[1]}
  cand_seq=${BASH_REMATCH[2]}
  cand_web=${BASH_REMATCH[3]}
  if ! printf '%s\n' "$linha" | cmp -s - "$arquivo"; then
    rm -f "$arquivo"
    cand_commit=''
    cand_seq=''
    cand_web=''
    log "release.json de $cand_seeder tem mais que uma linha"
    return 1
  fi
  rm -f "$arquivo"
}

# Sem versão instalada, o piso é a preparada ou a anterior (uma volta ao
# checkout apaga atual): mais antiga é recusada; a mesma vale, porque o
# primeiro apply usa a versão que install preparou. install --image de uma
# imagem escolhida e conferida não tem o piso da preparada.
piso_sem_atual() {
  local f s
  for f in "$state/preparada" "$state/anterior"; do
    if [ ! -f "$f" ] || [ "$(ler_estado "$f" origem)" = checkout ]; then
      continue
    fi
    if [ "$f" = "$state/preparada" ] && [ "$piso_preparada" = 0 ]; then
      continue
    fi
    s=$(ler_estado "$f" seq)
    if ! [[ $s =~ $seq_re ]]; then
      log "registro $f inválido"
      return 1
    fi
    if [ "$cand_seq" -lt "$s" ]; then
      log "versão mais antiga que a registrada em $f: $cand_commit (seq $cand_seq; registrada seq $s). Se a registrada não deve mais valer, apague $f e rode de novo"
      return 1
    fi
  done
}

# check: o candidato (o canal, ou a imagem de install --image) contra a
# versão instalada. Em dia não confere mais nada; senão assinatura, release.json
# e seq, e só então anota em disponivel.
verificar() {
  local atual_seeder='' atual_seq
  em_dia=0
  if [ -n "${1:-}" ]; then
    if ! definir_candidato "$1"; then
      return 1
    fi
  elif ! baixar_canal; then
    return 1
  fi
  if [ -f "$state/atual" ]; then
    atual_seeder=$(ler_estado "$state/atual" seeder)
  fi
  if [ -n "$atual_seeder" ] && [ "$atual_seeder" = "$cand_seeder" ]; then
    em_dia=1
    log "em dia: $cand_seeder"
    return 0
  fi
  if ! verificar_assinatura "$cand_seeder"; then
    return 1
  fi
  if ! ler_release; then
    return 1
  fi
  if [ -f "$state/atual" ]; then
    atual_seq=$(ler_estado "$state/atual" seq)
    if ! [[ $atual_seq =~ $seq_re ]]; then
      log "registro $state/atual inválido"
      return 1
    fi
    if [ "$cand_seq" -le "$atual_seq" ]; then
      log "versão mais antiga que a instalada: $cand_commit (seq $cand_seq; instalada seq $atual_seq)"
      return 1
    fi
  elif ! piso_sem_atual; then
    return 1
  fi
  if ! gravar_estado "$state/disponivel" "$cand_commit" "$cand_seq" "$cand_seeder" "$cand_web"; then
    return 1
  fi
  log "versão verificada: $cand_commit (seq $cand_seq, canal $canal)"
}

# As regras de .env de deploy.sh (conferir_antes), para $env_file: valores
# lidos, nunca executados e nunca impressos. Esta parte vale para o perfil
# full (o Caddy e o serviço de conta).
conferir_env_web() {
  local google_id google_secret moderators item itens=0 nome limite entrada min max stats mods_lc stats_itens=0 saude saude_re triagem
  local por_semana='' sorteio='' feira_semana=''
  domain=$(sed -n 's/^VARANDA_DOMAIN=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'")
  if ! [[ $domain =~ $domain_re ]]; then
    log "VARANDA_DOMAIN ausente ou inválido em $env_file"
    return 1
  fi
  assoc=$(sed -n 's/^VARANDA_ASSOCIATION=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'")
  if ! [[ $assoc =~ $assoc_re ]]; then
    log "VARANDA_ASSOCIATION ausente ou inválida em $env_file"
    return 1
  fi
  # O cliente OAuth: só se estão vazios; o valor nunca vai para o registro.
  google_id=$(sed -n 's/^VARANDA_GOOGLE_CLIENT_ID=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'")
  if [ -z "$google_id" ]; then
    log "VARANDA_GOOGLE_CLIENT_ID ausente em $env_file"
    return 1
  fi
  google_secret=$(sed -n 's/^VARANDA_GOOGLE_CLIENT_SECRET=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'")
  if [ -z "$google_secret" ]; then
    log "VARANDA_GOOGLE_CLIENT_SECRET ausente em $env_file"
    return 1
  fi
  moderators=$(sed -n 's/^VARANDA_MODERATOR_EMAILS=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'" |
    sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
  if [ -n "$moderators" ]; then
    while IFS= read -r item; do
      item=${item#"${item%%[![:space:]]*}"}
      item=${item%"${item##*[![:space:]]}"}
      itens=$((itens + 1))
      if [ "$itens" -gt 32 ] || ! [[ $item =~ $moderator_re ]]; then
        log "VARANDA_MODERATOR_EMAILS inválido em $env_file"
        return 1
      fi
    done < <(printf '%s\n' "$moderators" | tr ',' '\n')
  fi
  # Como em deploy.sh: espaço em volta do = aceito e aspas mantidas (o
  # Compose as repassa ao serviço, que recusaria o valor).
  stats=$(sed -n 's/^[[:space:]]*VARANDA_STATS_EMAILS[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r' |
    sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
  if [ -n "$stats" ]; then
    mods_lc=$(sed -n 's/^[[:space:]]*VARANDA_MODERATOR_EMAILS[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r' |
      sed 's/[[:space:]]#.*$//')
    mods_lc=",$(printf '%s' "$mods_lc" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'),"
    while IFS= read -r item; do
      item=${item#"${item%%[![:space:]]*}"}
      item=${item%"${item##*[![:space:]]}"}
      item=$(printf '%s' "$item" | tr '[:upper:]' '[:lower:]')
      stats_itens=$((stats_itens + 1))
      if [ "$stats_itens" -gt 32 ] || ! [[ $item =~ $moderator_re ]] || [[ $mods_lc != *",$item,"* ]]; then
        log "VARANDA_STATS_EMAILS inválido em $env_file"
        return 1
      fi
    done < <(printf '%s\n' "$stats" | tr ',' '\n')
    saude=$(sed -n 's/^[[:space:]]*VARANDA_SEEDER_HEALTH[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r' |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
    saude_re='^http://(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})/?$'
    if [ -n "$saude" ] && { ! [[ $saude =~ $saude_re ]] || [ "${BASH_REMATCH[2]}" -gt 65535 ]; }; then
      log "VARANDA_SEEDER_HEALTH inválido em $env_file"
      return 1
    fi
  fi
  for entrada in $limites_conta; do
    nome=${entrada%%:*}
    min=${entrada#*:}
    max=${min#*:}
    min=${min%%:*}
    limite=$(sed -n "s/^[[:space:]]*${nome}[[:space:]]*=//p" "$env_file" | tail -n 1 | tr -d '\r' |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
    if [ -n "$limite" ] && { ! [[ $limite =~ $limite_re ]] || [ "$limite" -lt "$min" ] || [ "$limite" -gt "$max" ]; }; then
      log "$nome inválido em $env_file"
      return 1
    fi
    case $nome in
      VARANDA_INVITES_PER_WEEK) por_semana=$limite ;;
      VARANDA_INVITE_DROPS) sorteio=$limite ;;
      VARANDA_FEIRA_INVITES_PER_WEEK) feira_semana=$limite ;;
    esac
  done
  if [ -n "$sorteio" ] && [ -z "$por_semana" ]; then
    log "VARANDA_INVITE_DROPS exige VARANDA_INVITES_PER_WEEK em $env_file"
    return 1
  fi
  if [ -n "$feira_semana" ]; then
    if [ -z "$por_semana" ]; then
      log "VARANDA_FEIRA_INVITES_PER_WEEK exige VARANDA_INVITES_PER_WEEK em $env_file"
      return 1
    fi
    triagem=$(sed -n 's/^[[:space:]]*VARANDA_TRIAGE_TOKEN[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r' |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
    if [ -z "$triagem" ]; then
      log "VARANDA_FEIRA_INVITES_PER_WEEK exige VARANDA_TRIAGE_TOKEN em $env_file"
      return 1
    fi
  fi
}

# A parte das regras que fala de variáveis do semeador (origens públicas e
# limites, com as faixas de apps/cli/lib/cli.js): um valor fora delas
# derrubaria o semeador só depois da troca, e a volta usa o mesmo arquivo.
conferir_env_semeador() {
  local origem_feira origem_publicacao faixa limite minimo maximo valor
  origem_feira=$(sed -n 's/^[[:space:]]*VARANDA_FEIRA_ORIGIN[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r' |
    sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
  if [ -n "$origem_feira" ] && ! [[ $origem_feira =~ $origem_re ]]; then
    log "VARANDA_FEIRA_ORIGIN inválido em $env_file"
    return 1
  fi
  origem_publicacao=$(sed -n 's/^[[:space:]]*VARANDA_POSTS_ORIGIN[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r' |
    sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
  if [ -n "$origem_publicacao" ] && ! [[ $origem_publicacao =~ $origem_re ]]; then
    log "VARANDA_POSTS_ORIGIN inválido em $env_file"
    return 1
  fi
  for faixa in VARANDA_MAX_EXTERNAL:1:4096 VARANDA_MAX_SOCKETS:1:8192 \
    VARANDA_FRAME_MEMORY:8454144:1073741824 \
    VARANDA_MEDIA_MAX_IN_FLIGHT:1:1024 VARANDA_MEDIA_RATE:1:100000 VARANDA_MEDIA_BURST:1:100000 \
    VARANDA_INDEX_MAX_IN_FLIGHT:1:1024 VARANDA_INDEX_RATE:1:100000 VARANDA_INDEX_BURST:1:100000; do
    IFS=: read -r limite minimo maximo <<<"$faixa"
    valor=$(sed -n "s/^[[:space:]]*${limite}[[:space:]]*=//p" "$env_file" | tail -n 1 | tr -d '\r' |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -n "$valor" ] || continue
    # No máximo dez dígitos: a comparação inteira do bash não transborda.
    if ! [[ $valor =~ ^[1-9][0-9]{0,9}$ ]] || [ "$valor" -lt "$minimo" ] || [ "$valor" -gt "$maximo" ]; then
      log "$limite inválido em $env_file"
      return 1
    fi
  done
}

# O pré-voo do arquivo de ambiente, antes de tocar em qualquer coisa que roda.
# O perfil full confere tudo; o seeder, só a parte do semeador, e só se o
# arquivo existir.
conferir_env() {
  if [ -z "$env_file" ]; then
    return 0
  fi
  if [ ! -r "$env_file" ]; then
    log "não foi possível ler $env_file"
    return 1
  fi
  if [ "$perfil" = full ] && ! conferir_env_web; then
    return 1
  fi
  if ! conferir_env_semeador; then
    return 1
  fi
  if [ "$perfil" = full ] && ! ler_associacoes "$env_file"; then
    return 1
  fi
}

# O compose de uma versão: sempre do diretório real dela, com as imagens
# fixadas por digest. Sempre --no-build em quem sobe (o build dos compose
# nunca é usado aqui) e nunca --remove-orphans: ele removeria os contêineres
# avulsos de um docker compose run do operador.
compose_em() {
  local dir=$1 seeder=$2 web=$3 real
  shift 3
  local -a arquivos=(-f compose.yaml)
  local -a envs=()
  if [ "$perfil" = full ]; then
    arquivos+=(-f compose.web.yaml)
  fi
  arquivos+=(-f compose.release.yaml)
  if [ "$perfil" = full ]; then
    arquivos+=(-f compose.release.web.yaml)
  fi
  if [ -n "$env_file" ]; then
    envs=(--env-file "$env_file")
  fi
  real=$(readlink -f "$dir") || return 1
  (
    cd "$real" &&
      VARANDA_SEEDER_IMAGE=$seeder VARANDA_WEB_IMAGE=$web \
        docker compose -p varanda-seeder ${envs[@]+"${envs[@]}"} "${arquivos[@]}" "$@"
  )
}

# O compose do alvo atual: uma versão, ou o checkout antigo (com o .env, o
# Caddyfile e o www dele, o mesmo comando de deploy.sh).
compose_alvo() {
  if [ "$alvo_checkout" = 1 ]; then
    if [ "$perfil" = full ]; then
      (cd "$alvo_dir" && docker compose -f compose.yaml -f compose.web.yaml "$@")
    else
      (cd "$alvo_dir" && docker compose -f compose.yaml "$@")
    fi
    # Sempre com $?: no bash 5.2, um return sem número numa função chamada
    # pelo trap ERR devolve o status que disparou o trap.
    return $?
  fi
  compose_em "$alvo_dir" "$alvo_seeder" "$alvo_web" "$@"
}

alvo_versao() {
  alvo_checkout=0
  alvo_dir=$1
  alvo_seeder=$2
  alvo_web=$3
  www="$1/www"
  caddyfile="$1/Caddyfile"
}

# O checkout antigo: as imagens guardadas por install e o domínio e a
# associação do .env dele (lidos, nunca executados), para as sondas.
alvo_do_checkout() {
  alvo_checkout=1
  alvo_dir=$1
  alvo_seeder=varanda-seeder:antes-do-pull
  alvo_web=varanda-caddy:antes-do-pull
  www="$1/www"
  caddyfile="$1/Caddyfile"
  if [ "$perfil" = full ] && [ -f "$1/.env" ]; then
    domain=$(sed -n 's/^VARANDA_DOMAIN=//p' "$1/.env" | tail -n 1 | tr -d '\r"'"'")
    assoc=$(sed -n 's/^VARANDA_ASSOCIATION=//p' "$1/.env" | tail -n 1 | tr -d '\r"'"'")
  fi
}

# Só arquivos comuns e diretórios: um link simbólico levaria uma escrita de
# root para fora da árvore, ou publicaria arquivos do servidor.
conferir_arvore() {
  local achado
  if [ -L "$1" ] || [ ! -d "$1" ]; then
    log "$1 não é um diretório comum"
    return 1
  fi
  if ! achado=$(find "$1" ! -type f ! -type d -print -quit); then
    log "não foi possível conferir $1"
    return 1
  fi
  if [ -n "$achado" ]; then
    log "links simbólicos ou arquivos especiais em $1; recusado"
    return 1
  fi
}

# Nenhum dono ou modo da imagem vale aqui: tudo de root, diretórios 0755,
# arquivos 0644 e só os executáveis nomeados em 0755. Sem setuid, setgid nem
# sticky. Cinco dígitos: o chmod do GNU mantém setuid e setgid de um
# diretório com um modo de quatro.
normalizar_arvore() {
  local base=$1 f
  shift
  if ! chown -R 0:0 "$base" \
    || ! find "$base" -type d -exec chmod 00755 {} + \
    || ! find "$base" -type f -exec chmod 00644 {} +; then
    log "não foi possível acertar dono e modos em $base"
    return 1
  fi
  for f in "$@"; do
    if [ -f "$base/$f" ] && ! chmod 00755 "$base/$f"; then
      log "não foi possível acertar o modo de $base/$f"
      return 1
    fi
  done
}

# Copia um diretório de uma imagem por um contêiner criado e nunca iniciado.
copiar_da_imagem() {
  local imagem=$1 origem=$2 destino=$3 cid
  if ! cid=$(docker create --network none --entrypoint cat "$imagem"); then
    log "não foi possível criar um contêiner de $imagem"
    return 1
  fi
  if ! docker cp "$cid:$origem" "$destino"; then
    docker rm -f "$cid" >/dev/null 2>&1 || true
    log "não foi possível copiar $origem de $imagem"
    return 1
  fi
  docker rm -f "$cid" >/dev/null 2>&1 || true
}

# Etapa 2 (perfil full): o app web da imagem que o release.json assinado fixa
# por digest, com as associações e o version.json gravados por root.
preparar_www() {
  local destino="$1/www" f
  rm -rf "$destino"
  mkdir -m 0755 "$destino"
  if ! docker pull "$cand_web"; then
    log "não foi possível baixar $cand_web"
    return 1
  fi
  if ! copiar_da_imagem "$cand_web" /srv/web/. "$destino"; then
    return 1
  fi
  if ! conferir_arvore "$destino" || ! normalizar_arvore "$destino"; then
    return 1
  fi
  for f in index.html varanda-node.js sw.js; do
    if [ ! -f "$destino/$f" ]; then
      log "a imagem $cand_web não traz $f em /srv/web"
      return 1
    fi
  done
  if ! ler_associacoes "$env_file" || ! gravar_associacoes "$destino" \
    || ! gravar_versao "$destino" "$cand_commit"; then
    return 1
  fi
}

# Algum contêiner do projeto veio do compose em $1: ele monta arquivos de
# lá. Os serviços contam rodando ou parados; um avulso (compose run) só
# rodando: parado, ele monta o caminho de novo quando inicia, e a troca do
# diretório não o afeta. Sem resposta do docker, vale como montado.
montado() {
  local alvo ids avulsos id wd
  alvo=$(readlink -f "$1" 2>/dev/null || printf '%s' "$1")
  if ! ids=$(docker ps -a -q --filter label=com.docker.compose.project=varanda-seeder \
    --filter label=com.docker.compose.oneoff=False) \
    || ! avulsos=$(docker ps -q --filter label=com.docker.compose.project=varanda-seeder \
      --filter label=com.docker.compose.oneoff=True); then
    return 0
  fi
  ids="$ids $avulsos"
  for id in $ids; do
    if ! wd=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$id"); then
      return 0
    fi
    if [ "$wd" = "$alvo" ] || [ "$wd" = "$1" ]; then
      return 0
    fi
  done
  return 1
}

# Um diretório que já existe, reaproveitado: conferido e acertado como um
# recém-extraído.
reaproveitar() {
  if ! conferir_arvore "$1" || ! normalizar_arvore "$1" update.sh; then
    log "o diretório $1 não passou na conferência; nada mudou"
    return 1
  fi
  cand_dir=$1
  return 0
}

# Um diretório de versão em uso: o da versão instalada, o da anterior (a
# volta precisa dele), o de current com uma versão instalada (uma morte no
# meio de concluir) ou um que algum contêiner monta (uma morte entre o
# compose up e o registro). Sem atual, current só aponta para a versão que
# install preparou e que nada roda.
em_uso() {
  local nome=$1 dir="$releases/$1" cur
  if [ -f "$state/atual" ] && [ "$(ler_estado "$state/atual" commit)" = "$nome" ]; then
    return 0
  fi
  if [ -f "$state/anterior" ] && [ "$(ler_estado "$state/anterior" origem)" != checkout ] \
    && [ "$(ler_estado "$state/anterior" commit)" = "$nome" ]; then
    return 0
  fi
  if [ -f "$state/atual" ]; then
    cur=$(readlink "$releases/current" 2>/dev/null || true)
    if [ "${cur##*/}" = "$nome" ]; then
      return 0
    fi
  fi
  montado "$dir"
}

# Etapas 1 a 3, antes de tocar em qualquer coisa que roda: o pacote da
# imagem conferida, o www (perfil full), o pré-voo do arquivo de ambiente e
# do compose e, só então, o diretório final.
preparar_versao() {
  local dir="$releases/$cand_commit" tmp="$releases/$cand_commit.tmp" f dm instalada=''
  local -a exigidos=(compose.yaml compose.release.yaml update.sh well-known.sh cosign.ref varanda-update.service varanda-update.timer)
  cand_dir=''
  if [ "$perfil" = full ]; then
    exigidos+=(compose.web.yaml compose.release.web.yaml Caddyfile)
  fi
  if ! conferir_env; then
    log 'arquivo de ambiente recusado; nada mudou'
    return 1
  fi
  if [ -L "$releases" ] || ! mkdir -p "$releases"; then
    log "$releases precisa ser um diretório comum"
    return 1
  fi
  if ! dm=$(dono_modo "$releases") || ! [[ $dm =~ $so_root_escreve_re ]]; then
    log "$releases precisa ser de root e sem escrita para grupo ou outros; nada mudou"
    return 1
  fi
  rm -rf "$tmp"
  if ! copiar_da_imagem "$cand_seeder" /app/deploy/seeder "$tmp"; then
    rm -rf "$tmp"
    return 1
  fi
  if ! conferir_arvore "$tmp" || ! normalizar_arvore "$tmp" update.sh; then
    rm -rf "$tmp"
    return 1
  fi
  for f in "${exigidos[@]}"; do
    if [ ! -f "$tmp/$f" ]; then
      log "a versão $cand_commit não traz $f"
      rm -rf "$tmp"
      return 1
    fi
  done
  if [ "$perfil" = full ] && ! preparar_www "$tmp"; then
    rm -rf "$tmp"
    return 1
  fi
  if ! compose_em "$tmp" "$cand_seeder" "$cand_web" config -q; then
    log "docker compose config recusou a versão $cand_commit; nada mudou"
    rm -rf "$tmp"
    return 1
  fi
  if [ -e "$dir" ] || [ -L "$dir" ]; then
    # Os mesmos bytes (a mesma imagem, o mesmo arquivo de ambiente): o
    # diretório fica, e o que já o monta continua valendo. O diff segue links
    # e ignora dono e modo: o diretório é conferido e acertado de novo.
    if [ ! -L "$dir" ] && [ -d "$dir" ] && diff -r -q "$tmp" "$dir" >/dev/null 2>&1; then
      rm -rf "$tmp"
      if ! reaproveitar "$dir"; then
        return 1
      fi
      log "versão $cand_commit já preparada em $dir, com os mesmos arquivos"
      return 0
    fi
    if [ -f "$state/atual" ]; then
      instalada=$(ler_estado "$state/atual" commit)
    fi
    # Só as associações do app nativo mudaram (o arquivo de ambiente ganhou
    # VARANDA_IOS_APP_ID depois de um primeiro apply que falhou, por exemplo):
    # elas são regravadas no lugar, como no reconfigure, e o compose recria os
    # contêineres. A versão instalada nunca muda por aqui.
    if [ "$perfil" = full ] && [ "$instalada" != "$cand_commit" ] && [ ! -L "$dir" ] && [ -d "$dir" ] \
      && [ ! -L "$dir/www" ] && [ -d "$dir/www" ] \
      && diff -r -q -x .well-known "$tmp" "$dir" >/dev/null 2>&1; then
      if ! reaproveitar "$dir" || ! gravar_associacoes "$dir/www" \
        || ! diff -r -q "$tmp" "$dir" >/dev/null 2>&1; then
        log "não foi possível regravar as associações do app nativo em $dir/www"
        rm -rf "$tmp"
        return 1
      fi
      rm -rf "$tmp"
      recriar=1
      log "versão $cand_commit já preparada em $dir; associações do app nativo regravadas"
      return 0
    fi
    if em_uso "$cand_commit"; then
      log "a versão $cand_commit já está em uso com outros arquivos; nada mudou. Se sobraram contêineres de uma aplicação que falhou, remova-os com 'update.sh compose rm -sf' e rode update.sh apply de novo"
      rm -rf "$tmp"
      return 1
    fi
    rm -rf "$dir"
    # Um contêiner que montava o diretório apagado precisa ser recriado.
    recriar=1
  fi
  if ! mv "$tmp" "$dir"; then
    log "não foi possível mover $tmp para $dir"
    return 1
  fi
  cand_dir=$dir
  log "versão $cand_commit preparada em $dir"
}

# current troca por rename: nunca existe sem apontar para uma versão.
trocar_atual() {
  rm -f "$releases/current.tmp"
  ln -s "$1" "$releases/current.tmp" && mv -Tf "$releases/current.tmp" "$releases/current"
}

# O contêiner de um serviço, rodando ou parado. Por rótulo, para não pegar
# os avulsos de um docker compose run sem --rm.
conteiner_servico() {
  docker ps -a -q \
    --filter label=com.docker.compose.project=varanda-seeder \
    --filter "label=com.docker.compose.service=$1" \
    --filter label=com.docker.compose.oneoff=False
}

# A imagem que um serviço roda, ganhando uma etiqueta: uma imagem conhecida
# só pelo digest seria apagada pelo docker image prune.
etiquetar_rodando() {
  local servico=$1 etiqueta=$2 cid img
  cid=$(conteiner_servico "$servico") || return 1
  case $cid in
    '') return 0 ;;
    *[!0-9a-f]*)
      log "mais de um contêiner do serviço $servico"
      return 1
      ;;
  esac
  img=$(docker inspect -f '{{.Image}}' "$cid") || return 1
  if [ -z "$img" ] || ! docker image tag "$img" "$etiqueta" \
    || [ "$(docker image inspect -f '{{.Id}}' "$etiqueta")" != "$img" ]; then
    log "não foi possível guardar a imagem do serviço $servico como $etiqueta"
    return 1
  fi
}

# Garante a imagem local antes de qualquer compose (que nunca baixa sozinho
# no meio de uma troca): por digest, só baixa se faltar.
garantir_imagem() {
  if docker image inspect "$1" >/dev/null 2>&1; then
    return 0
  fi
  if ! docker pull "$1"; then
    log "não foi possível baixar $1"
    return 1
  fi
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

# Um 200 não prova nada (o Caddy responde index.html para qualquer caminho):
# os bytes servidos precisam ser os de www.
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

# /varanda.json vem do Caddyfile: o corpo precisa ser byte a byte o JSON com
# a associação do arquivo de ambiente.
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

# O serviço de conta pelo domínio: exatamente {"status":"ok"} mais LF, JSON.
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

# O painel de moderação sem cookie e sem seguir redirecionamento: 401, JSON e
# exatamente {"error":"nao-autorizado"} mais LF. Nunca pede o login (um fluxo
# OAuth) e nenhum cookie é enviado.
servido_moderacao() {
  local baixado="$state/sonda.tmp" esperado="$state/sonda-esperado.tmp" resposta
  rm -f "$baixado" "$esperado"
  if printf '%s\n' '{"error":"nao-autorizado"}' >"$esperado" \
    && resposta=$(curl -sS --connect-timeout 5 --max-time 10 -o "$baixado" \
      -w '%{http_code} %{content_type}' "https://$domain/account/mod/api/me") \
    && [[ $resposta =~ ^401\ (.*)$ ]] \
    && [[ ${BASH_REMATCH[1]} =~ $json_type_re ]] \
    && cmp -s "$baixado" "$esperado"; then
    rm -f "$baixado" "$esperado"
    return 0
  fi
  rm -f "$baixado" "$esperado"
  return 1
}

# O Caddyfile lido é o do alvo (a versão ou o checkout), e o www também: uma
# volta compara com o que ela mesma serve. A sonda da moderação roda sempre
# (todo alvo possível já tem as rotas).
aguardar_web() {
  local fim=$((SECONDS + 60)) json=0 conta=0 bundle
  if grep -q 'handle /varanda.json' "$caddyfile"; then
    json=1
  fi
  if grep -q 'handle /account/\*' "$caddyfile"; then
    conta=1
  fi
  bundle=$(grep -o '/_expo/static/js/web/index-[0-9a-f]*\.js' "$www/index.html" | head -n 1 || true)
  while [ "$SECONDS" -lt "$fim" ]; do
    if servido_igual index.html '' && servido_igual varanda-node.js varanda-node.js \
      && { [ "$json" = 0 ] || servido_json; } \
      && { [ ! -f "$www/sw.js" ] || servido_igual sw.js sw.js; } \
      && { [ ! -f "$www/version.json" ] || servido_igual version.json version.json; } \
      && { [ -z "$bundle" ] || servido_igual "${bundle#/}" "${bundle#/}"; } \
      && { [ "$conta" = 0 ] || servido_conta; } \
      && servido_moderacao; then
      return 0
    fi
    sleep 3
  done
  log "https://$domain/ não serve o app de $www, /varanda.json, /account/health e /account/mod/api/me como esperado em 60 s"
  return 1
}

# Um upgrade de verdade pelo domínio, com o Origin de produção.
sondar_ws() {
  local tentativa=0
  while [ "$tentativa" -lt 3 ]; do
    tentativa=$((tentativa + 1))
    if compose_alvo exec -T seeder node -e "$ws_script" "wss://$domain/seeder" "https://$domain"; then
      return 0
    fi
    sleep 5
  done
  log "o WebSocket wss://$domain/seeder não abriu com Origin https://$domain"
  return 1
}

# Cada serviço do perfil roda a imagem do alvo (pelo id): um compose up que
# não recriou um contêiner não passa.
conferir_imagens() {
  local id_seeder id_web servico esperado cid img
  local -a servicos=(seeder)
  if ! id_seeder=$(docker image inspect -f '{{.Id}}' "$alvo_seeder") || [ -z "$id_seeder" ]; then
    log "não foi possível ler o id de $alvo_seeder"
    return 1
  fi
  id_web=''
  if [ "$perfil" = full ]; then
    servicos+=(account web)
    if ! id_web=$(docker image inspect -f '{{.Id}}' "$alvo_web") || [ -z "$id_web" ]; then
      log "não foi possível ler o id de $alvo_web"
      return 1
    fi
  fi
  for servico in "${servicos[@]}"; do
    esperado=$id_seeder
    if [ "$servico" = web ]; then
      esperado=$id_web
    fi
    cid=$(conteiner_servico "$servico" || true)
    case $cid in
      '' | *[!0-9a-f]*)
        log "o serviço $servico não tem exatamente um contêiner"
        return 1
        ;;
    esac
    img=$(docker inspect -f '{{.Image}}' "$cid" || true)
    if [ "$img" != "$esperado" ]; then
      log "o serviço $servico roda a imagem ${img:-nenhuma}, não $esperado"
      return 1
    fi
  done
}

# Sem && entre as etapas: cada falha volta com código diferente de zero para
# quem chamou (aplicar, onde ela dispara a volta).
verificar_saude() {
  if ! aguardar_health; then
    return 1
  fi
  if [ "$perfil" = full ]; then
    if ! aguardar_web; then
      return 1
    fi
    if ! sondar_ws; then
      return 1
    fi
  fi
  if ! conferir_imagens; then
    return 1
  fi
  log 'saúde: health 200, imagens conferidas'
}

# Mantém só o diretório da versão nova, o de current e o da anterior.
limpar_versoes() {
  local p nome manter_atual='' manter_ant=''
  manter_atual=$(readlink "$releases/current" 2>/dev/null || true)
  manter_atual=${manter_atual##*/}
  if [ -f "$state/anterior" ] && [ "$(ler_estado "$state/anterior" origem)" != checkout ]; then
    manter_ant=$(ler_estado "$state/anterior" commit)
  fi
  for p in "$releases"/*; do
    nome=${p##*/}
    if ! [[ $nome =~ ^[0-9a-f]{40}(\.tmp)?$ ]]; then
      continue
    fi
    if [ "$nome" = "$cand_commit" ] || [ "$nome" = "$manter_atual" ] || [ "$nome" = "$manter_ant" ]; then
      continue
    fi
    rm -rf "$p" || log "aviso: não foi possível apagar $p"
  done
}

# O docker image prune não apaga uma imagem baixada por digest no store do
# containerd: as referências da versão que deixou de ser a anterior saem uma
# a uma, nunca as de atual nem as da nova anterior. Falha só avisa.
apagar_imagens_velhas() {
  local f ref manter=''
  f="$state/anterior.velho"
  if [ ! -f "$f" ] || [ "$(ler_estado "$f" origem)" = checkout ]; then
    return 0
  fi
  for ref in "$state/atual" "$state/anterior"; do
    if [ -f "$ref" ]; then
      manter="$manter $(ler_estado "$ref" seeder) $(ler_estado "$ref" web) "
    fi
  done
  for ref in "$(ler_estado "$f" seeder)" "$(ler_estado "$f" web)"; do
    if ! [[ $ref =~ $seeder_ref_re ]] && ! [[ $ref =~ $web_ref_re ]]; then
      continue
    fi
    case $manter in *" $ref "*) continue ;; esac
    docker image rm "$ref" || log "aviso: não foi possível apagar a imagem $ref"
  done
}

# Etapa 7: no ar e saudável. Daqui em diante nada justifica voltar.
concluir() {
  if ! trocar_atual "$cand_dir"; then
    log "aviso: não foi possível apontar $releases/current para $cand_dir"
  fi
  if ! gravar_estado "$state/atual" "$cand_commit" "$cand_seq" "$cand_seeder" "$cand_web"; then
    marcar_intervencao "atualizado para $cand_commit e saudável, mas $state/atual não foi gravado: grave-o à mão (commit=, seq=, seeder=, web=)"
    exit 1
  fi
  apagar_imagens_velhas
  rm -f "$state/disponivel" "$state/preparada" "$state/anterior.velho" "$state/intervencao"
  limpar_versoes
  if ! docker image prune -f; then
    log 'aviso: docker image prune falhou'
  fi
  log "atualizado para $cand_commit"
}

# Etapas 4 a 7 com a versão já preparada em $cand_dir. Uma falha ou um
# INT/TERM depois do compose up volta para a anterior.
aplicar() {
  if ! garantir_imagem "$cand_seeder"; then
    exit 1
  fi
  if [ "$perfil" = full ] && ! garantir_imagem "$cand_web"; then
    exit 1
  fi
  if ! etiquetar_rodando seeder varanda-seeder:anterior || ! etiquetar_rodando web varanda-caddy:anterior \
    || ! docker image tag "$cand_seeder" varanda-seeder:atual \
    || { [ "$perfil" = full ] && ! docker image tag "$cand_web" varanda-caddy:atual; }; then
    log 'não foi possível etiquetar as imagens; nada do que roda mudou'
    exit 1
  fi
  anterior_trocado=0
  rm -f "$state/anterior.velho"
  if [ -f "$state/atual" ]; then
    if { [ -f "$state/anterior" ] && ! cp -p "$state/anterior" "$state/anterior.velho"; } \
      || ! { cp "$state/atual" "$state/anterior.tmp" && mv -f "$state/anterior.tmp" "$state/anterior"; }; then
      log "não foi possível gravar $state/anterior; nada do que roda mudou"
      exit 1
    fi
    anterior_trocado=1
  fi
  alvo_versao "$cand_dir" "$cand_seeder" "$cand_web"
  log "aplicando $cand_commit (seq $cand_seq)"
  # Cada passo é um comando solto (fora de if, || e &&) para que a falha
  # chegue ao trap.
  local -a recriacao=()
  if [ "$recriar" = 1 ]; then
    recriacao=(--force-recreate)
  fi
  trap voltar ERR
  trap 'voltar sinal' INT TERM
  compose_alvo up -d --no-build ${recriacao[@]+"${recriacao[@]}"}
  verificar_saude
  trap - ERR INT TERM
  concluir
}

# A volta para a versão do registro anterior.
voltar_versao() {
  local dir falhas=0
  if ! ler_registro "$state/anterior"; then
    marcar_intervencao "registro $state/anterior inválido: sem volta automática"
    return 1
  fi
  dir="$releases/$r_commit"
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    marcar_intervencao "o diretório da versão anterior ($dir) não existe"
    return 1
  fi
  log "voltando para $r_commit"
  if ! garantir_imagem "$r_seeder" || { [ "$perfil" = full ] && ! garantir_imagem "$r_web"; }; then
    marcar_intervencao "as imagens da versão anterior ($r_commit) não estão disponíveis"
    return 1
  fi
  alvo_versao "$dir" "$r_seeder" "$r_web"
  if ! compose_alvo up -d --no-build --force-recreate; then
    falhas=$((falhas + 1))
    log 'volta: compose up falhou'
  fi
  if ! verificar_saude; then
    falhas=$((falhas + 1))
    log 'volta: a versão anterior não passou na verificação de saúde'
  fi
  if [ "$falhas" -ne 0 ]; then
    marcar_intervencao "a volta para $r_commit falhou ($falhas passos)"
    return 1
  fi
  log "voltou para $r_commit"
}

# A volta de um servidor que veio do deploy por SSH: as imagens guardadas por
# install voltam a ser as :local e o compose do próprio checkout as sobe, sem
# reconstruir nada (deploy.sh buscaria a ponta de main e reconstruiria). O
# marcador modo-pull fica: nada troca de caminho sozinho. Retorna 2 se o
# checkout voltou saudável, 1 se não.
voltar_checkout() {
  local dir falhas=0
  dir=$(ler_estado "$state/anterior" checkout)
  if [ -z "$dir" ] || [ -L "$dir" ] || [ ! -d "$dir" ] || [ ! -f "$dir/compose.yaml" ]; then
    marcar_intervencao "o checkout anterior (${dir:-desconhecido}) não existe ou não tem compose.yaml"
    return 1
  fi
  if ! conferir_checkout "$dir"; then
    marcar_intervencao "o checkout anterior ($dir) não passou na conferência de dono e modo: sem volta automática"
    return 1
  fi
  log "voltando para o checkout em $dir"
  if ! docker image tag varanda-seeder:antes-do-pull varanda-seeder:local; then
    falhas=$((falhas + 1))
    log 'volta: restaurar varanda-seeder:antes-do-pull como varanda-seeder:local falhou'
  fi
  if [ "$perfil" = full ] && ! docker image tag varanda-caddy:antes-do-pull varanda-caddy:local; then
    falhas=$((falhas + 1))
    log 'volta: restaurar varanda-caddy:antes-do-pull como varanda-caddy:local falhou'
  fi
  alvo_do_checkout "$dir"
  if ! compose_alvo up -d --no-build --force-recreate; then
    falhas=$((falhas + 1))
    log 'volta: compose up no checkout falhou'
  fi
  if ! verificar_saude; then
    falhas=$((falhas + 1))
    log 'volta: o checkout não passou na verificação de saúde'
  fi
  if [ "$falhas" -eq 0 ]; then
    marcar_intervencao "o servidor voltou ao checkout em $dir. Para seguir: corrija e rode update.sh apply, ou volte ao deploy por SSH apagando $marcador e desativando varanda-update.timer"
    return 2
  fi
  marcar_intervencao "a volta para o checkout em $dir falhou ($falhas passos)"
  return 1
}

# 0: de volta numa versão; 2: de volta no checkout (com intervenção); 1: falhou.
voltar_para_anterior() {
  if [ ! -f "$state/anterior" ]; then
    marcar_intervencao 'sem versão anterior para voltar'
    return 1
  fi
  if [ "$(ler_estado "$state/anterior" origem)" = checkout ]; then
    voltar_checkout
    return $?
  fi
  voltar_versao
}

# A volta de um apply: roda com set +e, confere cada passo e sempre sai com 1.
# shellcheck disable=SC2329 # chamada pelos traps ERR, INT e TERM.
voltar() {
  local motivo rc
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
  log "atualização para $cand_commit: $motivo; voltando"
  # O motivo de uma falha fica no registro do servidor.
  compose_alvo logs --no-color --tail 50
  registrar_recusa "$cand_digest"
  voltar_para_anterior
  rc=$?
  if [ "$rc" = 0 ]; then
    if [ "$anterior_trocado" = 1 ]; then
      if [ -f "$state/anterior.velho" ]; then
        mv -f "$state/anterior.velho" "$state/anterior"
      else
        rm -f "$state/anterior"
      fi
    fi
    log "voltou para a versão anterior; $cand_commit anotada em $state/recusadas"
  fi
  exit 1
}

# Sobe de novo a versão instalada (reconfigure, ou apply em dia depois de uma
# intervenção), com as associações regravadas e a verificação de saúde.
subir_instalada() {
  local dir
  if ! ler_registro "$state/atual"; then
    log "nenhuma versão instalada (ou $state/atual inválido): rode update.sh apply"
    return 1
  fi
  dir="$releases/$r_commit"
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    log "o diretório da versão instalada ($dir) não existe"
    return 1
  fi
  # Uma versão preparada no perfil seeder não tem o app web: o Caddy subiria
  # sem o que servir.
  if [ "$perfil" = full ] && { [ -L "$dir/www" ] || [ ! -d "$dir/www" ]; }; then
    log "a versão instalada ($dir) foi preparada sem o app web (perfil seeder) e o perfil agora é full: volte a VARANDA_PROFILE=seeder em $conf_file, ou rode update.sh apply quando sair a próxima versão, que é preparada com o app web"
    return 1
  fi
  if ! conferir_env; then
    log 'arquivo de ambiente recusado; nada mudou'
    return 1
  fi
  if [ "$perfil" = full ] && ! gravar_associacoes "$dir/www"; then
    return 1
  fi
  if ! garantir_imagem "$r_seeder" || { [ "$perfil" = full ] && ! garantir_imagem "$r_web"; }; then
    return 1
  fi
  alvo_versao "$dir" "$r_seeder" "$r_web"
  if ! compose_alvo up -d --no-build "$@"; then
    log 'compose up falhou'
    return 1
  fi
  if ! verificar_saude; then
    return 1
  fi
}

cmd_check() {
  comecar check
  if ! verificar; then
    exit 1
  fi
  if [ "$em_dia" = 0 ]; then
    log "disponível: $cand_commit; rode update.sh apply para aplicar"
  fi
  exit 0
}

# O que o timer roda.
cmd_run() {
  comecar run
  if [ -f "$state/intervencao" ]; then
    log "intervenção pendente: $(head -n 1 "$state/intervencao")"
    exit 1
  fi
  if [ ! -f "$state/atual" ]; then
    log 'instalação preparada, aguardando o primeiro apply'
    exit 0
  fi
  if ! verificar; then
    exit 1
  fi
  if [ "$em_dia" = 1 ]; then
    exit 0
  fi
  if [ "$modo" = manual ]; then
    log "nova versão disponível: $cand_commit; rode update.sh apply"
    exit 0
  fi
  if recusada "$cand_digest"; then
    log "a versão $cand_commit já voltou uma vez e não é aplicada de novo sozinha; rode update.sh apply para forçar"
    exit 0
  fi
  if ! preparar_versao; then
    exit 1
  fi
  aplicar
  exit 0
}

# Um apply explícito ignora as recusadas.
cmd_apply() {
  comecar apply
  if ! verificar; then
    exit 1
  fi
  if [ "$em_dia" = 1 ]; then
    if [ -f "$state/intervencao" ]; then
      if ! subir_instalada --force-recreate; then
        log 'a versão instalada não passou na verificação; a intervenção continua'
        exit 1
      fi
      rm -f "$state/intervencao"
      log "em dia em $r_commit e saudável; intervenção encerrada"
    fi
    exit 0
  fi
  if ! preparar_versao; then
    exit 1
  fi
  aplicar
  exit 0
}

# Depois de editar o arquivo de ambiente: as mesmas imagens, as associações
# regravadas e o compose up, sem troca de versão (deploy.sh faz o mesmo quando
# a ponta já está no ar).
cmd_reconfigure() {
  comecar reconfigure
  if ! subir_instalada; then
    log 'reconfiguração não concluída: confira o servidor'
    exit 1
  fi
  log "reconfigurado em $r_commit"
  exit 0
}

cmd_rollback() {
  local rc=0 digest=''
  comecar rollback
  if [ ! -f "$state/anterior" ]; then
    log 'sem versão anterior: nada a voltar'
    exit 1
  fi
  if [ -f "$state/atual" ]; then
    digest=$(ler_estado "$state/atual" seeder)
    digest=${digest#*@}
  fi
  if [ "$(ler_estado "$state/anterior" origem)" != checkout ] && ! conferir_env; then
    log 'arquivo de ambiente recusado; nada mudou'
    exit 1
  fi
  trap - ERR
  trap '' INT TERM
  voltar_para_anterior || rc=$?
  # O modo auto não reaplica a versão de que se voltou.
  if [[ $digest =~ $digest_re ]]; then
    registrar_recusa "$digest"
  fi
  case $rc in
    0)
      if ! gravar_estado "$state/atual" "$r_commit" "$r_seq" "$r_seeder" "$r_web"; then
        marcar_intervencao "voltou para $r_commit, mas $state/atual não foi gravado"
        exit 1
      fi
      rm -f "$state/anterior" "$state/anterior.velho" "$state/intervencao"
      if ! trocar_atual "$releases/$r_commit"; then
        log "aviso: não foi possível apontar $releases/current para $r_commit"
      fi
      log "rollback: voltou para $r_commit"
      exit 0
      ;;
    2)
      # O que roda é o checkout: nenhuma versão instalada, e um apply
      # depois volta a preparar tudo.
      rm -f "$state/atual"
      log 'rollback: o servidor voltou ao checkout'
      exit 0
      ;;
  esac
  exit 1
}

cmd_status() {
  local u
  printf 'modo: %s\ncanal: %s\nperfil: %s\n' "$modo" "$canal" "$perfil"
  if ler_registro "$state/atual"; then
    printf 'instalada: %s (seq %s)\n' "$r_commit" "$r_seq"
  else
    printf 'instalada: nenhuma\n'
  fi
  if ler_registro "$state/disponivel"; then
    printf 'disponível: %s (seq %s)\n' "$r_commit" "$r_seq"
  else
    printf 'disponível: nenhuma\n'
  fi
  if ler_registro "$state/preparada"; then
    printf 'preparada: %s (seq %s)\n' "$r_commit" "$r_seq"
  fi
  if [ -f "$state/anterior" ] && [ "$(ler_estado "$state/anterior" origem)" = checkout ]; then
    printf 'anterior: checkout em %s\n' "$(ler_estado "$state/anterior" checkout)"
  elif ler_registro "$state/anterior"; then
    printf 'anterior: %s (seq %s)\n' "$r_commit" "$r_seq"
  fi
  if [ -f "$state/intervencao" ]; then
    printf 'intervenção: %s\n' "$(head -n 1 "$state/intervencao")"
  else
    printf 'intervenção: nenhuma\n'
  fi
  for u in varanda-update.service varanda-update.timer; do
    if ! cmp -s "$units_dir/$u" "$releases/current/$u"; then
      printf 'aviso: %s difere da unidade da versão em uso; rode update.sh install --image <a imagem instalada> para atualizá-la\n' "$units_dir/$u"
    fi
  done
}

# O compose da versão em uso (ou da preparada), para quem opera: ps, logs,
# run --rm. A saída vai direto para o terminal.
cmd_compose() {
  if ! ler_registro "$state/atual" && ! ler_registro "$state/preparada"; then
    morrer_cedo 1 'nenhuma versão instalada ou preparada'
  fi
  if [ ! -d "$releases/current" ]; then
    morrer_cedo 1 "$releases/current não existe"
  fi
  compose_em "$releases/current" "$r_seeder" "$r_web" "$@"
}

instalar_unidades() {
  local u
  for u in varanda-update.service varanda-update.timer; do
    if ! install -m 0644 -o 0 -g 0 "$aqui/$u" "$units_dir/$u"; then
      log "não foi possível instalar $units_dir/$u"
      return 1
    fi
  done
  # Já em execução, com current apontando para a versão de install: um
  # primeiro apply que falha deixa o modo pull com um timer que anda e para
  # na intervenção (o lock serializa uma execução dele com esta).
  if ! systemctl daemon-reload || ! systemctl enable --now varanda-update.timer; then
    log 'não foi possível habilitar e iniciar varanda-update.timer'
    return 1
  fi
}

# Um servidor que vem do deploy por SSH: as imagens em execução ganham
# etiquetas que deploy.sh nunca reescreve, e o checkout vira a versão
# anterior (a volta da primeira troca).
guardar_checkout() {
  local dir=$1
  if ! etiquetar_rodando seeder varanda-seeder:antes-do-pull \
    || ! etiquetar_rodando web varanda-caddy:antes-do-pull; then
    log 'não foi possível guardar as imagens do checkout; nada do que roda mudou'
    return 1
  fi
  if ! { printf 'origem=checkout\ncheckout=%s\n' "$dir" >"$state/anterior.tmp" \
    && mv -f "$state/anterior.tmp" "$state/anterior"; }; then
    log "não foi possível gravar $state/anterior"
    return 1
  fi
  log "versão anterior: o checkout em $dir"
}

cmd_install() {
  local todos cid wd checkout='' arq
  arq=$(uname -m)
  if [ "$arq" != x86_64 ]; then
    morrer_cedo 1 "arquitetura $arq não suportada: as imagens publicadas são só amd64 (x86_64)"
  fi
  if ! docker compose version >/dev/null 2>&1; then
    morrer_cedo 1 'falta o plugin docker compose v2'
  fi
  if ! command -v systemctl >/dev/null 2>&1; then
    morrer_cedo 1 'falta systemctl'
  fi
  comecar install
  piso_preparada=0
  # A mesma imagem que quem opera conferiu à mão, conferida de novo antes de
  # confiar nela.
  if ! verificar "$ref_install"; then
    log 'instalação recusada; nada mudou'
    exit 1
  fi
  if [ -f "$state/atual" ]; then
    if ! instalar_unidades; then
      exit 1
    fi
    log "já instalado em $(ler_estado "$state/atual" commit): unidades atualizadas; para trocar de versão rode update.sh apply"
    exit 0
  fi
  if ! todos=$(docker ps -a -q --filter label=com.docker.compose.project=varanda-seeder \
    --filter label=com.docker.compose.oneoff=False); then
    log 'não foi possível listar os contêineres; nada mudou'
    exit 1
  fi
  if [ -n "$todos" ]; then
    # O perfil seeder migraria só o semeador: o Caddy e o serviço de conta
    # ficariam sem ninguém que os atualize (deploy.sh recusa no modo pull).
    if [ "$perfil" = seeder ] && { [ -n "$(conteiner_servico web || true)" ] \
      || [ -n "$(conteiner_servico account || true)" ]; }; then
      log "este servidor roda o Caddy ou o serviço de conta: defina VARANDA_PROFILE=full em $conf_file e rode install de novo; nada mudou"
      exit 1
    fi
    cid=$(conteiner_servico seeder || true)
    case $cid in
      '' | *[!0-9a-f]*)
        log 'o projeto varanda-seeder não tem exatamente um contêiner do semeador; nada mudou'
        exit 1
        ;;
    esac
    wd=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$cid" || true)
    case $wd in
      "$releases"/*) ;;
      *)
        checkout=''
        if [ -n "$wd" ]; then
          checkout=$(readlink -f "$wd" 2>/dev/null || true)
        fi
        if [ -z "$checkout" ] || [ ! -d "$checkout" ] || [ ! -f "$checkout/compose.yaml" ]; then
          log 'o semeador em execução não diz de qual checkout veio (rótulo com.docker.compose.project.working_dir) ou o diretório não tem compose.yaml; nada mudou'
          exit 1
        fi
        if ! conferir_checkout "$checkout"; then
          log 'checkout recusado; nada mudou'
          exit 1
        fi
        ;;
    esac
  fi
  if ! preparar_versao; then
    exit 1
  fi
  if ! printf 'instalado por update.sh em %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"$marcador"; then
    log "não foi possível gravar $marcador"
    exit 1
  fi
  # current antes do timer, nos dois caminhos: o ExecStart da unidade é
  # current/update.sh, e depois de uma migração que voltou ao checkout ele
  # precisa rodar para parar na intervenção (sem atual, nada lê current
  # como a versão que roda).
  if ! trocar_atual "$cand_dir"; then
    log "não foi possível apontar $releases/current para $cand_dir"
    exit 1
  fi
  if ! instalar_unidades; then
    exit 1
  fi
  if [ -n "$todos" ]; then
    if [ -n "$checkout" ] && ! guardar_checkout "$checkout"; then
      exit 1
    fi
    # Instalar é uma ação explícita: aplica uma vez, em qualquer modo.
    aplicar
    exit 0
  fi
  if ! gravar_estado "$state/preparada" "$cand_commit" "$cand_seq" "$cand_seeder" "$cand_web"; then
    log "não foi possível registrar a versão preparada em $cand_dir"
    exit 1
  fi
  log "instalação preparada em $cand_dir; nada foi iniciado. Antes do primeiro apply, faça a cerimônia de chaves do semeador da seção 'Atualização por imagem (pull)' do README e depois rode update.sh apply"
  exit 0
}

main() {
  local cmd=${1:-} c
  case $cmd in
    install | run | check | apply | reconfigure | rollback | status | compose) shift ;;
    *) morrer_cedo 2 "$uso" ;;
  esac
  case $cmd in
    install)
      if [ "$#" -ne 2 ] || [ "$1" != --image ] || ! [[ $2 =~ $seeder_ref_re ]]; then
        morrer_cedo 2 "$uso"
      fi
      ref_install=$2
      ;;
    compose)
      if [ "$#" -eq 0 ]; then
        morrer_cedo 2 "$uso"
      fi
      ;;
    *)
      if [ "$#" -ne 0 ]; then
        morrer_cedo 2 "$uso"
      fi
      ;;
  esac
  if [ "$(id -u)" -ne 0 ]; then
    morrer_cedo 1 'exigido root'
  fi
  for c in docker curl flock; do
    if ! command -v "$c" >/dev/null 2>&1; then
      morrer_cedo 1 "falta $c"
    fi
  done
  ler_conf
  arquivo_env
  aqui=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
  conferir_dono_aqui
  # Carregado só depois de conferir o dono: root roda o que estiver nele.
  # shellcheck source=deploy/seeder/well-known.sh
  . "$aqui/well-known.sh"
  case $cmd in
    install) cmd_install ;;
    run) cmd_run ;;
    check) cmd_check ;;
    apply) cmd_apply ;;
    reconfigure) cmd_reconfigure ;;
    rollback) cmd_rollback ;;
    status) cmd_status ;;
    compose) cmd_compose "$@" ;;
  esac
}

main "$@"
