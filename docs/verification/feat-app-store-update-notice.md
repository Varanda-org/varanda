# Aviso de nova versão na Play (branch feat/app-store-update-notice)

Só o aplicativo Android. Sem mudança de RPC, formato do protocolo ou Termos. Sem dependência nova: `package.json`, `package-lock.json` e `apps/app/ios/Podfile.lock` não mudam.

## O que mudou

- Módulo local `apps/app/modules/app-build`, autolinkado só no Android (`"platforms": ["android"]`, sem pasta `ios`): expõe `versionCode` (`PackageInfo.longVersionCode`) e `fromPlay` (`getInstallSourceInfo(...).installingPackageName == "com.android.vending"`, API 30; o minSdk do app é 31). O lado JS confere os dois valores e devolve `null` sem o módulo (web, iOS, Node).
- `apps/app/src/storeRelease.js` lê `<instalação>/.well-known/app-release.json`. Contrato, exatamente: `{"v":1,"android":{"build":N}}`, N inteiro de 1 a 999999999, nenhuma outra chave, no máximo 256 bytes ASCII. Qualquer outra resposta (redirecionamento, status fora de 2xx, tipo que não seja JSON, corpo maior, tempo esgotado de 10 s, sem rede) é "sem informação" e não muda o aviso. Pedido com `credentials: 'omit'` e `redirect: 'error'`.
- O aviso só existe quando `fromPlay` é verdadeiro e a build servida é maior que a instalada. Sem instalação conhecida, nenhum pedido. Confere ao abrir, quando a instalação é carregada ou trocada, e ao voltar ao app (`AppState` `active`), com a espera mínima de 60 s entre conferências. Ao parar, o ouvinte sai e o pedido em curso é abortado.
- `App.js`: o botão do aviso chama `applyUpdate` de `src/pwa` (Android: abre `https://play.google.com/store/apps/details?id=app.varanda`; web: o mesmo `reload` de antes), e o efeito do vigia recomeça quando `installationOrigin()` muda. Texto do aviso e do botão sem mudança (`UPDATE_TEXT`, `UPDATE_ACTION`).

Contrato para o servidor: o caminho e o JSON acima. Enquanto o arquivo não existe (404), nada aparece.

## Testes

- [x] `node test/storeRelease.test.js`: 16 testes (build menor, igual e maior, limites, chaves a mais, corpo grande, redirecionamento, tipo errado, tempo esgotado, sem rede, espera mínima, `fromPlay` falso, sem instalação, parada)
- [x] `node test/appBuildModule.test.js`: importa no Node, `null` sem código nativo, validação, autolink só no Android pelo `ExpoModuleConfig` do expo-modules-autolinking
- [x] `node test/pwa.test.js`: instalação carregada depois do vigia gera exatamente uma conferência sem evento de `AppState`; só `active` confere; nada sem Play; `applyUpdate` abre a Play; fiação do `App.js`
- [x] `node test/release.test.js`, `node test/platformGate.test.js` e os 93 arquivos de teste que leem `App.js`, percorrem pastas ou leem `modules/`, cada um sozinho
- [x] Prova de regressão: cada uma destas mudanças no código faz um teste falhar: `>=` no lugar de `>`, tirar a exigência de `fromPlay`, tirar o limite de 256 bytes (texto e fluxo), tirar a conferência da origem do redirecionamento, aceitar chaves a mais, não abortar ao parar, um timer que não encerra, voltar o efeito do `App.js` para `[]`, conferir em qualquer estado do `AppState`, aceitar `fromPlay` que não seja booleano
- [x] `npx standard` nos arquivos mudados
- [x] `node apps/app/scripts/check-pods-lock.js` entre o `Podfile.lock` do commit e o da árvore: em dia; `git diff --stat origin/main -- apps/app/ios` vazio

A suíte completa roda na CI do GitHub do PR (Node 20 e 24). A compilação do Kotlin fica com o job Android da CI nativa (`assembleDebug`).

## O que não foi conferido no aparelho

Emulador Android com uma instalação local:

- [ ] Build de debug instalada com `adb install -r -i com.android.vending`, instalação servindo build 2: o aviso aparece, fecha no X e **atualizar** abre a página da Play
- [ ] A mesma instalação servindo build 1, um 404 ou um arquivo fora do contrato: nada aparece
- [ ] A mesma build instalada sem `-i`: nada aparece e nenhum pedido ao arquivo
- [ ] Trocar a instalação em Ajustes: confere a nova instalação
- [ ] Simulador iOS: nada aparece
- [ ] PWA na web: o aviso de nova versão e o recarregar seguem como antes
