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
# Digital Asset Links; o app não declara intent-filter https, então não
# toma para si nenhum link do site. No iOS basta webcredentials: a Apple
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
