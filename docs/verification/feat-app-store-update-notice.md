# Aviso de nova versão na Play (branch feat/app-store-update-notice)

Só o aplicativo Android. Sem mudança de RPC, formato do protocolo ou Termos. Sem dependência nova: `package.json`, `package-lock.json` e `apps/app/ios/Podfile.lock` não mudam.

## O que mudou

- Módulo local `apps/app/modules/app-build`, autolinkado só no Android (`"platforms": ["android"]`, sem pasta `ios`): expõe `versionCode` (`PackageInfo.longVersionCode`) e `fromPlay` (`getInstallSourceInfo(...).installingPackageName == "com.android.vending"`, API 30; o minSdk do app é 31). O lado JS confere os dois valores e devolve `null` sem o módulo (web, iOS, Node).
- `apps/app/src/storeRelease.js` lê `<instalação>/.well-known/app-release.json`. Contrato, exatamente: `{"v":1,"android":{"build":N}}`, N inteiro de 1 a 999999999, nenhuma outra chave, no máximo 256 bytes ASCII. Qualquer outra resposta (redirecionamento, status fora de 2xx, tipo que não seja JSON, corpo maior, tempo esgotado de 10 s, sem rede) é "sem informação" e não muda o aviso. Pedido com `credentials: 'omit'` e `redirect: 'error'`. No app, o pedido passa pelo `expo/fetch` (`src/pwa.native.js`), que entrega o corpo em fluxo e respeita `redirect: 'error'`; o `fetch` global do React Native no Android baixa o corpo inteiro (já descomprimido) antes de qualquer conferência e segue redirecionamentos. Sem o `expo/fetch`, nenhum pedido. O limite de 256 bytes vale para os bytes decodificados durante a leitura: ao passar dele, o leitor é cancelado e o pedido abortado, sem ler o resto. Um `content-length` declarado acima do limite é recusado antes de ler; sem ele (fluxo em pedaços, ou gzip que o OkHttp tira junto com o cabeçalho), vale a contagem. Pedaços vazios são ignorados, e mais de 512 leituras encerram o pedido como "sem informação".
- O aviso só existe quando `fromPlay` é verdadeiro e a build servida é maior que a instalada. Sem instalação conhecida, nenhum pedido. Confere ao abrir, quando a instalação é carregada ou trocada, e ao voltar ao app (`AppState` `active`), com a espera mínima de 60 s entre conferências. Ao parar, o ouvinte sai e o pedido em curso é abortado.
- `App.js`: o botão do aviso chama `applyUpdate` de `src/pwa` (Android: abre `https://play.google.com/store/apps/details?id=app.varanda`; web: o mesmo `reload` de antes), e o efeito do vigia recomeça quando `installationOrigin()` muda, já sem o aviso da instalação anterior: uma instalação nova que responde 404 nunca avisa nada, então o aviso antigo ficaria. Texto do aviso e do botão sem mudança (`UPDATE_TEXT`, `UPDATE_ACTION`).

Contrato para o servidor: o caminho e o JSON acima. Enquanto o arquivo não existe (404), nada aparece.

## Servidor: publicação do app-release.json

