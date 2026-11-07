# shellcheck shell=bash
# Associações do app nativo (passkeys com rpId = o domínio): o Android só
# oferece a passkey do domínio ao app declarado em
# /.well-known/assetlinks.json e o iOS ao declarado em
# /.well-known/apple-app-site-association. Lido com source por deploy.sh e por
# build-web.sh, que publicam www cada um do seu jeito: as regras ficam num só
# lugar para não divergirem. Quem faz source define log (uma linha por
# chamada).

# Lê VARANDA_ANDROID_CERT_SHA256 e VARANDA_IOS_APP_ID do .env em $1 (lidos,
# nunca executados: a última linha, espaço em volta do = aceito, comentário no
# fim, aspas e CR descartados) para android_cert e ios_app_id. Um valor
# presente precisa ter a forma exata, porque vai para um JSON servido
# publicamente; fora dela, retorna 1 sem imprimir o valor. Vazio desliga o
# login nativo naquela plataforma, com um aviso. Um .env ausente vale como
# vazio.
ler_associacoes() {
  local env_file=$1
  android_cert=''
  ios_app_id=''
  if [ -f "$env_file" ]; then
    android_cert=$(sed -n 's/^[[:space:]]*VARANDA_ANDROID_CERT_SHA256[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'" |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
    ios_app_id=$(sed -n 's/^[[:space:]]*VARANDA_IOS_APP_ID[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'" |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
  fi
  if [ -z "$android_cert" ]; then
    log 'aviso: VARANDA_ANDROID_CERT_SHA256 vazio, login nativo no Android desligado'
  elif ! [[ $android_cert =~ ^[0-9A-F]{2}(:[0-9A-F]{2}){31}$ ]]; then
    log 'VARANDA_ANDROID_CERT_SHA256 inválido em deploy/seeder/.env (64 hexadecimais maiúsculos separados por dois-pontos)'
    return 1
  fi
  if [ -z "$ios_app_id" ]; then
    log 'aviso: VARANDA_IOS_APP_ID vazio, login nativo no iOS desligado'
  elif ! [[ $ios_app_id =~ ^[A-Z0-9]{10}\.app\.varanda$ ]]; then
    log 'VARANDA_IOS_APP_ID inválido em deploy/seeder/.env (TEAMID.app.varanda)'
    return 1
  fi
}

# Grava em $1/.well-known os arquivos com os valores que ler_associacoes já
# conferiu, ou apaga o de uma variável vazia. Tudo ou nada: primeiro os dois
# arquivos novos ao lado (.tmp), e só com as duas escritas certas eles são
# movidos por cima (um rename, então o Caddy nunca serve um JSON pela metade)
# e os de variável vazia apagados. Se uma escrita falha (disco cheio, por
# exemplo), os .tmp somem, os arquivos publicados ficam como estavam e a
# função retorna 1, para quem chamou falhar com a mensagem certa. O
# handle_all_urls existe porque o Auth Tab do Chrome só entrega ao app o
# retorno https /account/app/conta depois de conferir esta declaração do
# Digital Asset Links; o app declara App Links (autoVerify) só para /c/ e
# /g/ de bora.varanda.app: só esses links abrem no app instalado; o resto
# do site continua no navegador. No iOS basta webcredentials: a Apple
# exige que o host do retorno https do ASWebAuthenticationSession esteja
# associado ao app pelos domínios de webcredentials.
gravar_associacoes() {
  local dir="$1/.well-known"
  local android="$dir/assetlinks.json" ios="$dir/apple-app-site-association"
  if ! mkdir -p "$dir"; then
    log "não foi possível criar $dir; associações do app nativo não alteradas"
    return 1
  fi
  if { [ -n "$android_cert" ] && ! printf '[{"relation":["delegate_permission/common.get_login_creds","delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"app.varanda","sha256_cert_fingerprints":["%s"]}}]\n' "$android_cert" >"$android.tmp"; } \
    || { [ -n "$ios_app_id" ] && ! printf '{"webcredentials":{"apps":["%s"]}}\n' "$ios_app_id" >"$ios.tmp"; }; then
    rm -f "$android.tmp" "$ios.tmp" 2>/dev/null || true
    rmdir "$dir" 2>/dev/null || true
    log 'falha ao gravar as associações do app nativo; as anteriores ficaram como estavam'
    return 1
  fi
  # Daqui em diante só renames e remoções no mesmo diretório.
  if { [ -n "$android_cert" ] && ! mv -f "$android.tmp" "$android"; } \
    || { [ -z "$android_cert" ] && ! rm -f "$android"; } \
    || { [ -n "$ios_app_id" ] && ! mv -f "$ios.tmp" "$ios"; } \
    || { [ -z "$ios_app_id" ] && ! rm -f "$ios"; }; then
    rm -f "$android.tmp" "$ios.tmp" 2>/dev/null || true
    log "falha ao trocar as associações do app nativo em $dir; confira à mão"
    return 1
  fi
  rmdir "$dir" 2>/dev/null || true
}

# Grava $1/version.json com o commit $2, que o app mostra em Ajustes. Os bytes
# saem sempre daqui, do commit já conferido, nunca do que o build deixou: o
# build roda código das dependências. Commit vazio (um checkout sem git, por
# exemplo) apaga o arquivo em vez de servir o de outra versão. Fora da forma
# exata, retorna 1 sem imprimir o valor. Um link simbólico ou um arquivo
# especial no caminho também retorna 1: quem chama pode ser root, e a escrita
# nunca segue um link. A troca é um rename, então o Caddy nunca serve um JSON
# pela metade.
gravar_versao() {
  local dir=$1 commit=$2
  local arquivo="$dir/version.json" tmp="$dir/version.json.tmp" p
  # O diretório é conferido antes de tudo, também antes de apagar: um rm por
  # um diretório que é link apagaria o arquivo de outro lugar.
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    log "$dir não é um diretório comum; version.json não gravado"
    return 1
  fi
  if [ -z "$commit" ]; then
    rm -f "$arquivo"
    return 0
  fi
  if ! [[ $commit =~ ^[0-9a-f]{40}$ ]]; then
    log 'commit inválido para version.json'
    return 1
  fi
  for p in "$arquivo" "$tmp"; do
    if [ -L "$p" ] || { [ -e "$p" ] && [ ! -f "$p" ]; }; then
      log "$p não é um arquivo comum; version.json não gravado"
      return 1
    fi
  done
  # Um .tmp deixado pelo build seria reaproveitado com o dono e o modo dele (um
  # 000 que o Caddy não lê): ele sai, e o novo nasce com 0644.
  if ! rm -f "$tmp" || ! printf '{"v":1,"commit":"%s"}\n' "$commit" >"$tmp" \
    || ! chmod 0644 "$tmp" || ! mv -f "$tmp" "$arquivo"; then
    rm -f "$tmp" 2>/dev/null || true
    log "falha ao gravar $arquivo"
    return 1
  fi
}
