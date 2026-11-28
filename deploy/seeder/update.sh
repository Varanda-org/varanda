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
#   update.sh secrets-key [--image ghcr.io/varanda-org/varanda-seeder@sha256:<64 hex>]
#
# Segredos compartilhados: o pacote da versão pode trazer secrets.sealed.json
# (varanda secrets seal). Com /etc/varanda/secrets-key.json (secrets-key), a
# imagem nova, já conferida, o abre sem rede, e o compose recebe
# $state/segredos/efetivo.env: varanda.env mais os nomes que ele deixa
# ausentes ou vazios. Um valor local não vazio sempre vence.
#
# Modelo de confiança: só roda uma imagem de ghcr.io/varanda-org/varanda-seeder
# assinada (cosign keyless) pelo workflow do canal em main. A assinatura é
# conferida com o cosign fixado no cosign.ref ao lado deste script (nunca o
# da imagem candidata), e o release.json da imagem assinada fixa por digest a
# imagem da web (e o caddy.json, quando existe, a do Caddy). Passo a passo no
# README, seção "Atualização por imagem (pull)".
#
# Códigos de saída: 0 feito ou nada a fazer; 1 falha (nada mudou, ou voltou
# para a versão anterior); 2 uso errado.
set -Eeuo pipefail

# Caminho fixo: sob sudo, pelo systemd ou com um ambiente estranho, os
# comandos são sempre os do sistema.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022
# Estas três variáveis vêm só do deploy/seeder/.env, que este script confere.
# O docker compose prefere uma variável exportada no shell de quem chamou ao
# valor do .env: sem o unset, um VARANDA_TRUSTED_PROXIES herdado (0.0.0.0/0)
# chegaria ao Caddy sem passar pela conferência. Nada abaixo as lê do ambiente
# (o build do app as recebe explicitamente, já conferidas).
unset VARANDA_TRUSTED_PROXIES VARANDA_MEDIA_ORIGIN VARANDA_CDN_SECRET
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
# A chave X25519 deste servidor (secrets-key) e, de root e 0700, o ambiente
# efetivo do compose (efetivo.env), o da versão anterior e o candidato.
chave_segredos=/etc/varanda/secrets-key.json
segredos="$state/segredos"
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
# A imagem do Caddy, fixada por digest em /app/caddy.json, um arquivo à parte:
# o release.json fica como era, porque o update.sh das versões já instaladas o
# confere com a regex acima e recusaria uma chave nova. Sem caddy.json (versão
# antiga), o Caddy roda da imagem web e é recriado a cada versão, como antes.
caddy_ref_re='^ghcr\.io/varanda-org/varanda-caddy@sha256:[0-9a-f]{64}$'
caddy_json_re='^\{"v":1,"caddy":"(ghcr\.io/varanda-org/varanda-caddy@sha256:[0-9a-f]{64})"\}$'
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
uso='uso: update.sh install --image ghcr.io/varanda-org/varanda-seeder@sha256:<64 hex> | run | check | apply | reconfigure | rollback | status | compose <argumentos> | secrets-key [--image ghcr.io/varanda-org/varanda-seeder@sha256:<64 hex>]'
# Uma linha de `varanda secrets open`: NOME='valor', sem aspas simples nem
# barra invertida dentro do valor.
aberto_re="^([A-Z][A-Z0-9_]*)='[^'\\\\]*'\$"
# Os únicos nomes que um arquivo selado pode trazer (os de secrets.js): um
# arquivo aberto com qualquer outro nome é recusado inteiro.
nomes_segredos='VARANDA_DIDIT_API_KEY VARANDA_DIDIT_WORKFLOW_ID VARANDA_GOOGLE_CLIENT_ID VARANDA_GOOGLE_CLIENT_SECRET VARANDA_GIF_API_URL VARANDA_GIF_API_KEY VARANDA_GIF_MEDIA_HOSTS VARANDA_AUDIUS_API_KEY'
# Separa, no efetivo.env, as linhas de varanda.env das que vieram do arquivo
# selado (status lê os nomes depois dela). Um comentário para o compose.
marca_segredos='# segredos compartilhados (update.sh)'
chave_hex_re='^[0-9a-f]{64}$'

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
# /etc/varanda/varanda.env quando existe; env_file é ele ou um efetivo.env.
env_local=''
ref_chave=''
# 1: o candidato efetivo.env.novo existe; 0: sem segredos compartilhados.
segredos_novo=0
# O seq do arquivo selado do candidato, lido de secrets verify --json, e o
# sha256 dos bytes do mesmo arquivo (vazios sem conferência).
segredos_seq=''
segredos_hash=''
# O seq e o sha256 do arquivo selado que trocar_segredos pôs em uso (vazios
# quando o ambiente novo não traz segredos compartilhados): viram o piso em
# $segredos/seq depois da verificação de saúde, antes de $state/atual.
seq_trocado=''
hash_trocado=''
hash_re='^[0-9a-f]{64}$'
# 1 quando a última marcar_intervencao gravou $state/intervencao.
intervencao_gravada=0
# O piso: exatamente "<seq> <sha256>" e um LF.
piso_re='^([1-9][0-9]{0,9}) ([0-9a-f]{64})$'
# Uma linha, exatamente o resultado de secrets verify --json.
verificado_re='^\{"signer":"[0-9a-f]{64}","recipients":[1-9][0-9]*,"seq":([1-9][0-9]{0,9})\}$'
# As únicas mensagens do CLI com número que vão para o registro.
linha_quem_sela_re='^erro: lista de quem sela: chave (inválida|repetida) na linha [1-9][0-9]{0,4}$'
seq_segredos_max=4294967295
# 1 depois que esta execução (com o lock) começou a abrir segredos: ao_sair
# apaga o que sobrou de texto aberto. Um comando sem lock nunca apaga.
segredos_criados=0
# 1 na primeira passada do pré-voo: o cliente Google ainda pode vir do
# arquivo selado, e o candidato é conferido por inteiro depois.
adiar_google=0
domain=''
assoc=''
# A origem https do CDN de /media/* (VARANDA_MEDIA_ORIGIN, opcional): vazia,
# /varanda.json sai sem a chave media.
media_origin=''
# Os CIDRs do CDN em que o Caddy confia para ler o endereço do cliente
# (VARANDA_TRUSTED_PROXIES, opcional), separados por espaço. Vazio: ninguém é
# de confiança.
trusted_proxies=''
# O segredo que um CDN sem intervalos fixos (o Bunny) manda no cabeçalho
# X-Varanda-Edge (VARANDA_CDN_SECRET, opcional): 64 hex minúsculos. Vazio:
# nenhum pedido é tratado como vindo do CDN. Nunca impresso.
cdn_secret=''
# Preenchidos por ler_associacoes e lidos por gravar_associacoes (well-known.sh).
# shellcheck disable=SC2034
android_cert=''
# shellcheck disable=SC2034
ios_app_id=''
# shellcheck disable=SC2034
android_store_build=''
isolado=0
cand_digest=''
cand_seeder=''
cand_commit=''
cand_seq=''
cand_web=''
# Vazio quando a imagem não traz /app/caddy.json.
cand_caddy=''
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
# Com a imagem do Caddy, o web roda dela e monta o www e o Caddyfile por
# caminhos fixos em $releases (trocar_web): uma versão só de app não recria o
# Caddy. Vazio, o web roda da imagem web e monta o diretório da versão.
alvo_caddy=''
alvo_checkout=0
www=''
caddyfile=''
anterior_trocado=0
# Lidos de um registro de estado por ler_registro.
r_commit=''
r_seq=''
r_seeder=''
r_web=''
r_caddy=''
# A troca com revezamento (pode_revezar): 0 fora dela; 1 com os contêineres
# novos ao lado dos em uso; 2 depois de começar a parar os em uso.
revezar_fase=0
# Os serviços, os contêineres em uso (azuis) e os novos (verdes), na mesma
# ordem, e o motivo de um revezamento que seguiu na troca no lugar.
revezar_servicos=()
revezar_azuis=()
revezar_verdes=()
revezar_motivo=''
# 1 enquanto o diário desta execução existe. As linhas velho_* dele dizem se
# anterior.velho, efetivo.env.anterior.velho e seq.anterior.velho existiam
# na primeira gravação: a volta e retomar_revezamento desfazem a troca do
# anterior por elas, mesmo depois de uma volta pela metade.
revezar_diario=0
revezar_velhos=''
# Segundos de espera, por contêiner novo, pela linha "standby" no registro.
espera_revezamento=60
# Os ids de um serviço, preenchidos por listar_servico.
ids_servico=()
# Rodando, reiniciando e reinícios de um contêiner, numa linha.
formato_estado='{{.State.Running}} {{.State.Restarting}} {{.RestartCount}}'
estado_re='^(true|false) (true|false) [0-9]+$'

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
  # Texto aberto não sobrevive à execução que o criou (uma saída antecipada
  # ou um TERM). Só esta execução, com o lock, o criou.
  if [ "$segredos_criados" = 1 ]; then
    rm -rf "$segredos/abrir" "$segredos/efetivo.env.novo" "$segredos/conferir.out" "$segredos/conferir.err" \
      "$segredos/abrir.err" || true
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
# usar_env decide qual é: o efetivo.env da versão em uso ou varanda.env.
arquivo_env() {
  local dm
  env_file=''
  env_local=''
  if [ -e "$env_padrao" ] || [ -L "$env_padrao" ]; then
    if [ -L "$env_padrao" ] || [ ! -f "$env_padrao" ]; then
      morrer_cedo 1 "$env_padrao precisa ser um arquivo comum"
    fi
    # Guarda segredos (o do OAuth, por exemplo): só root lê.
    dm=$(dono_modo "$env_padrao") || morrer_cedo 1 "não foi possível ler o dono de $env_padrao"
    if ! [[ $dm =~ $privado_re ]]; then
      morrer_cedo 1 "$env_padrao precisa ser de root, sem acesso para grupo ou outros (chmod 600)"
    fi
    env_local=$env_padrao
  elif [ "$perfil" = full ]; then
    morrer_cedo 1 "falta $env_padrao (o perfil full exige)"
  fi
  # O ambiente efetivo da versão em uso, quando um apply o gravou.
  if [ -e "$segredos/efetivo.env" ] || [ -L "$segredos/efetivo.env" ]; then
    if [ -L "$segredos/efetivo.env" ] || [ ! -f "$segredos/efetivo.env" ]; then
      morrer_cedo 1 "$segredos/efetivo.env precisa ser um arquivo comum"
    fi
    dm=$(dono_modo "$segredos/efetivo.env") || morrer_cedo 1 "não foi possível ler o dono de $segredos/efetivo.env"
    if ! [[ $dm =~ $privado_re ]]; then
      morrer_cedo 1 "$segredos/efetivo.env precisa ser de root, sem acesso para grupo ou outros"
    fi
  fi
  usar_env "$segredos/efetivo.env"
}