- `deploy/seeder/well-known.sh`: `ler_associacoes` lê `VARANDA_ANDROID_STORE_BUILD` como `VARANDA_IOS_APP_ID` (última linha, CR, aspas e comentário no fim descartados) e confere `^[1-9][0-9]{0,8}$`; fora da forma, retorna 1 com uma mensagem que cita a variável e não o valor, antes de qualquer escrita. `gravar_associacoes` grava `app-release.json` (`{"v":1,"android":{"build":N}}` mais LF) no mesmo tudo ou nada dos outros dois arquivos (`.tmp` e rename); vazio apaga o arquivo na mesma sequência. `assetlinks.json` e `apple-app-site-association` não mudam.
- `gravar_associacoes` tem as mesmas guardas de `gravar_versao`, para os três arquivos e os três `.tmp`, antes de qualquer escrita: `.well-known` que é link ou não é diretório, ou um link ou algo que não é arquivo comum em qualquer dos seis caminhos, retorna 1 sem mexer em nada. Antes, um link plantado em `<arquivo>.tmp` fazia o JSON ser gravado no alvo do link (quem chama pode ser root), e um diretório no lugar do arquivo fazia o `mv` pôr o `.tmp` dentro dele e "dar certo" sem publicar. Um `.tmp` comum que sobrou é apagado antes, e os novos nascem com 0644.
- `deploy.sh` e `update.sh` declaram `android_store_build=''` ao lado de `android_cert`. Os chamadores (`build-web.sh`, `deploy.sh`, `update.sh`) não mudam: `grep` confirma que nenhum passa argumento novo.
- Caddyfile sem mudança: `handle /.well-known/*` já serve de `/srv/web` com `application/json`, `no-store` e 404 de verdade. Nenhum contêiner lê a variável (`compose.web.yaml` não a passa), então não é preciso recriar o `account`.
- Documentado no `README.md` (junto do `version.json` e de `VARANDA_ANDROID_CERT_SHA256`), em `deploy/seeder/.env.example` e no passo 9 de `docs/google-play.md`.
- Atualização de uma instalação para esta versão: o `deploy.sh` carrega o `well-known.sh` antes da troca de commit e o `update.sh` usa o da versão instalada, de propósito (a implantação roda as regras já conferidas, nunca as do candidato). Então a implantação que traz esta mudança ignora `VARANDA_ANDROID_STORE_BUILD` mesmo definida, e as rodadas seguintes do timer saem por estar em dia. Não mudei isso no código, porque seria inverter essa escolha de confiança: os três documentos dizem para definir a variável só depois dessa implantação, ou aplicar de novo com `update.sh reconfigure` (instalação por versão) ou com o `deploy.sh` de novo no mesmo commit (ou o deploy seguinte), que já carregam o `well-known.sh` novo.

Testes, cada arquivo sozinho com `node` da raiz:

- [x] `apps/cli/test/deploy.test.js`: 70 testes, 1320 asserções. Novos: válido (1, 42 e 999999999, bytes exatos e `parseStoreRelease` de `storeRelease.js` devolve o mesmo número), aspas, comentário, CR e a última linha; vazio e ausente depois de definido apagam o arquivo; 12 valores inválidos recusados, sem o valor na saída e com os três arquivos publicados iguais byte a byte; escrita que falha depois das anteriores (o `chmod` do `.tmp` simulado com falha, em `apple-app-site-association.tmp` e em `app-release.json.tmp`) deixa os três arquivos como estavam, no caminho do commit já implantado; guardas de `gravar_associacoes`: link em cada `.tmp` e em cada arquivo publicado recusado com o alvo intacto, diretório no lugar de cada arquivo (com a variável definida ou vazia) recusado sem nada movido para dentro e com os outros arquivos iguais, `.well-known` como link recusado, `.tmp` com modo 000 trocado e os três publicados com 0644; `build-web.sh` grava, recusa antes do build e apaga; `.env.example` traz a linha vazia
- [x] `apps/cli/test/update.test.js`: 81 testes, 2004 asserções. Novos: `apply` grava na `www` da versão; `reconfigure` recusa três valores inválidos sem compose, sem o valor no registro e sem mudar nada; `reconfigure` regrava, apaga com vazio e com a linha removida; `apply` de uma versão nova com valor inválido não prepara a versão; a volta automática e o `rollback` servem a cópia da versão anterior como estava; uma versão preparada em que só a variável mudou é regravada no lugar
- [x] `apps/cli/test/caddyfile.test.js` (27), `readme-help.test.js` (1), `readme-pull.test.js` (16), `release-bundle.test.js` (8), `apps/app/test/storeRelease.test.js` (21), `apps/app/test/hardening.test.js` (36), `apps/app/test/pwa.test.js` (15): passam
- [x] Prova de regressão: trocar a conferência por `^[0-9]{1,10}$` faz o teste de valores inválidos falhar; tirar a remoção do arquivo com a variável vazia faz falhar os testes de vazio e de ausente
- [x] `bash -n` em `well-known.sh`, `deploy.sh` e `update.sh`; `shellcheck -x deploy/seeder/well-known.sh` limpo; `npx standard` nos dois arquivos de teste

Depois de uma implantação aprovada pelo responsável:

- [ ] `curl -i https://bora.varanda.app/.well-known/app-release.json` responde 404 enquanto `VARANDA_ANDROID_STORE_BUILD` está vazia
- [ ] Com a variável definida, a mesma chamada responde 200, `application/json`, `no-store` e exatamente o JSON do contrato
- [ ] Um aparelho com uma build mais antiga instalada pela Play mostra o aviso; um com a build anunciada não mostra

## Testes

