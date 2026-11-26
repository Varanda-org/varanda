# shellcheck shell=bash
# Associações do app nativo (passkeys com rpId = o domínio): o Android só
# oferece a passkey do domínio ao app declarado em
# /.well-known/assetlinks.json e o iOS ao declarado em
# /.well-known/apple-app-site-association. Ao lado delas,
# /.well-known/app-release.json diz ao app Android instalado pela Google Play
# qual build a loja serve (apps/app/src/storeRelease.js). Lido com source por
# deploy.sh, update.sh e build-web.sh, que publicam www cada um do seu jeito:
# as regras ficam num só lugar para não divergirem, como as do version.json,
# da cópia do app para www e da versão marcada no index.html. Quem faz source
# define log (uma linha por chamada).

# O SHA-256 do keystore de depuração do React Native que vem com o app
# (apps/app/android/app/debug.keystore). A chave privada dele é pública:
# qualquer pessoa assinaria um app.varanda com ela e usaria as passkeys do
# domínio, então ele nunca entra no assetlinks.json.
chave_publica_de_depuracao='FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C'

# Retorna 0 se a lista $1, separada por vírgula, repete um item.
tem_item_repetido() {
  local resto=$1 item
  while [[ $resto == *,* ]]; do
    item=${resto%%,*}
    resto=${resto#*,}
    if [[ ,$resto, == *,"$item",* ]]; then
      return 0
    fi
  done
  return 1
}

# Lê VARANDA_ANDROID_CERT_SHA256 e VARANDA_IOS_APP_ID do .env em $1 (lidos,
# nunca executados: a última linha, espaço em volta do = aceito, comentário no
# fim, aspas e CR descartados) para android_cert e ios_app_id. O Android aceita
# de 1 a 4 certificados: o de assinatura do app no Google Play (Play Console) e,
# enquanto houver conferência com o APK de preview, o do keystore do EAS; a
# chave pública de depuração nunca entra. Um valor presente precisa ter a forma
# exata, porque vai para um JSON servido publicamente; fora dela, retorna 1 sem
# imprimir o valor. Vazio desliga o login nativo naquela plataforma, com um
# aviso. Um .env ausente vale como vazio. VARANDA_ANDROID_STORE_BUILD, lido
# como VARANDA_IOS_APP_ID para android_store_build, é o versionCode que a
# Google Play serve a todos; vazio apaga o app-release.json, sem aviso.
ler_associacoes() {
  local env_file=$1
  android_cert=''
  ios_app_id=''
  android_store_build=''
  if [ -f "$env_file" ]; then
    # Só um par de aspas em volta do valor todo é descartado: aspas dentro da
    # lista ("AA..","BB..") sobram e a conferência abaixo as recusa.
    android_cert=$(sed -n 's/^[[:space:]]*VARANDA_ANDROID_CERT_SHA256[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r' |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
    if [[ $android_cert =~ ^\"(.*)\"$ || $android_cert =~ ^\'(.*)\'$ ]]; then
      android_cert=${BASH_REMATCH[1]}
      android_cert=${android_cert#"${android_cert%%[![:space:]]*}"}
      android_cert=${android_cert%"${android_cert##*[![:space:]]}"}
    fi
    ios_app_id=$(sed -n 's/^[[:space:]]*VARANDA_IOS_APP_ID[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'" |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
    android_store_build=$(sed -n 's/^[[:space:]]*VARANDA_ANDROID_STORE_BUILD[[:space:]]*=//p' "$env_file" | tail -n 1 | tr -d '\r"'"'" |
      sed 's/[[:space:]]#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//')
  fi
  if [ -z "$android_cert" ]; then
    log 'aviso: VARANDA_ANDROID_CERT_SHA256 vazio, login nativo no Android desligado'
  elif ! [[ $android_cert =~ ^[0-9A-F]{2}(:[0-9A-F]{2}){31}(,[0-9A-F]{2}(:[0-9A-F]{2}){31}){0,3}$ ]] || tem_item_repetido "$android_cert" \
    || [[ ,$android_cert, == *,"$chave_publica_de_depuracao",* ]]; then
    log 'VARANDA_ANDROID_CERT_SHA256 inválido em deploy/seeder/.env (de 1 a 4 impressões digitais sem repetição, separadas por vírgula sem espaço, cada uma com 64 hexadecimais maiúsculos separados por dois-pontos; a chave pública de depuração nunca é aceita)'
    return 1
  fi
  if [ -z "$ios_app_id" ]; then
    log 'aviso: VARANDA_IOS_APP_ID vazio, login nativo no iOS desligado'
  elif ! [[ $ios_app_id =~ ^[A-Z0-9]{10}\.app\.varanda$ ]]; then
    log 'VARANDA_IOS_APP_ID inválido em deploy/seeder/.env (TEAMID.app.varanda)'
    return 1
  fi
  # O teto é o MAX_STORE_BUILD do app: um número que o app recusa nunca vira
  # aviso, e o deploy diz isso antes, em vez de publicar um arquivo inútil.
  if [ -n "$android_store_build" ] && ! [[ $android_store_build =~ ^[1-9][0-9]{0,8}$ ]]; then
    log 'VARANDA_ANDROID_STORE_BUILD inválido em deploy/seeder/.env (o versionCode da versão de produção na Google Play, um inteiro de 1 a 999999999)'
    return 1
  fi
}

# Grava em $1/.well-known os arquivos com os valores que ler_associacoes já
# conferiu, ou apaga o de uma variável vazia. Tudo ou nada: primeiro os
# arquivos novos ao lado (.tmp), e só com todas as escritas certas eles são
# movidos por cima (um rename, então o Caddy nunca serve um JSON pela metade)
# e os de variável vazia apagados. Se uma escrita falha (disco cheio, por
# exemplo), os .tmp somem, os arquivos publicados ficam como estavam e a
# função retorna 1, para quem chamou falhar com a mensagem certa. O
# handle_all_urls existe porque o Auth Tab do Chrome só entrega ao app o
# retorno https /account/app/conta depois de conferir esta declaração do
# Digital Asset Links; o app declara App Links (autoVerify) só para /c/,
# /g/, /anuncio/, /publicacao/, /@ e /m/ de bora.varanda.app: só esses links abrem no app
# instalado; o resto do site (inclusive a página pública /f/) continua no
# navegador. No iOS, webcredentials associa o host do retorno https do
# ASWebAuthenticationSession ao app, e applinks abre só /anuncio/, /publicacao/, /@ e /m/ no app;
# o app id vem de VARANDA_IOS_APP_ID, nenhum team id fica no código. O
# app-release.json tem exatamente a forma que storeRelease.js aceita.
gravar_associacoes() {
  local dir="$1/.well-known"
  local android="$dir/assetlinks.json" ios="$dir/apple-app-site-association"
  local loja="$dir/app-release.json"
  # Numa variável, não na expansão: o tratamento de aspas no texto de troca de
  # ${x//a/b} muda entre versões do bash. ler_associacoes já garantiu que o
  # valor só tem hexadecimais, dois-pontos e vírgulas.
  local entre_certs='","' p
  if ! mkdir -p "$dir"; then
    log "não foi possível criar $dir; associações do app nativo não alteradas"
    return 1
  fi
  # As mesmas guardas de gravar_versao, para os seis caminhos antes de
  # qualquer escrita: quem chama pode ser root, e a escrita nunca segue um
  # link. Um diretório no lugar de um arquivo faria o mv o pôr dentro dele (e
  # o rm falhar) depois de outros arquivos já trocados.
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    log "$dir não é um diretório comum; associações do app nativo não alteradas"
    return 1
  fi
  for p in "$android" "$android.tmp" "$ios" "$ios.tmp" "$loja" "$loja.tmp"; do
    if [ -L "$p" ] || { [ -e "$p" ] && [ ! -f "$p" ]; }; then
      log "$p não é um arquivo comum; associações do app nativo não alteradas"
      return 1
    fi
  done
  # Um .tmp que sobrou seria reaproveitado com o dono e o modo dele: ele sai,
  # e o novo nasce com 0644.
  if ! rm -f "$android.tmp" "$ios.tmp" "$loja.tmp" \
    || { [ -n "$android_cert" ] && { ! printf '[{"relation":["delegate_permission/common.get_login_creds","delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"app.varanda","sha256_cert_fingerprints":["%s"]}}]\n' "${android_cert//,/$entre_certs}" >"$android.tmp" || ! chmod 0644 "$android.tmp"; }; } \
    || { [ -n "$ios_app_id" ] && { ! printf '{"webcredentials":{"apps":["%s"]},"applinks":{"apps":[],"details":[{"appIDs":["%s"],"components":[{"/":"/anuncio/*"},{"/":"/publicacao/*"},{"/":"/@*"},{"/":"/m/*"}]}]}}\n' "$ios_app_id" "$ios_app_id" >"$ios.tmp" || ! chmod 0644 "$ios.tmp"; }; } \
    || { [ -n "$android_store_build" ] && { ! printf '{"v":1,"android":{"build":%s}}\n' "$android_store_build" >"$loja.tmp" || ! chmod 0644 "$loja.tmp"; }; }; then
    rm -f "$android.tmp" "$ios.tmp" "$loja.tmp" 2>/dev/null || true
    rmdir "$dir" 2>/dev/null || true
    log 'falha ao gravar as associações do app nativo; as anteriores ficaram como estavam'
    return 1
  fi
  # Daqui em diante só renames e remoções no mesmo diretório.
  if { [ -n "$android_cert" ] && ! mv -f "$android.tmp" "$android"; } \
    || { [ -z "$android_cert" ] && ! rm -f "$android"; } \
    || { [ -n "$ios_app_id" ] && ! mv -f "$ios.tmp" "$ios"; } \
    || { [ -z "$ios_app_id" ] && ! rm -f "$ios"; } \
    || { [ -n "$android_store_build" ] && ! mv -f "$loja.tmp" "$loja"; } \
    || { [ -z "$android_store_build" ] && ! rm -f "$loja"; }; then
    rm -f "$android.tmp" "$ios.tmp" "$loja.tmp" 2>/dev/null || true
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

# A versão do app web (16 hex) marcada no index.html em $1 (meta
# varanda-release, apps/app/scripts/finish-web.js), ou nada sem a marca ou
# sem o arquivo. A página carrega /varanda-node-<versão>.js, a cópia do nó
# que o export deixa ao lado de varanda-node.js.
versao_web() {
  local re='<meta name="varanda-release" content="([0-9a-f]{16})">'
  if [ -f "$1" ] && [[ $(<"$1") =~ $re ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

# Copia o app em $1 (o dist, ou a cópia de www guardada para a volta) para
# $2, um www já vazio, com o index.html por último, depois do sw.js: quando a
# página aparece, tudo o que ela carrega (o bundle com hash, a cópia do nó da
# versão) já está lá. Na ordem do diretório, uma página podia chegar antes do
# próprio nó e mostrar o erro de conexão. $3 é a opção do cp: -R por padrão;
# a volta passa -a, para que cada arquivo e pasta dentro de www mantenha dono,
# modo e data da cópia guardada (a própria pasta www não muda). Um sw.js ou
# index.html ausente fica ausente, como numa cópia da pasta inteira; uma
# origem vazia não copia nada, e uma origem que não é pasta retorna 1, sem
# tocar no destino. Qualquer cópia que falhe retorna 1.
copiar_app() {
  local dist=$1 destino=$2 opcao=${3:--R} p f
  [ -d "$dist" ] || return 1
  (
    shopt -s dotglob nullglob
    for p in "$dist"/*; do
      case ${p##*/} in
        index.html | sw.js) ;;
        *) cp "$opcao" "$p" "$destino/" || exit 1 ;;
      esac
    done
  ) || return 1
  for f in sw.js index.html; do
    if [ -e "$dist/$f" ] || [ -L "$dist/$f" ]; then
      cp "$opcao" "$dist/$f" "$destino/$f" || return 1
    fi
  done
}

# Põe em $2 (www, um bind mount: troca-se o conteúdo, nunca o diretório) o
# conteúdo de $1, que fica intacto. Nada é apagado antes: cada arquivo entra
# por uma cópia ao lado e um rename, que é atômico, primeiro tudo o que a
# página carrega, depois sw.js e por último index.html; só então sai o que $1
# não tem. Quem pede um arquivo no meio da troca recebe a versão antiga ou a
# nova dele, nunca um 404 de um www vazio. $1 é um caminho absoluto.
mesclar_www() {
  local novo=$1 destino=$2
  (
    # Chamada dentro de um `if !` (a volta), o bash ignora o errexit aqui
    # dentro: cada passo confere o próprio status.
    set -Eeuo pipefail
    cd "$novo" || exit 1
    # Um caminho que muda de tipo (arquivo virou pasta, ou o contrário) sai
    # antes; é o único que fica um instante ausente.
    instalar() {
      local rel=$1 tmp
      tmp="$destino/${rel%/*}/.${rel##*/}.mesclar"
      # Um link no lugar sai antes: o mv o seguiria e gravaria fora de www.
      if [ -L "$destino/$rel" ]; then
        rm -f "$destino/$rel" || return 1
      elif [ -d "$destino/$rel" ]; then
        rm -rf "${destino:?}/$rel" || return 1
      fi
      rm -rf "$tmp" || return 1
      cp -a "$novo/$rel" "$tmp" && mv -f "$tmp" "$destino/$rel"
    }
    find . -mindepth 1 -type d -print0 | while IFS= read -r -d '' rel; do
      if [ -L "$destino/$rel" ] || { [ -e "$destino/$rel" ] && [ ! -d "$destino/$rel" ]; }; then
        rm -f "$destino/$rel" || exit 1
      fi
      mkdir -p "$destino/$rel" || exit 1
    done || exit 1
    find . ! -type d ! -path ./sw.js ! -path ./index.html -print0 | while IFS= read -r -d '' rel; do
      instalar "$rel" || exit 1
    done || exit 1
    for rel in ./sw.js ./index.html; do
      if [ -e "$rel" ] || [ -L "$rel" ]; then
        instalar "$rel" || exit 1
      fi
    done
    cd "$destino" || exit 1
    find . -mindepth 1 -depth -print0 | while IFS= read -r -d '' rel; do
      if [ -e "$novo/$rel" ] || [ -L "$novo/$rel" ]; then
        continue
      fi
      rm -rf "${destino:?}/$rel" || exit 1
    done || exit 1
  )
}