# O arquivo de ambiente do compose: o efetivo dado, se existir (um arquivo
# comum), senão varanda.env, exatamente como sem segredos compartilhados.
usar_env() {
  if [ -f "$1" ] && [ ! -L "$1" ]; then
    env_file=$1
  else
    env_file=$env_local
  fi
  return 0
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
# confere a forma de cada um; fora dela, retorna 1. O caddy é opcional (um
# registro de antes da imagem do Caddy não o tem), mas, se existe, tem forma.
ler_registro() {
  r_commit=''
  r_seq=''
  r_seeder=''
  r_web=''
  r_caddy=''
  if [ ! -f "$1" ]; then
    return 1
  fi
  r_commit=$(ler_estado "$1" commit)
  r_seq=$(ler_estado "$1" seq)
  r_seeder=$(ler_estado "$1" seeder)
  r_web=$(ler_estado "$1" web)
  r_caddy=$(ler_estado "$1" caddy)
  [[ $r_commit =~ $sha_re ]] && [[ $r_seq =~ $seq_re ]] \
    && [[ $r_seeder =~ $seeder_ref_re ]] && [[ $r_web =~ $web_ref_re ]] \
    && { [ -z "$r_caddy" ] || [[ $r_caddy =~ $caddy_ref_re ]]; }
}

# Grava um registro de estado com um rename: nunca fica pela metade. A linha
# caddy= só existe quando a versão traz a imagem do Caddy.
gravar_estado() {
  local destino=$1 caddy=${6:-}
  if ! { { printf 'commit=%s\nseq=%s\nseeder=%s\nweb=%s\n' "$2" "$3" "$4" "$5" \
    && if [ -n "$caddy" ]; then printf 'caddy=%s\n' "$caddy"; fi; } >"$destino.tmp" \
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
  intervencao_gravada=0
  if printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" >"$state/intervencao" 2>/dev/null; then
    intervencao_gravada=1
  fi
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

# /app/caddy.json da mesma imagem conferida, lido do mesmo jeito. Ausente
# (test -e sai com 1), a versão segue com o Caddy da imagem web, como antes;
# qualquer outra saída (docker, imagem) adia a troca, como um release.json
# ilegível. Presente, precisa ser exatamente uma linha na forma de
# caddy_json_re mais LF.
ler_caddy() {
  local arquivo="$state/caddy.json.tmp" linha='' saida=0
  cand_caddy=''
  rm -f "$arquivo"
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint test "$cand_seeder" -e /app/caddy.json 2>/dev/null || saida=$?
  if [ "$saida" = 1 ]; then
    log "sem /app/caddy.json em $cand_seeder: o Caddy segue a imagem web"
    return 0
  fi
  if [ "$saida" != 0 ] || ! docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint cat "$cand_seeder" /app/caddy.json 2>/dev/null | head -c 1024 >"$arquivo" \
    || [ ! -s "$arquivo" ]; then
    rm -f "$arquivo"
    log "não foi possível ler /app/caddy.json de $cand_seeder (saída $saida); nada mudou"
    return 1
  fi
  IFS= read -r linha <"$arquivo" || true
  if [[ $linha =~ $caddy_json_re ]] && printf '%s\n' "$linha" | cmp -s - "$arquivo"; then
    cand_caddy=${linha#*\"caddy\":\"}
    cand_caddy=${cand_caddy%\"\}}
  fi
  rm -f "$arquivo"
  if ! [[ $cand_caddy =~ $caddy_ref_re ]]; then
    cand_caddy=''
    log "caddy.json de $cand_seeder fora do formato esperado"
    return 1
  fi
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
  if ! ler_release || ! ler_caddy; then
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
  if ! gravar_estado "$state/disponivel" "$cand_commit" "$cand_seq" "$cand_seeder" "$cand_web" "$cand_caddy"; then
    return 1
  fi
  log "versão verificada: $cand_commit (seq $cand_seq, canal $canal)"
}

# As regras de .env de deploy.sh (conferir_antes), para $env_file: valores
# lidos, nunca executados e nunca impressos. Esta parte vale para o perfil
# full (o Caddy e o serviço de conta).
conferir_env_web() {
  local google_id google_secret moderators item itens=0 nome limite entrada min max stats mods_lc stats_itens=0 saude saude_re triagem proxies_ok oct hex itens_proxy ip prefixo esquerda direita grupos dois_pontos
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
  # Só NOME=valor: o docker compose lê o .env com o próprio parser, que
  # também aceita "export NOME=valor" e "NOME: valor". A conferência abaixo
  # (sed) veria vazio, pularia as regras e o Caddy receberia o texto cru.
  for nome_cdn in VARANDA_MEDIA_ORIGIN VARANDA_TRUSTED_PROXIES VARANDA_CDN_SECRET; do
    if [ -n "$(grep -E "^[[:space:]]*(export[[:space:]]+)?$nome_cdn([^A-Za-z0-9_]|\$)" "$env_file" | grep -Ev "^[[:space:]]*$nome_cdn[[:space:]]*=")" ]; then
      log "$nome_cdn em $env_file fora do formato NOME=valor (sem export e sem ':'): o docker compose leria um valor que este script não confere"
      return 1
    fi
  done
  # Lida como as origens da Feira: opcional, e exatamente uma origem https.
  media_origin=$(sed -n 's/^[[:space:]]*VARANDA_MEDIA_ORIGIN[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r' |
    sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
  if [ -n "$media_origin" ] && ! [[ $media_origin =~ $origem_re ]]; then
    log "VARANDA_MEDIA_ORIGIN inválido em $env_file"
    return 1
  fi
  # Os CIDRs do CDN em que o Caddy confia para ler o endereço do cliente
  # (X-Forwarded-For): opcional (vazio: ninguém é de confiança), ou CIDRs IPv4
  # (prefixo de /8 a /32) e IPv6 (de /16 a /128) separados por um espaço.
  # Só os intervalos publicados do CDN cabem aqui: quem está num intervalo
  # confiável escolhe o próprio endereço, e um intervalo largo demais deixa
  # qualquer cliente fugir dos limites por endereço. Nada de private_ranges,
  # outra palavra ou chave: o valor entra no Caddyfile na hora de carregar.
  trusted_proxies=$(sed -n 's/^[[:space:]]*VARANDA_TRUSTED_PROXIES[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r' |
    sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
  if [ -n "$trusted_proxies" ]; then
    proxies_ok=0
    if [[ $trusted_proxies =~ ^[0-9a-fA-F:./\ ]+$ ]] && [[ $trusted_proxies != *'  '* ]]; then
      proxies_ok=1
      oct='(0|[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-5])'
      hex='[0-9a-fA-F]{1,4}'
      read -r -a itens_proxy <<<"$trusted_proxies"
      for item in "${itens_proxy[@]}"; do
        ip=${item%/*}
        prefixo=${item##*/}
        if [[ $item != */* ]] || ! [[ $prefixo =~ ^(0|[1-9][0-9]{0,2})$ ]]; then
          proxies_ok=0
        elif [[ $ip =~ ^$oct(\.$oct){3}$ ]]; then
          if [ "$prefixo" -lt 8 ] || [ "$prefixo" -gt 32 ]; then
            proxies_ok=0
          fi
        elif [[ $ip =~ ^[0-9a-fA-F:]+$ ]]; then
          if [ "$prefixo" -lt 16 ] || [ "$prefixo" -gt 128 ]; then
            proxies_ok=0
          elif [[ $ip =~ ^$hex(:$hex){7}$ ]]; then
            :
          elif [[ $ip == *::* ]]; then
            # Uma só abreviação '::': até 7 grupos no total.
            esquerda=${ip%%::*}
            direita=${ip#*::}
            if [ -n "$esquerda" ] && ! [[ $esquerda =~ ^$hex(:$hex)*$ ]]; then
              proxies_ok=0
            elif [ -n "$direita" ] && ! [[ $direita =~ ^$hex(:$hex)*$ ]]; then
              proxies_ok=0
            else
              grupos=0
              if [ -n "$esquerda" ]; then
                dois_pontos=${esquerda//[^:]/}
                grupos=$((${#dois_pontos} + 1))
              fi
              if [ -n "$direita" ]; then
                dois_pontos=${direita//[^:]/}
                grupos=$((grupos + ${#dois_pontos} + 1))
              fi
              if [ "$grupos" -gt 7 ]; then
                proxies_ok=0
              fi
            fi
          else
            proxies_ok=0
          fi
        else
          proxies_ok=0
        fi
      done
    fi
    if [ "$proxies_ok" != 1 ]; then
      log "VARANDA_TRUSTED_PROXIES inválido em $env_file: só CIDRs IPv4 (/8 a /32) e IPv6 (/16 a /128), separados por um espaço"
      return 1
    fi
  fi
  # O segredo do CDN (X-Varanda-Edge): opcional (vazio desliga), e exatamente
  # 64 dígitos hexadecimais minúsculos (openssl rand -hex 32). O valor nunca
  # vai para o registro, nem numa recusa: a mensagem só diz o formato.
  cdn_secret=$(sed -n 's/^[[:space:]]*VARANDA_CDN_SECRET[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r' |
    sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
  if [ -n "$cdn_secret" ] && ! [[ $cdn_secret =~ ^[0-9a-f]{64}$ ]]; then
    log "VARANDA_CDN_SECRET inválido em $env_file: só 64 dígitos hexadecimais minúsculos (openssl rand -hex 32)"
    return 1
  fi
  # Um CDN na frente de /media/* sem os CIDRs dele nem o segredo: todo pedido
  # chegaria com o endereço de um servidor do CDN, e os limites por endereço
  # (um por cliente) virariam um limite só para todos.
  if [ -n "$media_origin" ] && [ -z "$trusted_proxies" ] && [ -z "$cdn_secret" ]; then
    log "VARANDA_MEDIA_ORIGIN exige VARANDA_TRUSTED_PROXIES ou VARANDA_CDN_SECRET em $env_file: sem os CIDRs do CDN ou o segredo, todos os clientes de /media/* dividiriam um só limite por endereço"
    return 1
  fi
  # O cliente OAuth: só se estão vazios; o valor nunca vai para o registro.
  # Na primeira passada ele ainda pode vir do arquivo selado.
  if [ "$adiar_google" = 0 ]; then
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
    VARANDA_FRAME_MEMORY:8454144:1073741824 VARANDA_STORAGE_BYTES:1073741824:1125899906842624 \
    VARANDA_MEDIA_MAX_IN_FLIGHT:1:1024 VARANDA_MEDIA_RATE:1:100000 VARANDA_MEDIA_BURST:1:100000 \
    VARANDA_INDEX_MAX_IN_FLIGHT:1:1024 VARANDA_INDEX_RATE:1:100000 VARANDA_INDEX_BURST:1:100000; do
    IFS=: read -r limite minimo maximo <<<"$faixa"
    valor=$(sed -n "s/^[[:space:]]*${limite}[[:space:]]*=//p" "$env_file" | tail -n 1 | tr -d '\r' |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -n "$valor" ] || continue
    # No máximo dezesseis dígitos: o inteiro de 64 bits do bash compara até
    # 9999999999999999 sem transbordar (VARANDA_STORAGE_BYTES chega a 1 PiB).
    if ! [[ $valor =~ ^[1-9][0-9]{0,15}$ ]] || [ "$valor" -lt "$minimo" ] || [ "$valor" -gt "$maximo" ]; then
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

# O valor local de $1 em varanda.env (vazio sem ele): a última atribuição,
# aspas, CR e comentário no fim descartados. Nunca vai para o registro.
valor_local() {
  if [ -z "$env_local" ]; then
    return 0
  fi
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$env_local" | tail -n 1 | tr -d '\r"'"'" |
    sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//'
}

# Os nomes depois da última marca de um efetivo.env, separados por espaço
# (vazio sem o arquivo): nunca um valor.
nomes_compartilhados() {
  if [ ! -f "$1" ] || [ -L "$1" ]; then
    return 0
  fi
  awk -v m="$marca_segredos" '$0 == m { s = ""; on = 1; next }
    on && match($0, /^[A-Z][A-Z0-9_]*=/) { s = s " " substr($0, 1, RLENGTH - 1) }
    END { print s }' "$1"
}

# Os nomes compartilhados que o efetivo.env em uso traz e que o ambiente
# novo perderia (fora do candidato e vazios em varanda.env). Com $1=recusar
# (o timer), uma perda recusa a troca; senão (apply, reconfigure) só fica no
# registro. Só nomes, nunca valores.
conferir_perda_segredos() {
  local atuais novos='' nome perdidos=''
  atuais=$(nomes_compartilhados "$segredos/efetivo.env") || return 1
  if [ -z "$atuais" ]; then
    return 0
  fi
  if [ "$segredos_novo" = 1 ]; then
    novos=$(nomes_compartilhados "$segredos/efetivo.env.novo") || return 1
  fi
  for nome in $atuais; do
    case " $novos " in *" $nome "*) continue ;; esac
    if [ -n "$(valor_local "$nome")" ]; then
      continue
    fi
    perdidos="$perdidos $nome"
  done
  if [ -z "$perdidos" ]; then
    return 0
  fi
  if [ "$1" = recusar ]; then
    log "segredos compartilhados: a nova versão deixaria sem valor${perdidos}; nada mudou. Para subir sem eles, rode update.sh apply"
    return 1
  fi
  log "segredos compartilhados: seguindo sem${perdidos}, que a versão em uso tinha"
  return 0
}

# ": <linha>" quando a última linha de $1 (o erro padrão de um comando
# secrets) é uma mensagem conhecida do CLI, sem valor nenhum: uma assinatura
# fora da lista não se confunde com uma chave errada. Qualquer outra linha,
# que poderia trazer um valor, nunca vai para o registro.
mensagem_cli() {
  local linha=${1##*$'\n'}
  case $linha in
    'erro: arquivo selado inválido' | 'erro: arquivo de chave inválido' | \
      'erro: este arquivo é uma chave de assinatura, não a chave do servidor' | \
      'erro: versão do arquivo selado desconhecida' | 'erro: arquivo selado sem assinatura' | \
      'erro: o arquivo selado não foi assinado por uma chave da lista de quem sela' | \
      'erro: assinatura do arquivo selado inválida' | \
      'erro: lista de quem sela: nenhuma chave' | 'erro: lista de quem sela: mais de 16 chaves' | \
      'erro: arquivo selado grande demais: /segredos/selado.json' | \
      'erro: lista de quem sela grande demais: /segredos/assinantes.txt' | \
      'erro: o arquivo de chave pode ser lido por outros usuários (use chmod 600): /segredos/chave.json')
      printf ': %s' "$linha"
      return 0
      ;;
  esac
  if [[ $linha =~ $linha_quem_sela_re ]]; then
    printf ': %s' "$linha"
  fi
  return 0
}

# A linha "<seq> <sha256>" do arquivo $1 na saída (vazio sem o arquivo). Um
# arquivo que não seja exatamente essa linha e um LF retorna 1, com $2 (o que
# fazer) no registro.
ler_linha_piso() {
  local f=$1 n v=''
  if [ ! -e "$f" ] && [ ! -L "$f" ]; then
    return 0
  fi
  if [ ! -L "$f" ] && [ -f "$f" ] && n=$(wc -c <"$f" | tr -d ' ') && [ "$n" -le 76 ] \
    && v=$(cat "$f") && [[ $v =~ $piso_re ]] && [ "${BASH_REMATCH[1]}" -le "$seq_segredos_max" ] \
    && printf '%s\n' "$v" | cmp -s - "$f"; then
    printf '%s\n' "$v"
    return 0
  fi
  # Chamada dentro de $(...): o registro vai pelo erro padrão.
  log "segredos compartilhados: $f não é uma linha \"<seq> <sha256>\" (seq de 1 a $seq_segredos_max, sha256 em 64 hexadecimais minúsculos) num arquivo comum; nada mudou. $2" >&2
  return 1
}

# O piso de $segredos/seq (vazio sem o arquivo: o primeiro arquivo selado vale
# com qualquer seq). Sem piso legível, nada de arquivo selado novo.
ler_piso_segredos() {
  ler_linha_piso "$segredos/seq" "Para aceitar o seq do próximo arquivo selado, apague $segredos/seq"
}

# Grava a linha $2 em $1 com um rename (root, 0600).
gravar_linha_piso() {
  if [[ $2 =~ $piso_re ]] && [ ! -d "$1" ] && rm -f "$1.tmp" && (umask 077 && printf '%s\n' "$2" >"$1.tmp") \
    && chmod 0600 "$1.tmp" && mv -f "$1.tmp" "$1"; then
    return 0
  fi
  rm -f "$1.tmp" 2>/dev/null || true
  return 1
}

# Com um arquivo selado novo (segredos_novo=1), compara o seq e o sha256 dele
# com o piso. Seq maior passa; igual passa só com o mesmo sha256 (cada versão
# traz o mesmo arquivo). Menor, ou igual com outro conteúdo, com $1=recusar (o
# timer) recusa a troca, como uma perda de nomes; senão (apply, reconfigure,
# install) só fica no registro, e o piso segue depois da troca saudável.
conferir_seq_segredos() {
  local piso piso_seq piso_hash
  if [ "$segredos_novo" != 1 ]; then
    return 0
  fi
  if ! [[ $segredos_seq =~ $seq_re ]] || ! [[ $segredos_hash =~ $hash_re ]]; then
    log 'segredos compartilhados: o seq do arquivo selado não foi conferido; nada mudou'
    return 1
  fi
  piso=$(ler_piso_segredos) || return 1
  if [ -z "$piso" ]; then
    return 0
  fi
  piso_seq=${piso%% *}
  piso_hash=${piso#* }
  if [ "$segredos_seq" -gt "$piso_seq" ] || { [ "$segredos_seq" = "$piso_seq" ] && [ "$segredos_hash" = "$piso_hash" ]; }; then
    return 0
  fi
  if [ "$segredos_seq" = "$piso_seq" ]; then
    if [ "$1" = recusar ]; then
      log "segredos compartilhados: o arquivo selado da nova versão tem o mesmo seq $segredos_seq do último aplicado, com conteúdo diferente; nada mudou. Sele de novo com seq maior, ou rode update.sh apply"
      return 1
    fi
    log "segredos compartilhados: aplicando o arquivo selado com o mesmo seq $segredos_seq do último aplicado, com conteúdo diferente"
    return 0
  fi
  if [ "$1" = recusar ]; then
    log "segredos compartilhados: o arquivo selado da nova versão tem seq $segredos_seq, menor que o último aplicado $piso_seq; nada mudou. Para aplicar mesmo assim, rode update.sh apply"
    return 1
  fi
  log "segredos compartilhados: aplicando o arquivo selado com seq $segredos_seq, menor que o último aplicado $piso_seq"
  return 0
}

# Depois de uma troca saudável que pôs um arquivo selado em uso: o seq e o
# sha256 dele viram o piso, gravado com um rename (root, 0600). Sem gravar, o
# timer aceitaria de novo um arquivo mais velho: fica uma intervenção.
gravar_piso_segredos() {
  local f="$segredos/seq"
  if [ -z "$seq_trocado" ]; then
    return 0
  fi
  if [[ $seq_trocado =~ $seq_re ]] && [[ $hash_trocado =~ $hash_re ]] \
    && gravar_linha_piso "$f" "$seq_trocado $hash_trocado"; then
    log "segredos compartilhados: seq $seq_trocado (sha256 $hash_trocado) anotado em $f"
    seq_trocado=''
    hash_trocado=''
    return 0
  fi
  marcar_intervencao "a versão em uso aplicou o arquivo selado com seq $seq_trocado, mas $f não foi gravado: rode update.sh apply, ou grave nele a linha \"$seq_trocado $hash_trocado\" (root, 0600)"
  return 1
}

# Rollback: o efetivo.env.anterior volta a rodar, e o piso fica no maior entre
# o atual e a linha anotada com ele em $segredos/seq.anterior (o seq decide;
# com seq igual, fica o atual). Nunca desce. Roda antes da volta: morrer depois
# dela deixaria o piso abaixo do arquivo selado que roda.
subir_piso_anterior() {
  local sa="$segredos/seq.anterior" f="$segredos/seq" anotado piso
  anotado=$(ler_linha_piso "$sa" "Para voltar sem mexer no piso, apague $sa") || return 1
  if [ -z "$anotado" ]; then
    return 0
  fi
  piso=$(ler_piso_segredos) || return 1
  if [ -n "$piso" ] && [ "${piso%% *}" -ge "${anotado%% *}" ]; then
    return 0
  fi
  if ! gravar_linha_piso "$f" "$anotado"; then
    log "segredos compartilhados: não foi possível gravar $f com o piso da versão anterior; nada mudou"
    return 1
  fi
  log "segredos compartilhados: seq ${anotado%% *} (sha256 ${anotado#* }) anotado em $f, o da versão anterior"
}

# O candidato: os bytes de varanda.env, um LF se ele não termina com um, e as
# linhas abertas só dos nomes que varanda.env deixa ausentes ou vazios (a
# última atribuição vale, como no compose). Chamada com umask 077: o arquivo
# nasce 0600. Nunca registra um valor.
juntar_segredos() {
  local aberto=$1 novo=$2 linha nome valor n=0 vistos=' ' rc=0
  # Só bytes ASCII imprimíveis: nada de tabulação, CR ou controle. grep sai
  # com 1 só quando leu tudo e não achou nenhum.
  LC_ALL=C grep -q '[^ -~]' "$aberto" || rc=$?
  if [ "$rc" != 1 ]; then
    log 'segredos compartilhados: o arquivo aberto tem bytes fora do ASCII imprimível'
    return 1
  fi
  # A busca do valor local abaixo só entende NOME=valor; o compose também lê
  # "export NOME=valor" e "NOME: valor", que perderiam para o compartilhado.
  if [ -n "$env_local" ]; then
    for nome in $nomes_segredos; do
      if grep -Eq "^[[:space:]]*(export[[:space:]]+${nome}([[:space:]]*[=:]|[[:space:]]*\$)|${nome}[[:space:]]*:)" "$env_local"; then
        log "$nome em $env_local usa export ou ':'; escreva NOME=valor; nada mudou"
        return 1
      fi
    done
  fi
  rm -f "$novo" || return 1
  : >"$novo" || return 1
  chmod 0600 "$novo" || return 1
  if [ -n "$env_local" ]; then
    cat "$env_local" >>"$novo" || return 1
    # $(...) tira os LF do fim: vazio quando o último byte é LF.
    if [ -n "$(tail -c 1 "$env_local")" ]; then
      printf '\n' >>"$novo" || return 1
    fi
  fi
  while IFS= read -r linha || [ -n "$linha" ]; do
    if ! [[ $linha =~ $aberto_re ]]; then
      log 'segredos compartilhados: uma linha aberta está fora do formato NOME=valor'
      return 1
    fi
    nome=${BASH_REMATCH[1]}
    case " $nomes_segredos " in
      *" $nome "*) ;;
      *)
        log "segredos compartilhados: o arquivo aberto traz $nome, que não é um nome compartilhado"
        return 1
        ;;
    esac
    case $vistos in
      *" $nome "*)
        log "segredos compartilhados: o arquivo aberto repete $nome"
        return 1
        ;;
    esac
    vistos="$vistos$nome "
    valor=$(valor_local "$nome") || return 1
    if [ -n "$valor" ]; then
      continue
    fi
    if [ "$n" = 0 ]; then
      printf '%s\n' "$marca_segredos" >>"$novo" || return 1
    fi
    printf '%s\n' "$linha" >>"$novo" || return 1
    n=$((n + 1))
  done <"$aberto"
  log "segredos compartilhados: $n variáveis aplicadas"
}

# Abre o secrets.sealed.json do pacote em $2 com a imagem $1 (já conferida,
# por digest), sem rede, só se assinado por um remetente de
# secrets-signers.txt do mesmo pacote (senão a saída 1), e prepara o candidato $segredos/efetivo.env.novo
# (segredos_novo=1). Sem arquivo selado, sem chave ou com a saída 3 (este
# servidor não é destinatário), o candidato é "sem segredos compartilhados"
# (segredos_novo=0). Com a chave, o seq e o sha256 do arquivo vão para segredos_seq e segredos_hash antes
# de abrir. Qualquer outra falha retorna 1 sem nada mudado.
preparar_segredos() {
  local imagem=$1 selado="$2/secrets.sealed.json" assinantes="$2/secrets-signers.txt" trabalho="$segredos/abrir" novo="$segredos/efetivo.env.novo" dm rc=0 saida='' erro=''
  segredos_novo=0
  segredos_seq=''
  segredos_hash=''
  if [ -L "$segredos" ] || ! (umask 077 && mkdir -p "$segredos") || ! chmod 0700 "$segredos"; then
    log "$segredos precisa ser um diretório comum"
    return 1
  fi
  # Uma execução que morreu no meio pode ter deixado o diretório de trabalho.
  segredos_criados=1
  rm -rf "$trabalho" "$novo" "$segredos/conferir.out" "$segredos/conferir.err" "$segredos/abrir.err" || return 1
  if [ ! -f "$selado" ]; then
    log 'segredos compartilhados: o pacote não traz secrets.sealed.json'
    return 0
  fi
  # Só um remetente da lista fixada no pacote (conferida com a imagem) vale.
  if [ -L "$assinantes" ] || [ ! -f "$assinantes" ]; then
    log 'segredos compartilhados: o pacote traz secrets.sealed.json sem secrets-signers.txt; nada mudou'
    return 1
  fi
  if [ ! -e "$chave_segredos" ] && [ ! -L "$chave_segredos" ]; then
    log "segredos compartilhados: sem $chave_segredos (update.sh secrets-key)"
    return 0
  fi
  if [ -L "$chave_segredos" ] || [ ! -f "$chave_segredos" ]; then
    log "$chave_segredos precisa ser um arquivo comum; nada mudou"
    return 1
  fi
  if ! dm=$(dono_modo "$chave_segredos") || [ "$dm" != '0 600' ]; then
    log "$chave_segredos precisa ser de root, modo 0600; nada mudou"
    return 1
  fi
  # O seq vem só da conferência da assinatura, sem a chave montada: a saída
  # é lida até 4 KB e só vale exatamente uma linha do formato esperado. No
  # registro, o código de saída e, do erro padrão, só uma mensagem conhecida.
  # Arquivos, e não $(...): no bash 3.2, com set -E, o trap ERR dentro da
  # substituição troca o código de saída por 1.
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
    --mount "type=bind,source=$selado,target=/segredos/selado.json,readonly" \
    --mount "type=bind,source=$assinantes,target=/segredos/assinantes.txt,readonly" \
    "$imagem" secrets verify --file /segredos/selado.json --signers /segredos/assinantes.txt --json \
    >"$segredos/conferir.out" 2>"$segredos/conferir.err" || rc=$?
  saida=$(head -c 4096 "$segredos/conferir.out" 2>/dev/null) || saida=''
  erro=$(tail -c 4096 "$segredos/conferir.err" 2>/dev/null) || erro=''
  rm -f "$segredos/conferir.out" "$segredos/conferir.err" || true
  if [ "$rc" != 0 ] || ! [[ $saida =~ $verificado_re ]] || [ "${BASH_REMATCH[1]}" -gt "$seq_segredos_max" ]; then
    log "não foi possível conferir o arquivo selado (saída $rc$(mensagem_cli "$erro")); nada mudou"
    return 1
  fi
  segredos_seq=${BASH_REMATCH[1]}
  # O piso guarda também o sha256 destes bytes: um mesmo seq com outro
  # conteúdo não passa como o arquivo já aplicado.
  if ! saida=$(sha256sum <"$selado") || ! [[ ${saida%% *} =~ $hash_re ]]; then
    segredos_seq=''
    log 'não foi possível calcular o sha256 do arquivo selado; nada mudou'
    return 1
  fi
  segredos_hash=${saida%% *}
  saida=''
  # Sempre um diretório novo e vazio: na saída 3 o comando deixa um --out que
  # já existia como estava, e só vale um aberto.env que esta execução gravou.
  if ! mkdir -m 0700 "$trabalho"; then
    log "não foi possível criar $trabalho; nada mudou"
    return 1
  fi
  # Do processo que segurou a chave, só o código de saída e uma mensagem
  # conhecida do erro padrão (lido até 4 KB) vão para o registro.
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
    --mount "type=bind,source=$chave_segredos,target=/segredos/chave.json,readonly" \
    --mount "type=bind,source=$selado,target=/segredos/selado.json,readonly" \
    --mount "type=bind,source=$assinantes,target=/segredos/assinantes.txt,readonly" \
    --mount "type=bind,source=$trabalho,target=/segredos/saida" \
    "$imagem" secrets open --key-file /segredos/chave.json --file /segredos/selado.json \
    --signers /segredos/assinantes.txt --out /segredos/saida/aberto.env >/dev/null 2>"$segredos/abrir.err" || rc=$?
  erro=$(tail -c 4096 "$segredos/abrir.err" 2>/dev/null) || erro=''
  rm -f "$segredos/abrir.err" || true
  case $rc in
    0) ;;
    3)
      rm -rf "$trabalho"
      log 'segredos compartilhados: este servidor não é destinatário'
      return 0
      ;;
    *)
      rm -rf "$trabalho"
      log "não foi possível abrir os segredos compartilhados (saída $rc$(mensagem_cli "$erro")); nada mudou"
      return 1
      ;;
  esac
  if [ -L "$trabalho/aberto.env" ] || [ ! -f "$trabalho/aberto.env" ]; then
    rm -rf "$trabalho"
    log 'segredos compartilhados: a abertura não gravou um arquivo comum; nada mudou'
    return 1
  fi
  rc=0
  umask 077
  juntar_segredos "$trabalho/aberto.env" "$novo" || rc=$?
  umask 022
  rm -rf "$trabalho"
  if [ "$rc" != 0 ]; then
    rm -f "$novo"
    log 'não foi possível montar o ambiente com os segredos compartilhados; nada mudou'
    return 1
  fi
  segredos_novo=1
}

# O candidato passa a ser o efetivo.env. Com $1=1 (a versão instalada vira a
# anterior), o efetivo.env atual vira efetivo.env.anterior, o piso em vigor é
# anotado com ele em seq.anterior, e os anteriores de antes ficam em .velho
# até concluir. Um arquivo ausente quer dizer "sem segredos compartilhados"
# (ou sem piso) e também é levado. Numa falha, desfaz o que trocou e retorna 1.
trocar_segredos() {
  local e="$segredos/efetivo.env" ea="$segredos/efetivo.env.anterior" sa="$segredos/seq.anterior" passo=0 piso=''
  if [ "$1" = 1 ]; then
    piso=$(ler_piso_segredos) || return 1
    rm -f "$ea.velho" "$sa.velho" || return 1
    if [ -f "$sa" ] && ! mv -f "$sa" "$sa.velho"; then
      return 1
    fi
    passo=1
    if [ -f "$ea" ] && ! mv -f "$ea" "$ea.velho"; then
      passo=-1
    fi
    if [ "$passo" = 1 ] && [ -n "$piso" ] && ! gravar_linha_piso "$sa" "$piso"; then
      passo=-1
    fi
    if [ "$passo" = 1 ]; then
      if [ -f "$e" ]; then
        mv -f "$e" "$ea" || passo=-1
      else
        rm -f "$ea" || passo=-1
      fi
    fi
    if [ "$passo" = -1 ]; then
      desfazer_anteriores
      return 1
    fi
    passo=2
  fi
  if [ "$segredos_novo" = 1 ]; then
    mv -f "$segredos/efetivo.env.novo" "$e" || passo=-2
  else
    rm -f "$e" || passo=-2
  fi
  if [ "$passo" = -2 ]; then
    if [ "$1" = 1 ]; then
      if [ -f "$ea" ]; then mv -f "$ea" "$e" || true; fi
      desfazer_anteriores
    fi
    return 1
  fi
  seq_trocado=''
  hash_trocado=''
  if [ "$segredos_novo" = 1 ]; then
    seq_trocado=$segredos_seq
    hash_trocado=$segredos_hash
  fi
  segredos_novo=0
  usar_env "$e"
}

# O efetivo.env.anterior e o seq.anterior de antes de trocar_segredos 1
# voltam do .velho (ou somem, se não havia).
desfazer_anteriores() {
  local ea="$segredos/efetivo.env.anterior" sa="$segredos/seq.anterior"
  if [ -f "$ea.velho" ]; then mv -f "$ea.velho" "$ea" || true; fi
  rm -f "$sa" || true
  if [ -f "$sa.velho" ]; then mv -f "$sa.velho" "$sa" || true; fi
}

# A volta: o efetivo.env da versão anterior (ou nenhum) volta a ser o do
# compose, por cópia, e efetivo.env.anterior continua com o registro anterior.
restaurar_segredos() {
  local e="$segredos/efetivo.env" ea="$segredos/efetivo.env.anterior" rc=0
  if [ -f "$ea" ] && [ ! -L "$ea" ]; then
    umask 077
    { rm -f "$e.tmp" && cp "$ea" "$e.tmp" && chmod 0600 "$e.tmp" && mv -f "$e.tmp" "$e"; } || rc=1
    umask 022
    if [ "$rc" != 0 ]; then
      rm -f "$e.tmp" || true
    fi
  else
    rm -f "$e" || rc=1
  fi
  usar_env "$e"
  # A origem do CDN que a sonda de /varanda.json espera é a do ambiente que
  # voltou, não a do candidato que falhou (conferir_env_web a deixou em
  # $media_origin): o Caddy da versão anterior serve o corpo dela.
  if [ "$perfil" = full ]; then
    media_origin=$(sed -n 's/^[[:space:]]*VARANDA_MEDIA_ORIGIN[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r' |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//') || media_origin=''
    if ! [[ $media_origin =~ $origem_re ]]; then
      media_origin=''
    fi
  fi
  return "$rc"
}

# O compose de uma versão: sempre do diretório real dela, com as imagens
# fixadas por digest. Sempre --no-build em quem sobe (o build dos compose
# nunca é usado aqui) e nunca --remove-orphans: ele removeria os contêineres
# avulsos de um docker compose run do operador.
#
# Com a imagem do Caddy ($4), o web roda dela e monta caminhos que não mudam
# de uma versão para outra: $releases inteiro em /srv (o Caddyfile serve
# /srv/web, o link $releases/web que trocar_web aponta para <commit>/www) e o
# Caddyfile por um nome que é o sha256 do conteúdo. Assim o compose só recria
# o web quando a imagem do Caddy ou o Caddyfile mudam. Sem ela, os binds
# relativos ./Caddyfile e ./www do diretório da versão, como antes.
compose_em() {
  local dir=$1 seeder=$2 web=$3 caddy=$4 real soma
  local caddyfile_src=./Caddyfile www_src=./www www_dst=/srv/web
  shift 4
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
  if [ "$perfil" = full ] && [ -n "$caddy" ]; then
    soma=$(soma_caddyfile "$real/Caddyfile") || return 1
    web=$caddy
    caddyfile_src="$releases/Caddyfile-$soma"
    www_src=$releases
    www_dst=/srv
  fi
  (
    cd "$real" &&
      VARANDA_CADDYFILE_SRC=$caddyfile_src VARANDA_WWW_SRC=$www_src VARANDA_WWW_DST=$www_dst \
        VARANDA_SEEDER_IMAGE=$seeder VARANDA_WEB_IMAGE=$web \
        docker compose -p varanda-seeder ${envs[@]+"${envs[@]}"} "${arquivos[@]}" "$@"
  )
}

# O sha256 de um Caddyfile (64 hexadecimais), o nome da cópia em $releases.
soma_caddyfile() {
  local saida
  if ! saida=$(sha256sum <"$1") || ! [[ ${saida%% *} =~ $hash_re ]]; then
    log "não foi possível calcular o sha256 de $1" >&2
    return 1
  fi
  printf '%s\n' "${saida%% *}"
}

# Link simbólico trocado por rename, como current: nunca some no meio.
trocar_link() {
  rm -f "$2.tmp"
  ln -s "$1" "$2.tmp" && mv -Tf "$2.tmp" "$2"
}

# O que o web monta no modo da imagem do Caddy, apontado para a versão em $1:
# a cópia do Caddyfile por sha256 (escrita uma vez, por rename, nunca alterada
# depois) e o link $releases/web, relativo para valer também dentro do
# contêiner (/srv/web -> /srv/<commit>/www). O link troca num rename, então o
# Caddy nunca serve um www pela metade, e o www antigo fica inteiro em disco.
trocar_web() {
  local dir=$1 nome soma destino
  nome=${dir##*/}
  if ! soma=$(soma_caddyfile "$dir/Caddyfile"); then
    return 1
  fi
  destino="$releases/Caddyfile-$soma"
  # Um compose up sem o arquivo deixaria um diretório no lugar dele.
  if [ -L "$destino" ] || { [ -e "$destino" ] && [ ! -f "$destino" ]; }; then
    rm -rf "$destino"
  fi
  if [ ! -f "$destino" ]; then
    rm -f "$destino.tmp"
    if ! { cp "$dir/Caddyfile" "$destino.tmp" && chmod 0644 "$destino.tmp" \
      && mv -f "$destino.tmp" "$destino"; }; then
      rm -f "$destino.tmp" 2>/dev/null || true
      log "não foi possível gravar $destino"
      return 1
    fi
  fi
  if ! trocar_link "$nome/www" "$releases/web"; then
    log "não foi possível apontar $releases/web para $nome/www"
    return 1
  fi
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
  compose_em "$alvo_dir" "$alvo_seeder" "$alvo_web" "$alvo_caddy" "$@"
}

alvo_versao() {
  alvo_checkout=0
  alvo_dir=$1
  alvo_seeder=$2
  alvo_web=$3
  alvo_caddy=${4:-}
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
  alvo_caddy=''
  www="$1/www"
  caddyfile="$1/Caddyfile"
  if [ "$perfil" = full ] && [ -f "$1/.env" ]; then
    domain=$(sed -n 's/^VARANDA_DOMAIN=//p' "$1/.env" | tail -n 1 | tr -d '\r"'"'")
    assoc=$(sed -n 's/^VARANDA_ASSOCIATION=//p' "$1/.env" | tail -n 1 | tr -d '\r"'"'")
    media_origin=$(sed -n 's/^[[:space:]]*VARANDA_MEDIA_ORIGIN[[:space:]]*=//p' "$1/.env" | tail -n 1 | tr -d '\r' |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
    if ! [[ $media_origin =~ $origem_re ]]; then
      media_origin=''
    fi
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
  # O www que o Caddy serve pelo link web.
  if [ "$(readlink "$releases/web" 2>/dev/null || true)" = "$nome/www" ]; then
    return 0
  fi
  montado "$dir"
}

# O candidato de uma preparação que falhou não serve para nada e guarda
# segredos: sai, e o compose volta ao ambiente da versão em uso.
descartar_candidato() {
  rm -f "$segredos/efetivo.env.novo" || true
  segredos_novo=0
  usar_env "$segredos/efetivo.env"
}

# Etapas 1 a 3, antes de tocar em qualquer coisa que roda: o pacote da
# imagem conferida, os segredos compartilhados, o www (perfil full), o
# pré-voo do arquivo de ambiente e do compose e, só então, o diretório final.
# Numa falha, o candidato dos segredos sai junto.
preparar_versao() {
  if montar_versao; then
    return 0
  fi
  descartar_candidato
  return 1
}

montar_versao() {
  local dir="$releases/$cand_commit" tmp="$releases/$cand_commit.tmp" f dm instalada=''
  local -a exigidos=(compose.yaml compose.release.yaml update.sh well-known.sh cosign.ref varanda-update.service varanda-update.timer)
  cand_dir=''
  if [ "$perfil" = full ]; then
    exigidos+=(compose.web.yaml compose.release.web.yaml Caddyfile)
  fi
  # Primeira passada, em varanda.env: o cliente Google pode vir do arquivo
  # selado, então o candidato é conferido por inteiro depois de aberto.
  env_file=$env_local
  adiar_google=1
  if ! conferir_env; then
    adiar_google=0
    log 'arquivo de ambiente recusado; nada mudou'
    return 1
  fi
  adiar_google=0
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
  # Daqui em diante o www, o pré-voo e o compose config leem o candidato,
  # nunca o efetivo.env da versão em uso.
  if ! preparar_segredos "$cand_seeder" "$tmp"; then
    rm -rf "$tmp"
    return 1
  fi
  usar_env "$segredos/efetivo.env.novo"
  if ! conferir_env; then
    log 'arquivo de ambiente recusado; nada mudou'
    rm -rf "$tmp"
    return 1
  fi
  if [ "$perfil" = full ] && ! preparar_www "$tmp"; then
    rm -rf "$tmp"
    return 1
  fi
  if ! compose_em "$tmp" "$cand_seeder" "$cand_web" "$cand_caddy" config -q; then
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
# a associação do arquivo de ambiente (e a origem do CDN, quando definida).
servido_json() {
  local baixado="$state/sonda.tmp" esperado="$state/sonda-esperado.tmp" media=''
  # Com VARANDA_MEDIA_ORIGIN o Caddyfile do alvo acrescenta "media" como
  # última chave. Um Caddyfile que não lê a variável (uma volta para uma
  # versão anterior) segue servindo o corpo antigo.
  if [ -n "$media_origin" ] && grep -q 'VARANDA_MEDIA_ORIGIN' "$caddyfile"; then
    media=$(printf ',"media":"%s"' "$media_origin")
  fi
  rm -f "$baixado" "$esperado"
  if printf '{"v":1,"association":"%s"%s}' "$assoc" "$media" >"$esperado" \
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
# (todo alvo possível já tem as rotas). A cópia do nó da versão
# (varanda-node-<versão>.js, a que a página carrega) sai da marca
# varanda-release do index.html, como o bundle: um www sem a marca pula a sonda.
aguardar_web() {
  local fim=$((SECONDS + 60)) json=0 conta=0 bundle versao
  if grep -q 'handle /varanda.json' "$caddyfile"; then
    json=1
  fi
  if grep -q 'handle /account/\*' "$caddyfile"; then
    conta=1
  fi
  bundle=$(grep -o '/_expo/static/js/web/index-[0-9a-f]*\.js' "$www/index.html" | head -n 1 || true)
  versao=$(versao_web "$www/index.html")
  while [ "$SECONDS" -lt "$fim" ]; do
    if servido_igual index.html '' && servido_igual varanda-node.js varanda-node.js \
      && { [ "$json" = 0 ] || servido_json; } \
      && { [ ! -f "$www/sw.js" ] || servido_igual sw.js sw.js; } \
      && { [ ! -f "$www/version.json" ] || servido_igual version.json version.json; } \
      && { [ -z "$bundle" ] || servido_igual "${bundle#/}" "${bundle#/}"; } \
      && { [ -z "$versao" ] || servido_igual "varanda-node-$versao.js" "varanda-node-$versao.js"; } \
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
  local tentativa=0 cid numero=''
  local -a indice=()
  # Depois de um revezamento o semeador é o contêiner 2 (ou outro), e o exec
  # do compose procura o 1 sem --index.
  cid=$(conteiner_servico seeder) || cid=''
  if [[ $cid =~ ^[0-9a-f]{1,64}$ ]]; then
    numero=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.container-number"}}' "$cid") || numero=''
  fi
  if [[ $numero =~ ^[1-9][0-9]{0,5}$ ]] && [ "$numero" != 1 ]; then
    indice=(--index "$numero")
  fi
  while [ "$tentativa" -lt 3 ]; do
    tentativa=$((tentativa + 1))
    if compose_alvo exec -T ${indice[@]+"${indice[@]}"} seeder node -e "$ws_script" "wss://$domain/seeder" "https://$domain"; then
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
  local id_seeder id_web servico esperado cid img img_web=${alvo_caddy:-$alvo_web}
  local -a servicos=(seeder)
  if ! id_seeder=$(docker image inspect -f '{{.Id}}' "$alvo_seeder") || [ -z "$id_seeder" ]; then
    log "não foi possível ler o id de $alvo_seeder"
    return 1
  fi
  id_web=''
  if [ "$perfil" = full ]; then
    servicos+=(account web)
    if ! id_web=$(docker image inspect -f '{{.Id}}' "$img_web") || [ -z "$id_web" ]; then
      log "não foi possível ler o id de $img_web"
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

# Mantém só o diretório da versão nova, o de current, o da anterior e o que
# o link web serve, e só as cópias do Caddyfile que um deles ainda usa.
limpar_versoes() {
  local p nome manter_atual='' manter_ant='' manter_web='' somas='' soma
  manter_atual=$(readlink "$releases/current" 2>/dev/null || true)
  manter_atual=${manter_atual##*/}
  manter_web=$(readlink "$releases/web" 2>/dev/null || true)
  manter_web=${manter_web%/www}
  if [ -f "$state/anterior" ] && [ "$(ler_estado "$state/anterior" origem)" != checkout ]; then
    manter_ant=$(ler_estado "$state/anterior" commit)
  fi
  for p in "$releases"/*; do
    nome=${p##*/}
    if ! [[ $nome =~ ^[0-9a-f]{40}(\.tmp)?$ ]]; then
      continue
    fi
    if [ "$nome" = "$cand_commit" ] || [ "$nome" = "$manter_atual" ] || [ "$nome" = "$manter_ant" ] \
      || [ "$nome" = "$manter_web" ]; then
      continue
    fi
    rm -rf "$p" || log "aviso: não foi possível apagar $p"
  done
  # Uma soma que falha deixa todas as cópias: sem ela, a cópia de uma versão
  # mantida pareceria sobra.
  for p in "$releases"/*/Caddyfile; do
    if [ ! -f "$p" ]; then
      continue
    fi
    if ! soma=$(soma_caddyfile "$p"); then
      log "aviso: as cópias $releases/Caddyfile-* ficam até a próxima limpeza"
      return 0
    fi
    somas="$somas $soma "
  done
  for p in "$releases"/Caddyfile-*; do
    nome=${p##*/Caddyfile-}
    if ! [[ $nome =~ $hash_re ]]; then
      continue
    fi
    case $somas in *" $nome "*) continue ;; esac
    rm -f "$p" || log "aviso: não foi possível apagar $p"
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
      manter="$manter $(ler_estado "$ref" seeder) $(ler_estado "$ref" web) $(ler_estado "$ref" caddy) "
    fi
  done
  for ref in "$(ler_estado "$f" seeder)" "$(ler_estado "$f" web)" "$(ler_estado "$f" caddy)"; do
    if ! [[ $ref =~ $seeder_ref_re ]] && ! [[ $ref =~ $web_ref_re ]] && ! [[ $ref =~ $caddy_ref_re ]]; then
      continue
    fi
    case $manter in *" $ref "*) continue ;; esac
    docker image rm "$ref" || log "aviso: não foi possível apagar a imagem $ref"
  done
}

# Etapa 7: no ar e saudável. Daqui em diante nada justifica voltar.
concluir() {
  local piso_ok=1 depois=''
  # O piso antes de $state/atual: morrer entre os dois só repete a mesma
  # versão, com seq igual ao piso. Se a gravação falha e a intervenção foi
  # escrita, a versão nova fica registrada como a instalada (o apply seguinte
  # passa pelo caminho em dia, que grava o piso sem mexer nos anteriores) e a
  # intervenção segura o timer; sem nem a intervenção, para antes de atual.
  if ! gravar_piso_segredos; then
    if [ "$intervencao_gravada" != 1 ] || [ ! -s "$state/intervencao" ]; then
      exit 1
    fi
    piso_ok=0
    depois='; depois, rode update.sh apply para gravar o piso dos segredos compartilhados'
  fi
  if ! trocar_atual "$cand_dir"; then
    log "aviso: não foi possível apontar $releases/current para $cand_dir"
  fi
  if ! gravar_estado "$state/atual" "$cand_commit" "$cand_seq" "$cand_seeder" "$cand_web" "$cand_caddy"; then
    marcar_intervencao "atualizado para $cand_commit e saudável, mas $state/atual não foi gravado: grave-o à mão (commit=, seq=, seeder=, web=${cand_caddy:+, caddy=})$depois"
    exit 1
  fi
  apagar_imagens_velhas
  rm -f "$state/disponivel" "$state/preparada" "$state/anterior.velho" \
    "$segredos/efetivo.env.anterior.velho" "$segredos/seq.anterior.velho"
  if [ "$piso_ok" = 1 ]; then
    rm -f "$state/intervencao"
  fi
  limpar_versoes
  if ! docker image prune -f; then
    log 'aviso: docker image prune falhou'
  fi
  if [ "$piso_ok" != 1 ]; then
    log "atualizado para $cand_commit, mas o piso dos segredos compartilhados não foi gravado; a intervenção continua: rode update.sh apply"
    exit 1
  fi
  log "atualizado para $cand_commit"
}

# A volta automática sobe a versão instalada com o ambiente dela (o
# efetivo.env atual, ou varanda.env sem ele), e o pré-voo de antes só
# conferiu o candidato por inteiro. Antes da troca, o ambiente da volta passa
# pela mesma conferência; o candidato volta a ser o do compose depois.
conferir_env_da_volta() {
  local candidato=$env_file rc=0
  if [ ! -f "$state/atual" ]; then
    return 0
  fi
  usar_env "$segredos/efetivo.env"
  conferir_env || rc=$?
  if [ "$rc" != 0 ]; then
    log "a volta automática para a versão instalada não subiria com $env_file; nada mudou. Mantenha esses valores em $env_padrao até instalar uma versão que os traga selados para este servidor, ou rode update.sh reconfigure se a versão instalada já os traz"
  fi
  env_file=$candidato
  if [ "$rc" = 0 ]; then
    # Os valores lidos (domínio, associações) voltam a ser os do candidato.
    conferir_env || rc=$?
  fi
  return "$rc"
}

# Os contêineres de um serviço (nunca os avulsos) em ids_servico, um por
# item. Uma saída que não seja só de ids é erro.
listar_servico() {
  local saida id
  ids_servico=()
  saida=$(conteiner_servico "$1") || return 1
  if [ -z "$saida" ]; then
    return 0
  fi
  mapfile -t ids_servico <<<"$saida"
  for id in "${ids_servico[@]}"; do
    if ! [[ $id =~ ^[0-9a-f]{1,64}$ ]]; then
      ids_servico=()
      return 1
    fi
  done
}

# A marca de que a versão sobe em espera: a variável no ambiente do serviço,
# numa linha própria (um comentário não conta).
traz_espera() {
  [ -f "$1" ] && [ ! -L "$1" ] && grep -qE '^[[:space:]]+VARANDA_START_WAIT:' "$1"
}

# O revezamento: o contêiner novo sobe ao lado do em uso e espera as portas
# e o lock dele (VARANDA_START_WAIT), sem nada aberto. Só quando as duas
# versões trazem a espera, nada é recriado à força e cada serviço tem um só
# contêiner, rodando. Qualquer erro do docker é não: vale a troca no lugar.
pode_revezar() {
  local commit inst f servico estado
  local -a arquivos=(compose.yaml) servicos=(seeder)
  if [ "$recriar" != 0 ] || [ "$alvo_checkout" != 0 ] || [ ! -f "$state/atual" ]; then
    return 1
  fi
  commit=$(ler_estado "$state/atual" commit) || return 1
  if ! [[ $commit =~ $sha_re ]] || [ -z "$cand_dir" ]; then
    return 1
  fi
  inst="$releases/$commit"
  if [ "$perfil" = full ]; then
    if [ -z "$cand_caddy" ]; then
      return 1
    fi
    arquivos+=(compose.web.yaml)
    servicos+=(account)
  fi
  for f in "${arquivos[@]}"; do
    if ! traz_espera "$inst/$f" || ! traz_espera "$cand_dir/$f"; then
      return 1
    fi
  done
  for servico in "${servicos[@]}"; do
    if ! listar_servico "$servico" || [ "${#ids_servico[@]}" != 1 ]; then
      return 1
    fi
    estado=$(docker inspect -f "$formato_estado" "${ids_servico[0]}") || return 1
    if ! [[ $estado =~ $estado_re ]] || [[ $estado != 'true false '* ]]; then
      return 1
    fi
  done
  return 0
}

# O diário do revezamento ($state/revezamento), linhas nome=valor gravadas
# por rename: o que uma execução seguinte (retomar_revezamento) precisa para
# desfazer uma troca interrompida.
gravar_revezamento() {
  local destino="$state/revezamento" texto i
  texto="commit=$cand_commit"$'\n'"digest=$cand_digest"$'\n'"fase=$revezar_fase"$'\n'"$revezar_velhos"
  for i in "${!revezar_servicos[@]}"; do
    texto+="azul_${revezar_servicos[$i]}=${revezar_azuis[$i]:-}"$'\n'
    texto+="verde_${revezar_servicos[$i]}=${revezar_verdes[$i]:-}"$'\n'
  done
  if ! { printf '%s' "$texto" >"$destino.tmp" && mv -f "$destino.tmp" "$destino"; }; then
    rm -f "$destino.tmp" 2>/dev/null || true
    log "não foi possível gravar $destino"
    return 1
  fi
  revezar_diario=1
}

# Para com a espera do compose (stop_grace_period, sem -t) e só então remove.
# Nunca rm -f nem kill: o contêiner pode estar com o store aberto.
parar_e_remover() {
  if ! docker stop "$1" >/dev/null; then
    log "não foi possível parar o contêiner $1"
    return 1
  fi
  if ! docker rm "$1" >/dev/null; then
    log "não foi possível remover o contêiner $1"
    return 1
  fi
}

# Para e remove, em cada serviço do revezamento, todo contêiner que não é o
# em uso. Sem o id do em uso, o serviço fica como está (e conta como falha).
remover_verdes() {
  local i id azul servico falhas=0
  for i in "${!revezar_servicos[@]}"; do
    servico=${revezar_servicos[$i]}
    azul=${revezar_azuis[$i]:-}
    if [ -z "$azul" ] || ! listar_servico "$servico"; then
      log "não foi possível achar os contêineres novos do serviço $servico"
      falhas=$((falhas + 1))
      continue
    fi
    for id in ${ids_servico[@]+"${ids_servico[@]}"}; do
      if [ "$id" = "$azul" ]; then
        continue
      fi
      if parar_e_remover "$id"; then
        log "revezamento: contêiner novo $id do serviço $servico parado e removido"
      else
        falhas=$((falhas + 1))
      fi
    done
  done
  if [ "$falhas" != 0 ]; then
    return 1
  fi
  return 0
}

# Até $espera_revezamento s por contêiner novo: rodando, sem reinício, e com
# a linha "standby" no registro (esperando as portas e o lock do em uso). 0
# todos em espera; 1 sem a linha a tempo ou um erro do docker (o motivo em
# revezar_motivo); 2 um contêiner novo parou ou reiniciou.
aguardar_espera() {
  local i id servico fim estado saida
  for i in "${!revezar_servicos[@]}"; do
    servico=${revezar_servicos[$i]}
    id=${revezar_verdes[$i]}
    fim=$((SECONDS + espera_revezamento))
    while :; do
      if ! estado=$(docker inspect -f "$formato_estado" "$id") || ! [[ $estado =~ $estado_re ]]; then
        revezar_motivo="não foi possível ler o estado do contêiner novo $id do serviço $servico"
        return 1
      fi
      if [ "$estado" != 'true false 0' ]; then
        log "o contêiner novo $id do serviço $servico parou ou reiniciou antes de ficar em espera (rodando, reiniciando, reinícios: $estado)"
        return 2
      fi
      # Capturado, nunca num pipe: com pipefail e PIPE ignorado, um grep que
      # sai cedo faria o docker logs falhar.
      saida=$(docker logs --tail 200 "$id" 2>&1) || saida=''
      if [[ $saida == *'"event":"standby"'* ]]; then
        log "revezamento: o contêiner novo $id do serviço $servico está em espera"
        break
      fi
      if [ "$SECONDS" -ge "$fim" ]; then
        revezar_motivo="o contêiner novo $id do serviço $servico não ficou em espera em $espera_revezamento s"
        return 1
      fi
      sleep 2
    done
  done
  return 0
}

# Etapas do revezamento até os novos ficarem em espera, ao lado dos em uso,
# que continuam servindo. 0 pronto; 1 não deu certo por algo que não é do
# candidato (revezar_motivo); 2 um contêiner novo parou ou reiniciou.
subir_verdes() {
  local i i2 id servico azul achou novos estado f v
  local -a escala=()
  revezar_servicos=(seeder)
  if [ "$perfil" = full ]; then
    revezar_servicos+=(account)
  fi
  revezar_azuis=()
  revezar_verdes=()
  for servico in "${revezar_servicos[@]}"; do
    if ! listar_servico "$servico" || [ "${#ids_servico[@]}" != 1 ]; then
      revezar_motivo="o serviço $servico não tem exatamente um contêiner"
      return 1
    fi
    revezar_azuis+=("${ids_servico[0]}")
    escala+=(--scale "$servico=2")
  done
  # anterior.velho e os .velho dos segredos já foram criados por aplicar e
  # trocar_segredos: existem agora só se o arquivo existia antes do apply.
  revezar_velhos=''
  for f in "$state/anterior.velho" "$segredos/efetivo.env.anterior.velho" "$segredos/seq.anterior.velho"; do
    if [ -f "$f" ]; then v=1; else v=0; fi
    case $f in
      */anterior.velho) revezar_velhos+="velho_anterior=$v"$'\n' ;;
      */efetivo.env.anterior.velho) revezar_velhos+="velho_env=$v"$'\n' ;;
      *) revezar_velhos+="velho_seq=$v"$'\n' ;;
    esac
  done
  revezar_fase=1
  if ! gravar_revezamento; then
    revezar_fase=0
    revezar_motivo="não foi possível gravar $state/revezamento"
    return 1
  fi
  log "revezamento: subindo ${revezar_servicos[*]} de $cand_commit ao lado de ${revezar_azuis[*]}"
  # Num if: um erro do compose aqui não é do candidato e não dispara a volta.
  if ! compose_alvo up -d --no-build --no-recreate --no-deps "${escala[@]}" "${revezar_servicos[@]}"; then
    revezar_motivo='o compose up com --scale falhou'
    return 1
  fi
  for i in "${!revezar_servicos[@]}"; do
    servico=${revezar_servicos[$i]}
    azul=${revezar_azuis[$i]}
    if ! listar_servico "$servico"; then
      revezar_motivo="não foi possível listar os contêineres do serviço $servico"
      return 1
    fi
    id=''
    achou=0
    novos=0
    for i2 in ${ids_servico[@]+"${ids_servico[@]}"}; do
      if [ "$i2" = "$azul" ]; then
        achou=1
      else
        id=$i2
        novos=$((novos + 1))
      fi
    done
    if [ "$achou" != 1 ]; then
      revezar_motivo="o contêiner em uso $azul do serviço $servico sumiu ou foi recriado"
      return 1
    fi
    if [ "$novos" -gt 1 ]; then
      revezar_motivo="o serviço $servico ficou com mais de um contêiner novo"
      return 1
    fi
    if [ -z "$id" ]; then
      revezar_motivo="o compose não criou um contêiner novo do serviço $servico"
      return 1
    fi
    revezar_verdes+=("$id")
    if ! estado=$(docker inspect -f "$formato_estado" "$azul") || [[ $estado != 'true false '* ]]; then
      revezar_motivo="o contêiner em uso $azul do serviço $servico não está mais rodando"
      return 1
    fi
  done
  if ! gravar_revezamento; then
    log 'aviso: o diário do revezamento ficou sem os contêineres novos'
  fi
  aguardar_espera
}

# O revezamento não deu certo por algo que não é do candidato: os novos
# saem e a troca segue no lugar, nesta mesma execução e sem recusar a versão.
# Se os novos não saem, vale a volta (fase 1).
seguir_no_lugar() {
  if [ "$revezar_fase" = 1 ] && ! remover_verdes; then
    log "revezamento indisponível ($revezar_motivo), e os contêineres novos não saíram"
    voltar
  fi
  rm -f "$state/revezamento"
  revezar_diario=0
  revezar_fase=0
  log "revezamento indisponível; seguindo na troca no lugar: $revezar_motivo"
}

# Um em uso para com a espera do compose e sai; o novo, em espera, assume as
# portas e o lock. Do registro dele, só a linha "stopped" (os tempos do
# fechamento), e só com caracteres de JSON simples.
parar_azul() {
  local saida linha='' l permitido='[!A-Za-z0-9{}:,._"-]'
  log "revezamento: parando o contêiner em uso $2 do serviço $1"
  docker stop "$2" >/dev/null
  saida=$(docker logs --tail 20 "$2" 2>&1) || saida=''
  while IFS= read -r l; do
    case $l in *'"event":"stopped"'*) linha=$l ;; esac
  done <<<"$saida"
  linha=${linha//$permitido/}
  if [ -n "$linha" ]; then
    log "revezamento: $1 parou: ${linha:0:300}"
  fi
  docker rm "$2" >/dev/null
}

# Logo antes de parar os em uso, os novos de novo: 0 todos rodando; 2 um
# parou ou reiniciou depois da espera (culpa do candidato); 1 o estado não
# se lê (um erro do docker, como em aguardar_espera, com o motivo em
# revezar_motivo).
conferir_verdes() {
  local i id servico estado
  for i in "${!revezar_servicos[@]}"; do
    servico=${revezar_servicos[$i]}
    id=${revezar_verdes[$i]}
    if ! estado=$(docker inspect -f "$formato_estado" "$id") || ! [[ $estado =~ $estado_re ]]; then
      revezar_motivo="não foi possível ler o estado do contêiner novo $id do serviço $servico antes da troca"
      return 1
    fi
    if [ "$estado" != 'true false 0' ]; then
      log "o contêiner novo $id do serviço $servico parou antes da troca (rodando, reiniciando, reinícios: $estado)"
      return 2
    fi
  done
  return 0
}

# Etapas 6 a 8: comandos soltos, e uma falha chega ao trap (voltar, fase 2).
trocar_azuis() {
  local i
  revezar_fase=2
  if ! gravar_revezamento; then
    log 'aviso: o diário do revezamento ficou na fase 1'
  fi
  for i in "${!revezar_servicos[@]}"; do
    parar_azul "${revezar_servicos[$i]}" "${revezar_azuis[$i]}"
  done
}

# Contêineres que sobraram (do serviço, nunca os avulsos nem o web): com mais
# de um, os parados saem; se ainda roda mais de um, fica só o da imagem
# instalada e os outros param com a espera do compose. Sem exatamente um da
# imagem instalada, falha como antes.
remover_sobras() {
  local servico id estado img id_inst='' inst='' ficar
  local -a servicos=(seeder) vivos=()
  if [ "$perfil" = full ]; then
    servicos+=(account)
  fi
  for servico in "${servicos[@]}"; do
    if ! listar_servico "$servico"; then
      log "não foi possível listar os contêineres do serviço $servico"
      return 1
    fi
    if [ "${#ids_servico[@]}" -le 1 ]; then
      continue
    fi
    vivos=()
    for id in "${ids_servico[@]}"; do
      if ! estado=$(docker inspect -f "$formato_estado" "$id") || ! [[ $estado =~ $estado_re ]]; then
        log "não foi possível ler o estado do contêiner $id do serviço $servico"
        return 1
      fi
      if [[ $estado == 'false '* ]]; then
        if ! docker rm "$id" >/dev/null; then
          log "não foi possível remover o contêiner parado $id do serviço $servico"
          return 1
        fi
        log "contêiner parado $id do serviço $servico removido"
      else
        vivos+=("$id")
      fi
    done
    if [ "${#vivos[@]}" -le 1 ]; then
      continue
    fi
    if [ -z "$id_inst" ]; then
      if [ -f "$state/atual" ]; then
        inst=$(ler_estado "$state/atual" seeder) || inst=''
      fi
      if ! [[ $inst =~ $seeder_ref_re ]] || ! id_inst=$(docker image inspect -f '{{.Id}}' "$inst") \
        || [ -z "$id_inst" ]; then
        id_inst=''
        log "mais de um contêiner do serviço $servico"
        return 1
      fi
    fi
    ficar=''
    for id in "${vivos[@]}"; do
      if ! img=$(docker inspect -f '{{.Image}}' "$id"); then
        log "não foi possível ler a imagem do contêiner $id do serviço $servico"
        return 1
      fi
      if [ "$img" = "$id_inst" ]; then
        if [ -n "$ficar" ]; then
          log "mais de um contêiner do serviço $servico"
          return 1
        fi
        ficar=$id
      fi
    done
    if [ -z "$ficar" ]; then
      log "mais de um contêiner do serviço $servico"
      return 1
    fi
    for id in "${vivos[@]}"; do
      if [ "$id" != "$ficar" ]; then
        if ! parar_e_remover "$id"; then
          return 1
        fi
        log "contêiner $id do serviço $servico, fora da versão instalada, parado e removido"
      fi
    done
  done
  return 0
}

# Etapas 4 a 7 com a versão já preparada em $cand_dir. Uma falha ou um
# INT/TERM depois do compose up volta para a anterior.
aplicar() {
  if ! conferir_env_da_volta; then
    exit 1
  fi
  if ! garantir_imagem "$cand_seeder"; then
    exit 1
  fi
  if [ "$perfil" = full ] && ! garantir_imagem "$cand_web"; then
    exit 1
  fi
  if [ "$perfil" = full ] && [ -n "$cand_caddy" ] && ! garantir_imagem "$cand_caddy"; then
    exit 1
  fi
  if ! remover_sobras; then
    log 'os contêineres que sobraram não foram resolvidos; a versão nova não foi aplicada'
    exit 1
  fi
  if ! etiquetar_rodando seeder varanda-seeder:anterior || ! etiquetar_rodando web varanda-caddy:anterior \
    || ! docker image tag "$cand_seeder" varanda-seeder:atual \
    || { [ "$perfil" = full ] && ! docker image tag "${cand_caddy:-$cand_web}" varanda-caddy:atual; }; then
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
  # No mesmo ponto, o candidato vira o efetivo.env e o de antes acompanha o
  # registro anterior.
  if ! trocar_segredos "$anterior_trocado"; then
    if [ "$anterior_trocado" = 1 ]; then
      if [ -f "$state/anterior.velho" ]; then
        mv -f "$state/anterior.velho" "$state/anterior" || true
      else
        rm -f "$state/anterior" || true
      fi
    fi
    log "não foi possível trocar $segredos/efetivo.env; nada do que roda mudou"
    exit 1
  fi
  alvo_versao "$cand_dir" "$cand_seeder" "$cand_web" "$cand_caddy"
  log "aplicando $cand_commit (seq $cand_seq)"
  # Cada passo é um comando solto (fora de if, || e &&) para que a falha
  # chegue ao trap.
  local -a recriacao=()
  local revezar=0 revezar_rc=0
  if [ "$recriar" = 1 ]; then
    recriacao=(--force-recreate)
  fi
  if pode_revezar; then
    revezar=1
  fi
  revezar_fase=0
  trap voltar ERR
  trap 'voltar sinal' INT TERM
  if [ "$revezar" = 1 ]; then
    # Com revezamento, o semeador (e o serviço de conta) novo espera ao lado
    # do em uso, que só para depois: no lugar do compose up de cada um.
    subir_verdes || revezar_rc=$?
    if [ "$revezar_rc" = 0 ]; then
      conferir_verdes || revezar_rc=$?
    fi
    if [ "$revezar_rc" = 2 ]; then
      voltar
    elif [ "$revezar_rc" != 0 ]; then
      seguir_no_lugar
      revezar=0
    else
      trocar_azuis
    fi
  fi
  if [ "$perfil" = full ] && [ -n "$cand_caddy" ]; then
    # Primeiro o semeador e o serviço de conta, depois o www e o Caddyfile
    # trocam por rename, e por fim o web, que o compose só recria se a imagem
    # do Caddy ou o Caddyfile mudaram (o recriar não vale para ele: o web não
    # monta o diretório da versão).
    if [ "$revezar" = 0 ]; then
      compose_alvo up -d --no-build ${recriacao[@]+"${recriacao[@]}"} seeder account
    fi
    trocar_web "$cand_dir"
    compose_alvo up -d --no-build web
  elif [ "$revezar" = 0 ]; then
    compose_alvo up -d --no-build ${recriacao[@]+"${recriacao[@]}"}
  fi
  verificar_saude
  trap - ERR INT TERM
  # Saudável: morrer dentro de concluir repete a versão no próximo run, como
  # sem revezamento, em vez de recusá-la. Um diário de antes (deixado por uma
  # volta que falhou) também sai: nenhuma troca está pendente.
  apagar_revezamento
  revezar_fase=0
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
  if ! garantir_imagem "$r_seeder" || { [ "$perfil" = full ] && ! garantir_imagem "$r_web"; } \
    || { [ "$perfil" = full ] && [ -n "$r_caddy" ] && ! garantir_imagem "$r_caddy"; }; then
    marcar_intervencao "as imagens da versão anterior ($r_commit) não estão disponíveis"
    return 1
  fi
  # O ambiente volta junto com o diretório da versão.
  if ! restaurar_segredos; then
    marcar_intervencao "não foi possível restaurar $segredos/efetivo.env da versão anterior ($r_commit)"
    return 1
  fi
  alvo_versao "$dir" "$r_seeder" "$r_web" "$r_caddy"
  if [ "$perfil" = full ] && [ -n "$r_caddy" ]; then
    # O www e o Caddyfile da anterior voltam por rename; o web volta para a
    # imagem do Caddy e o Caddyfile dela, e o compose só o recria se um dos
    # dois mudou.
    if ! compose_alvo up -d --no-build --force-recreate seeder account; then
      falhas=$((falhas + 1))
      log 'volta: compose up falhou'
    fi
    if ! trocar_web "$dir"; then
      falhas=$((falhas + 1))
      log 'volta: não foi possível apontar o www e o Caddyfile para a versão anterior'
    elif ! compose_alvo up -d --no-build web; then
      falhas=$((falhas + 1))
      log 'volta: compose up do web falhou'
    fi
  elif ! compose_alvo up -d --no-build --force-recreate; then
    falhas=$((falhas + 1))
    log 'volta: compose up falhou'
  else
    # O web voltou a montar o www da própria versão: o link não segura mais
    # a versão que falhou.
    rm -f "$releases/web" || log "aviso: não foi possível apagar $releases/web"
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
  else
    rm -f "$releases/web" || log "aviso: não foi possível apagar $releases/web"
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

# A volta na fase 1 do revezamento: o que roda nunca parou. Os novos saem, o
# ambiente e o alvo voltam para a versão anterior e ela passa de novo pela
# verificação de saúde, sem recriar nada. 1 quando algo falha: a volta segue
# pelo caminho de sempre.
voltar_sem_parar() {
  local dir
  if ! remover_verdes; then
    log 'volta: os contêineres novos não saíram'
    return 1
  fi
  revezar_fase=0
  if ! ler_registro "$state/anterior" || [ "$(ler_estado "$state/anterior" origem)" = checkout ]; then
    return 1
  fi
  dir="$releases/$r_commit"
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    return 1
  fi
  if ! restaurar_segredos; then
    log "volta: não foi possível restaurar $segredos/efetivo.env da versão anterior ($r_commit)"
    return 1
  fi
  alvo_versao "$dir" "$r_seeder" "$r_web" "$r_caddy"
  if ! verificar_saude; then
    log 'volta: a versão em uso não passou na verificação de saúde'
    return 1
  fi
  log "voltou para $r_commit sem parar o que rodava"
}

# A volta na fase 2 do revezamento: os em uso que já pararam saem, e os novos
# também, para o compose recriar a versão anterior como o contêiner 1.
desfazer_revezamento() {
  local i id estado
  for i in "${!revezar_servicos[@]}"; do
    id=${revezar_azuis[$i]:-}
    if [ -n "$id" ] && estado=$(docker inspect -f "$formato_estado" "$id") && [[ $estado == 'false '* ]]; then
      docker rm "$id" >/dev/null || log "volta: não foi possível remover o contêiner $id"
    fi
  done
  if ! remover_verdes; then
    log 'volta: os contêineres novos não saíram'
  fi
  revezar_fase=0
}

# O diário sai quando nada do revezamento está pendente; uma falha só avisa.
apagar_revezamento() {
  if rm -f "$state/revezamento"; then
    revezar_diario=0
  else
    log "aviso: não foi possível apagar $state/revezamento"
  fi
}

# Desfaz a troca do anterior feita por aplicar e trocar_segredos, pelas
# linhas velho_* do diário. Idempotente: movendo=1 vai antes do primeiro mv,
# e um .velho que já não existe foi movido numa execução que morreu no meio.
desfazer_troca_anterior() {
  local j="$state/revezamento" texto='' l v x chave
  for chave in velho_anterior velho_env velho_seq; do
    v=$(ler_estado "$j" "$chave") || v=''
    if ! [[ $v =~ ^[01]$ ]]; then
      log "$j sem $chave válido"
      return 1
    fi
  done
  if [ "$(ler_estado "$j" movendo)" != 1 ]; then
    while IFS= read -r l || [ -n "$l" ]; do
      texto+="$l"$'\n'
    done <"$j"
    if ! { printf '%smovendo=1\n' "$texto" >"$j.tmp" && mv -f "$j.tmp" "$j"; }; then
      rm -f "$j.tmp" 2>/dev/null || true
      log "não foi possível gravar $j"
      return 1
    fi
  fi
  # O registro anterior por último: enquanto ele for a cópia de atual, uma
  # execução seguinte sabe que a troca não terminou de ser desfeita.
  for x in "velho_env $segredos/efetivo.env.anterior" "velho_seq $segredos/seq.anterior" "velho_anterior $state/anterior"; do
    chave=${x%% *}
    x=${x#* }
    if [ "$(ler_estado "$j" "$chave")" = 1 ]; then
      if [ -f "$x.velho" ] && ! mv -f "$x.velho" "$x"; then
        log "não foi possível devolver $x"
        return 1
      fi
    elif ! rm -f "$x"; then
      log "não foi possível apagar $x"
      return 1
    fi
  done
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
  if [ "$revezar_fase" = 1 ] && voltar_sem_parar; then
    rc=0
  else
    if [ "$revezar_fase" = 2 ]; then
      desfazer_revezamento
    fi
    voltar_para_anterior
    rc=$?
  fi
  # Com o diário, a troca do anterior volta por ele, e só então o diário sai.
  # Numa volta que falhou (com intervenção), ele fica para quem opera.
  if [ "$rc" = 0 ] && [ "$revezar_diario" = 1 ]; then
    if desfazer_troca_anterior && rm -f "$state/revezamento"; then
      revezar_diario=0
    else
      log "volta: a troca do registro anterior não foi desfeita; $state/revezamento fica para a próxima execução"
    fi
    anterior_trocado=0
  fi
  if [ "$rc" = 0 ]; then
    if [ "$anterior_trocado" = 1 ]; then
      if [ -f "$state/anterior.velho" ]; then
        mv -f "$state/anterior.velho" "$state/anterior"
      else
        rm -f "$state/anterior"
      fi
      if [ -f "$segredos/efetivo.env.anterior.velho" ]; then
        mv -f "$segredos/efetivo.env.anterior.velho" "$segredos/efetivo.env.anterior"
      else
        rm -f "$segredos/efetivo.env.anterior"
      fi
      if [ -f "$segredos/seq.anterior.velho" ]; then
        mv -f "$segredos/seq.anterior.velho" "$segredos/seq.anterior"
      else
        rm -f "$segredos/seq.anterior"
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
  # varanda.env pode ter mudado: o efetivo.env é refeito do pacote instalado,
  # com a imagem instalada e a mesma regra de apply, antes de qualquer troca.
  env_file=$env_local
  adiar_google=1
  if ! conferir_env; then
    adiar_google=0
    log 'arquivo de ambiente recusado; nada mudou'
    return 1
  fi
  adiar_google=0
  if ! garantir_imagem "$r_seeder" || { [ "$perfil" = full ] && ! garantir_imagem "$r_web"; } \
    || { [ "$perfil" = full ] && [ -n "$r_caddy" ] && ! garantir_imagem "$r_caddy"; }; then
    return 1
  fi
  if ! conferir_arvore "$dir" || ! preparar_segredos "$r_seeder" "$dir"; then
    descartar_candidato
    return 1
  fi
  if ! conferir_perda_segredos registrar || ! conferir_seq_segredos registrar; then
    descartar_candidato
    return 1
  fi
  usar_env "$segredos/efetivo.env.novo"
  if ! conferir_env; then
    descartar_candidato
    log 'arquivo de ambiente recusado; nada mudou'
    return 1
  fi
  if [ "$perfil" = full ] && ! gravar_associacoes "$dir/www"; then
    descartar_candidato
    return 1
  fi
  if ! trocar_segredos 0; then
    descartar_candidato
    log "não foi possível trocar $segredos/efetivo.env; nada mudou"
    return 1
  fi
  alvo_versao "$dir" "$r_seeder" "$r_web" "$r_caddy"
  if [ "$perfil" = full ] && [ -n "$r_caddy" ] && ! trocar_web "$dir"; then
    return 1
  fi
  if ! compose_alvo up -d --no-build "$@"; then
    log 'compose up falhou'
    return 1
  fi
  if ! verificar_saude; then
    return 1
  fi
  # 2: no ar e saudável, só o piso não foi gravado (fica a intervenção).
  if ! gravar_piso_segredos; then
    return 2
  fi
}

# Uma troca com revezamento interrompida (o processo morreu ou foi morto no
# meio, sem a volta): o candidato é recusado, como na volta por sinal, e todo
# contêiner do semeador e da conta que não roda a imagem instalada para e
# sai. Um serviço sem nenhum rodando a instalada a sobe de novo. Só remove e
# restaura: nunca aplica nada. Com uma intervenção pendente, só registra.
retomar_revezamento() {
  local j="$state/revezamento" commit digest fase inst='' id_inst servico id img estado vivo
  local restos='' faltou=0 falhas=0 rc=0 troca=0 movendo saida l s_l rodando
  local -a servicos=(seeder) lidos=()
  if [ ! -e "$j" ] && [ ! -L "$j" ]; then
    return 0
  fi
  commit=$(ler_estado "$j" commit) || commit=''
  digest=$(ler_estado "$j" digest) || digest=''
  fase=$(ler_estado "$j" fase) || fase=''
  if ! [[ $commit =~ $sha_re ]]; then
    commit='desconhecida'
  fi
  if ! [[ $digest =~ $digest_re ]]; then
    digest=''
  fi
  if ! [[ $fase =~ ^[12]$ ]]; then
    fase='desconhecida'
  fi
  if [ "$perfil" = full ]; then
    servicos+=(account)
  fi
  saida="confira os contêineres com update.sh compose ps -a e, resolvido, apague $j à mão"
  for servico in "${servicos[@]}"; do
    if listar_servico "$servico"; then
      restos="$restos $servico: ${ids_servico[*]:-nenhum};"
    else
      restos="$restos $servico: não listados;"
    fi
  done
  log "troca com revezamento interrompida (versão $commit, fase $fase); contêineres:$restos"
  if [ -f "$state/intervencao" ]; then
    log "intervenção pendente: nada foi alterado; confira os contêineres e apague $j"
    return 0
  fi
  if [ -f "$state/atual" ]; then
    inst=$(ler_estado "$state/atual" seeder) || inst=''
  fi
  if ! [[ $inst =~ $seeder_ref_re ]]; then
    marcar_intervencao "troca com revezamento interrompida sem uma versão instalada válida em $state/atual: confira os contêineres e apague $j"
    return 0
  fi
  if ! id_inst=$(docker image inspect -f '{{.Id}}' "$inst") || [ -z "$id_inst" ]; then
    log "não foi possível ler a imagem da versão instalada; a troca interrompida fica para a próxima execução; se persistir, $saida"
    exit 1
  fi
  # Morrer depois de gravar $state/atual deixa o candidato instalado: ele
  # não é recusado.
  if [ -n "$digest" ] && [ "$digest" != "${inst#*@}" ]; then
    registrar_recusa "$digest"
  fi
  # O apply morto deixou o anterior trocado (a cópia de atual) e o
  # efetivo.env do candidato. O ambiente volta antes de tudo, e antes de
  # mover os .velho, enquanto efetivo.env.anterior ainda é o da instalada.
  if [ -f "$state/anterior" ] && cmp -s "$state/anterior" "$state/atual"; then
    troca=1
  fi
  movendo=$(ler_estado "$j" movendo) || movendo=''
  if [ "$troca" = 1 ] && [ "$movendo" != 1 ] && ! restaurar_segredos; then
    log "não foi possível restaurar $segredos/efetivo.env da versão instalada; fica para a próxima execução; se persistir, $saida"
    exit 1
  fi
  if { [ "$troca" = 1 ] || [ "$movendo" = 1 ]; } && ! desfazer_troca_anterior; then
    log "a troca do registro anterior não foi desfeita; fica para a próxima execução; se persistir, $saida"
    exit 1
  fi
  # Primeiro só leituras: com qualquer uma falhando, nada para, para nunca
  # esvaziar um serviço e sair antes de subir a versão instalada de novo.
  for servico in "${servicos[@]}"; do
    if ! listar_servico "$servico"; then
      log "não foi possível listar os contêineres do serviço $servico"
      falhas=$((falhas + 1))
      continue
    fi
    for id in ${ids_servico[@]+"${ids_servico[@]}"}; do
      if ! img=$(docker inspect -f '{{.Image}}' "$id"); then
        log "não foi possível ler a imagem do contêiner $id do serviço $servico"
        falhas=$((falhas + 1))
      elif ! estado=$(docker inspect -f "$formato_estado" "$id") || ! [[ $estado =~ $estado_re ]]; then
        log "não foi possível ler o estado do contêiner $id do serviço $servico"
        falhas=$((falhas + 1))
      elif [[ $estado == 'true false '* ]]; then
        lidos+=("$servico $id $img 1")
      else
        lidos+=("$servico $id $img 0")
      fi
    done
  done
  if [ "$falhas" != 0 ]; then
    log "a troca com revezamento interrompida não foi desfeita ($falhas leituras falharam; nada foi parado); fica para a próxima execução; se persistir, $saida"
    exit 1
  fi
  for servico in "${servicos[@]}"; do
    vivo=0
    for l in ${lidos[@]+"${lidos[@]}"}; do
      read -r s_l id img rodando <<<"$l"
      if [ "$s_l" != "$servico" ]; then
        continue
      fi
      if [ "$img" != "$id_inst" ]; then
        if parar_e_remover "$id"; then
          log "contêiner $id do serviço $servico, fora da versão instalada, parado e removido"
        else
          falhas=$((falhas + 1))
        fi
      elif [ "$rodando" = 1 ]; then
        vivo=1
      fi
    done
    if [ "$vivo" = 0 ]; then
      faltou=1
    fi
  done
  if [ "$falhas" != 0 ]; then
    log "a troca com revezamento interrompida não foi desfeita ($falhas passos); fica para a próxima execução; se persistir, $saida"
    exit 1
  fi
  if [ "$faltou" = 1 ]; then
    log 'subindo de novo a versão instalada'
    subir_instalada --force-recreate || rc=$?
    if [ "$rc" = 2 ]; then
      marcar_intervencao 'a versão instalada voltou saudável depois de uma troca com revezamento interrompida, mas o piso dos segredos compartilhados não foi gravado: rode update.sh apply'
    elif [ "$rc" != 0 ]; then
      marcar_intervencao 'a versão instalada não voltou depois de uma troca com revezamento interrompida'
    fi
  fi
  if ! rm -f "$j"; then
    log "não foi possível apagar $j; $saida"
    exit 1
  fi
  if [ "$rc" = 0 ] || [ "$rc" = 2 ]; then
    log "troca com revezamento interrompida desfeita (versão $commit)"
  else
    log "troca com revezamento interrompida: os contêineres da versão $commit saíram, mas a versão instalada não voltou"
  fi
  return 0
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
  retomar_revezamento
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
  # Sozinho, o timer nunca desliga o que vinha do arquivo selado (a
  # verificação de idade da Didit, por exemplo). Sem recusada e sem
  # intervenção: a próxima versão que os traga aplica normalmente.
  if ! conferir_perda_segredos recusar || ! conferir_seq_segredos recusar; then
    descartar_candidato
    exit 1
  fi
  aplicar
  exit 0
}

# Um apply explícito ignora as recusadas.
cmd_apply() {
  local rc=0
  comecar apply
  retomar_revezamento
  if ! verificar; then
    exit 1
  fi
  if [ "$em_dia" = 1 ]; then
    if [ -f "$state/intervencao" ]; then
      subir_instalada --force-recreate || rc=$?
      if [ "$rc" = 2 ]; then
        apagar_revezamento
        log 'a versão instalada está saudável, mas o piso dos segredos compartilhados não foi gravado; a intervenção continua'
        exit 1
      fi
      if [ "$rc" != 0 ]; then
        log 'a versão instalada não passou na verificação; a intervenção continua'
        exit 1
      fi
      apagar_revezamento
      rm -f "$state/intervencao"
      log "em dia em $r_commit e saudável; intervenção encerrada"
    fi
    exit 0
  fi
  if ! preparar_versao; then
    exit 1
  fi
  if ! conferir_perda_segredos registrar || ! conferir_seq_segredos registrar; then
    descartar_candidato
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
  retomar_revezamento
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
  retomar_revezamento
  if [ ! -f "$state/anterior" ]; then
    log 'sem versão anterior: nada a voltar'
    exit 1
  fi
  if [ -f "$state/atual" ]; then
    digest=$(ler_estado "$state/atual" seeder)
    digest=${digest#*@}
  fi
  # O pré-voo confere o ambiente com que a volta sobe: o da versão anterior.
  if [ "$(ler_estado "$state/anterior" origem)" != checkout ]; then
    usar_env "$segredos/efetivo.env.anterior"
    if ! conferir_env; then
      log 'arquivo de ambiente recusado; nada mudou'
      exit 1
    fi
  fi
  if ! subir_piso_anterior; then
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
      if ! gravar_estado "$state/atual" "$r_commit" "$r_seq" "$r_seeder" "$r_web" "$r_caddy"; then
        marcar_intervencao "voltou para $r_commit, mas $state/atual não foi gravado"
        exit 1
      fi
      rm -f "$state/anterior" "$state/anterior.velho" "$state/intervencao" \
        "$segredos/efetivo.env.anterior" "$segredos/efetivo.env.anterior.velho" \
        "$segredos/seq.anterior" "$segredos/seq.anterior.velho"
      if ! trocar_atual "$releases/$r_commit"; then
        log "aviso: não foi possível apontar $releases/current para $r_commit"
      fi
      apagar_revezamento
      log "rollback: voltou para $r_commit"
      exit 0
      ;;
    2)
      # O que roda é o checkout: nenhuma versão instalada, e um apply
      # depois volta a preparar tudo.
      rm -f "$state/atual"
      apagar_revezamento
      log 'rollback: o servidor voltou ao checkout'
      exit 0
      ;;
  esac
  exit 1
}

cmd_status() {
  local u nomes j_fase j_commit
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
  if [ -f "$state/revezamento" ]; then
    j_fase=$(ler_estado "$state/revezamento" fase) || j_fase=''
    j_commit=$(ler_estado "$state/revezamento" commit) || j_commit=''
    [[ $j_fase =~ ^[12]$ ]] || j_fase='desconhecida'
    [[ $j_commit =~ $sha_re ]] || j_commit='desconhecida'
    printf 'troca com revezamento interrompida pendente: versão %s, fase %s\n' "$j_commit" "$j_fase"
  fi
  if [ -f "$state/intervencao" ]; then
    printf 'intervenção: %s\n' "$(head -n 1 "$state/intervencao")"
  else
    printf 'intervenção: nenhuma\n'
  fi
  # Só os nomes, os depois da última marca: nunca um valor.
  nomes=$(nomes_compartilhados "$segredos/efetivo.env")
  printf 'segredos compartilhados:%s\n' "${nomes:- nenhum}"
  if [ -f "$chave_segredos" ]; then
    printf 'chave dos segredos: %s\n' "$chave_segredos"
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
  compose_em "$releases/current" "$r_seeder" "$r_web" "$r_caddy" "$@"
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
  # Como num apply: um seq menor que o piso só fica no registro.
  if ! conferir_seq_segredos registrar; then
    descartar_candidato
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
  # Nada sobe agora, mas o candidato vira o efetivo.env: os comandos do
  # compose até o primeiro apply (a cerimônia de chaves) precisam dos
  # segredos compartilhados. O primeiro apply os abre de novo.
  if ! trocar_segredos 0; then
    descartar_candidato
    log "não foi possível gravar $segredos/efetivo.env; nada foi iniciado"
    exit 1
  fi
  if ! gravar_estado "$state/preparada" "$cand_commit" "$cand_seq" "$cand_seeder" "$cand_web" "$cand_caddy"; then
    log "não foi possível registrar a versão preparada em $cand_dir"
    exit 1
  fi
  log "instalação preparada em $cand_dir; nada foi iniciado. Antes do primeiro apply, faça a cerimônia de chaves do semeador da seção 'Atualização por imagem (pull)' do README e depois rode update.sh apply. Para receber segredos compartilhados, este servidor precisa da chave de update.sh secrets-key (mesma seção)"
  exit 0
}

# A chave X25519 deste servidor para os segredos compartilhados, em
# /etc/varanda/secrets-key.json (root, 0600). Funciona antes de install (o
# perfil full pode precisar dos segredos já no primeiro apply): sem versão
# instalada, a imagem de --image é conferida como em install antes de rodar;
# com uma, vale a imagem instalada. Nunca baixa uma etiqueta. A saída tem só
# a chave pública, a que vai para quem mantém o projeto; a secreta fica só no
# arquivo, e os registros vão para o erro padrão.
cmd_secrets_key() {
  local destino tmpd pub='' dm imagem
  destino=$(dirname "$chave_segredos")
  tmpd="$destino/.secrets-key.tmp"
  exec 4>&1 1>&2
  comecar secrets-key
  if [ -e "$chave_segredos" ] || [ -L "$chave_segredos" ]; then
    log "$chave_segredos já existe; nada mudou (para trocar a chave, apague o arquivo e mande a nova chave pública a quem mantém o projeto)"
    exit 1
  fi
  if [ -L "$destino" ] || [ ! -d "$destino" ]; then
    log "$destino precisa ser um diretório comum; nada mudou"
    exit 1
  fi
  if ler_registro "$state/atual"; then
    if [ -n "$ref_chave" ]; then
      log "há uma versão instalada ($r_commit): rode update.sh secrets-key sem --image"
      exit 2
    fi
    imagem=$r_seeder
    if ! garantir_imagem "$imagem"; then
      exit 1
    fi
  else
    if [ -z "$ref_chave" ]; then
      log "nenhuma versão instalada: informe --image $seeder_repo@sha256:<64 hex>, a mesma imagem de install"
      exit 2
    fi
    if ! definir_candidato "$ref_chave" || ! verificar_assinatura "$cand_seeder"; then
      log 'chave não criada; nada mudou'
      exit 1
    fi
    imagem=$cand_seeder
  fi
  if ! rm -rf "$tmpd" || ! mkdir -m 0700 "$tmpd"; then
    log "não foi possível criar $tmpd; nada mudou"
    exit 1
  fi
  if ! pub=$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 0:0 \
    --mount "type=bind,source=$tmpd,target=/saida" \
    "$imagem" secrets key --out /saida/secrets-key.json); then
    rm -rf "$tmpd"
    log 'varanda secrets key falhou; nada mudou'
    exit 1
  fi
  pub=$(printf '%s\n' "$pub" | tr -d '\r' | tail -n 1)
  # Exatamente uma chave pública no arquivo, a impressa, com ou sem espaço
  # em volta dos dois-pontos (JSON compacto ou formatado).
  if ! [[ $pub =~ $chave_hex_re ]] || [ -L "$tmpd/secrets-key.json" ] || [ ! -f "$tmpd/secrets-key.json" ] \
    || ! dm=$(dono_modo "$tmpd/secrets-key.json") || [ "$dm" != '0 600' ] \
    || [ "$(grep -o '"publicKey"' "$tmpd/secrets-key.json" | wc -l | tr -d ' ')" != 1 ] \
    || ! grep -Eq "\"publicKey\"[[:space:]]*:[[:space:]]*\"$pub\"" "$tmpd/secrets-key.json"; then
    rm -rf "$tmpd"
    log 'a chave gerada não está na forma esperada; nada mudou'
    exit 1
  fi
  # ln não sobrescreve: um arquivo que apareceu nesse meio tempo fica.
  if ! ln "$tmpd/secrets-key.json" "$chave_segredos"; then
    rm -rf "$tmpd"
    log "não foi possível gravar $chave_segredos; nada mudou"
    exit 1
  fi
  rm -rf "$tmpd" || log "aviso: não foi possível apagar $tmpd"
  log "chave dos segredos criada em $chave_segredos; mande a chave pública impressa na saída a quem mantém o projeto"
  printf '%s\n' "$pub" >&4
  exit 0
}

main() {
  local cmd=${1:-} c
  case $cmd in
    install | run | check | apply | reconfigure | rollback | status | compose | secrets-key) shift ;;
    *) morrer_cedo 2 "$uso" ;;
  esac
  case $cmd in
    install)
      if [ "$#" -ne 2 ] || [ "$1" != --image ] || ! [[ $2 =~ $seeder_ref_re ]]; then
        morrer_cedo 2 "$uso"
      fi
      ref_install=$2
      ;;
    secrets-key)
      if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || [ "$1" != --image ] || ! [[ $2 =~ $seeder_ref_re ]]; }; then
        morrer_cedo 2 "$uso"
      fi
      ref_chave=${2:-}
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
    secrets-key) cmd_secrets_key ;;
  esac
}

main "$@"