- [x] `node test/storeRelease.test.js`: 21 testes, 169 asserções (build menor, igual e maior, limites, chaves a mais, corpo grande, redirecionamento, tipo errado, tempo esgotado, sem rede, espera mínima, `fromPlay` falso, sem instalação, parada; e da rodada de correções: fluxo acima de 256 bytes cortado na leitura que passa do limite, com o leitor cancelado e o pedido abortado; `content-length` acima do limite recusado sem nenhuma leitura; pedaços vazios sem fim terminam em `null` em 512 leituras, antes do tempo esgotado; um `fetch` que recusa redirecionamento, como o `expo/fetch`, nunca segue; sem `fetch`, nenhum ouvinte)
- [x] `node test/appBuildModule.test.js`: importa no Node, `null` sem código nativo, validação, autolink só no Android pelo `ExpoModuleConfig` do expo-modules-autolinking
- [x] `node test/pwa.test.js`: 15 testes, 155 asserções. Instalação carregada depois do vigia gera exatamente uma conferência sem evento de `AppState`, pelo `expo/fetch` com `redirect: 'error'` e nunca pelo `fetch` global; trocar para uma instalação que responde 404 tira o aviso da anterior; só `active` confere; nada sem Play nem sem o `expo/fetch`; `applyUpdate` abre a Play; fiação do `App.js`, com `setUpdateReady(false)` ao recomeçar
- [x] `node test/release.test.js`, `node test/platformGate.test.js` e os 93 arquivos de teste que leem `App.js`, percorrem pastas ou leem `modules/`, cada um sozinho
- [x] Prova de regressão: cada uma destas mudanças no código faz um teste falhar: `>=` no lugar de `>`, tirar a exigência de `fromPlay`, tirar o limite de 256 bytes (texto e fluxo), tirar a conferência da origem do redirecionamento, aceitar chaves a mais, não abortar ao parar, um timer que não encerra, voltar o efeito do `App.js` para `[]`, conferir em qualquer estado do `AppState`, aceitar `fromPlay` que não seja booleano
- [x] Prova de regressão da rodada de correções, cada uma desfeita, rodada e restaurada (`cmp` com a cópia): sem o `fetch` do `expo/fetch` em `pwa.native.js`, o `pwa.test.js` falha ("exactly one check"); sem o `abort()` ao passar do limite, falham "the request itself is aborted" e "the request is aborted"; sem a recusa do `content-length` no fluxo, falham as quatro "nothing read"; sem o teto de leituras, o teste dos pedaços vazios falha ("ends at the read cap", "the reader is cancelled"); sem o `setUpdateReady(false)` no `App.js`, falha a fiação do `App.js`; sem a guarda de `fetch` no vigia, falham as duas "no listener"; com o `gravar_associacoes` de antes (sem guardas e sem apagar o `.tmp`), falham 23 asserções, entre elas "the link target is untouched" e "nothing moved into it". Tirar só o pulo dos pedaços vazios não faz teste falhar: o teto de leituras já limita a lista
- [x] `node test/appBuildModule.test.js` (5 testes, 55 asserções) e `node test/platformGate.test.js` (6, 871) depois da rodada de correções; não há `previewBuild.test.js`
- [x] `npx standard` nos arquivos mudados
- [x] `node apps/app/scripts/check-pods-lock.js` entre o `Podfile.lock` do commit e o da árvore: em dia; `git diff --stat origin/main -- apps/app/ios` vazio

A suíte completa roda na CI do GitHub do PR (Node 20 e 24). A compilação do Kotlin fica com o job Android da CI nativa (`assembleDebug`).

## O que não foi conferido no aparelho

Emulador Android com uma instalação local:

- [ ] Build de debug instalada com `adb install -r -i com.android.vending`, instalação servindo build 2: o aviso aparece, fecha no X e **atualizar** abre a página da Play
- [ ] A mesma instalação servindo build 1, um 404 ou um arquivo fora do contrato: nada aparece
- [ ] A mesma build instalada sem `-i`: nada aparece e nenhum pedido ao arquivo
- [ ] Trocar a instalação em Ajustes: confere a nova instalação, e o aviso da anterior some se a nova não anunciar build maior
- [ ] Build instalada pela Play no Android: o aviso ainda aparece com o `expo/fetch`; uma resposta maior que 256 bytes (ou um gzip grande) e uma resposta com redirecionamento não mostram nada e não derrubam o app
- [ ] Simulador iOS: nada aparece
- [ ] PWA na web: o aviso de nova versão e o recarregar seguem como antes
