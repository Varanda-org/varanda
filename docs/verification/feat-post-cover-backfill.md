# Capa automática de publicações antigas

Escopo: integração N8 do PR `feat/post-cover-backfill`, preservando as mudanças anteriores do RPC, do serviço de Páginas, do planejador, dos stores e dos Termos. A passagem usa `sendCover` e os mesmos envios de capa da folha manual, sem alterar seu botão. Reserva a tentativa antes de ler ou baixar o post, relê a elegibilidade antes do upload e interrompe os próximos envios quando a identidade ou a disponibilidade muda. Não há repetição automática, publicação nova, aviso ou selo.

A vitrine é excluída por `node.config == null`, a mesma distinção usada pelo snapshot em `App.js`; o provedor de vitrine em `src/node.js` fornece `config: null`. Os papéis vêm das listas assinadas `owned` e `admin` (`pagesRun` e `actingPageStopped`, em `src/pageSecrets.js`) e são conferidos também em `owner` e `admins` do status atual. A leitura usa `actAs` diretamente porque `pagesList` também faz manutenção de chaves de conversas. Páginas encerradas, movidas, sem papel atual ou com status recusado não fornecem candidatos.

## Testes executados

Executados sem rede, com fakes para as dependências da passagem, da mídia e do hook. Os bytes AVIF/JPEG do teste são fixtures; esses resultados não comprovam decodificação em aparelho. A suíte nova confere reserva aguardada, quatro posts por passagem, uma Página, persistência após nova abertura, falhas, respostas incertas, status relido, perda de papel, ausência de `uncovered` e cancelamento durante uma assinatura de Página.

Seleção: os cinco arquivos pedidos e todos os arquivos encontrados por `rg -l 'App.js' apps/app/test`, cada um executado com `node`. Todos passaram, sem falha intermitente.

```text
node apps/app/test/age.test.js: # tests = 23/23 pass; # asserts = 324/324 pass
node apps/app/test/agePolicyOrigin.test.js: # tests = 2/2 pass; # asserts = 8/8 pass
node apps/app/test/backgroundTask.test.js: # tests = 16/16 pass; # asserts = 83/83 pass
node apps/app/test/chatMedia.test.js: # tests = 56/56 pass; # asserts = 282/282 pass
node apps/app/test/composePolish.test.js: # tests = 16/16 pass; # asserts = 204/204 pass
node apps/app/test/conversaScreen.test.js: # tests = 108/108 pass; # asserts = 957/957 pass
node apps/app/test/conversas.test.js: # tests = 44/44 pass; # asserts = 264/264 pass
node apps/app/test/conversasDotWiring.test.js: # tests = 19/19 pass; # asserts = 66/66 pass
node apps/app/test/coverBackfill.test.js: # tests = 18/18 pass; # asserts = 200/200 pass
node apps/app/test/coverBackfillPass.test.js: # tests = 19/19 pass; # asserts = 119/119 pass
node apps/app/test/depoimentos.test.js: # tests = 33/33 pass; # asserts = 290/290 pass
node apps/app/test/devices.test.js: # tests = 32/32 pass; # asserts = 188/188 pass
node apps/app/test/dm.test.js: # tests = 62/62 pass; # asserts = 584/584 pass
node apps/app/test/dmNoticeKey.test.js: # tests = 5/5 pass; # asserts = 72/72 pass
node apps/app/test/emptyAccount.test.js: # tests = 14/14 pass; # asserts = 104/104 pass
node apps/app/test/eventReminders.test.js: # tests = 7/7 pass; # asserts = 129/129 pass
node apps/app/test/eventosScreen.test.js: # tests = 5/5 pass; # asserts = 23/23 pass
node apps/app/test/feiraCompose.test.js: # tests = 30/30 pass; # asserts = 426/426 pass
node apps/app/test/feiraEntry.test.js: # tests = 19/19 pass; # asserts = 113/113 pass
node apps/app/test/feiraOffer.test.js: # tests = 16/16 pass; # asserts = 135/135 pass
node apps/app/test/feiraScreen.test.js: # tests = 26/26 pass; # asserts = 311/311 pass
node apps/app/test/group-flow.test.js: # tests = 76/76 pass; # asserts = 597/597 pass
node apps/app/test/hardening.test.js: # tests = 25/25 pass; # asserts = 272/272 pass
node apps/app/test/hashtagNav.test.js: # tests = 9/9 pass; # asserts = 750/750 pass
node apps/app/test/identidadeBoot.test.js: # tests = 4/4 pass; # asserts = 24/24 pass
node apps/app/test/inviteDrop.test.js: # tests = 26/26 pass; # asserts = 213/213 pass
node apps/app/test/inviteWelcome.test.js: # tests = 6/6 pass; # asserts = 80/80 pass
node apps/app/test/linkReturn.test.js: # tests = 27/27 pass; # asserts = 267/267 pass
node apps/app/test/metroBlocked.test.js: # tests = 2/2 pass; # asserts = 3/3 pass
node apps/app/test/momentosScreen.test.js: # tests = 178/178 pass; # asserts = 1440/1440 pass
node apps/app/test/musicEmbedCard.test.js: # tests = 84/84 pass; # asserts = 831/831 pass
node apps/app/test/nativeLinks.test.js: # tests = 10/10 pass; # asserts = 50/50 pass
node apps/app/test/noticeReadsWiring.test.js: # tests = 10/10 pass; # asserts = 112/112 pass
node apps/app/test/onceSync.test.js: # tests = 11/11 pass; # asserts = 90/90 pass
node apps/app/test/pageCallers.test.js: # tests = 6/6 pass; # asserts = 22/22 pass
node apps/app/test/pageMoment.test.js: # tests = 16/16 pass; # asserts = 94/94 pass
node apps/app/test/pageShare.test.js: # tests = 12/12 pass; # asserts = 97/97 pass
node apps/app/test/pages.test.js: # tests = 102/102 pass; # asserts = 887/887 pass
node apps/app/test/passkeyTrouble.test.js: # tests = 18/18 pass; # asserts = 265/265 pass
node apps/app/test/perfMarks.test.js: # tests = 21/21 pass; # asserts = 113/113 pass
node apps/app/test/perfScroll.test.js: # tests = 10/10 pass; # asserts = 54/54 pass
node apps/app/test/phone.test.js: # tests = 22/22 pass; # asserts = 220/220 pass
node apps/app/test/platformGate.test.js: # tests = 6/6 pass; # asserts = 846/846 pass
node apps/app/test/postActions.test.js: # tests = 21/21 pass; # asserts = 171/171 pass
node apps/app/test/postLinkOpen.test.js: # tests = 9/9 pass; # asserts = 118/118 pass
node apps/app/test/postShare.test.js: # tests = 25/25 pass; # asserts = 503/503 pass
node apps/app/test/publicGroupsBoxScreen.test.js: # tests = 6/6 pass; # asserts = 43/43 pass
node apps/app/test/push-shell.test.js: # tests = 6/6 pass; # asserts = 96/96 pass
node apps/app/test/push-switch.test.js: # tests = 6/6 pass; # asserts = 24/24 pass
node apps/app/test/quotes.test.js: # tests = 8/8 pass; # asserts = 47/47 pass
node apps/app/test/replyBar.test.js: # tests = 21/21 pass; # asserts = 282/282 pass
node apps/app/test/ruaChrome.test.js: # tests = 15/15 pass; # asserts = 175/175 pass
node apps/app/test/ruaSnapshot.test.js: # tests = 23/23 pass; # asserts = 173/173 pass
node apps/app/test/screensPolish.test.js: # tests = 17/17 pass; # asserts = 265/265 pass
node apps/app/test/seenSync.test.js: # tests = 60/60 pass; # asserts = 259/259 pass
node apps/app/test/shareShell.test.js: # tests = 8/8 pass; # asserts = 49/49 pass
node apps/app/test/snapshotSafety.test.js: # tests = 14/14 pass; # asserts = 89/89 pass
node apps/app/test/sorte.test.js: # tests = 10/10 pass; # asserts = 195/195 pass
node apps/app/test/soundMute.test.js: # tests = 20/20 pass; # asserts = 90/90 pass
node apps/app/test/splashGate.test.js: # tests = 17/17 pass; # asserts = 325/325 pass
node apps/app/test/stackEntries.test.js: # tests = 4/4 pass; # asserts = 11/11 pass
node apps/app/test/storageFullNote.test.js: # tests = 2/2 pass; # asserts = 21/21 pass
node apps/app/test/termsCreate.test.js: # tests = 18/18 pass; # asserts = 184/184 pass
node apps/app/test/themeUsage.test.js: # tests = 9/9 pass; # asserts = 1605/1605 pass
node apps/app/test/vitrine.test.js: # tests = 65/65 pass; # asserts = 4740/4740 pass
node apps/app/test/vitrineGuard.test.js: # tests = 12/12 pass; # asserts = 1482/1482 pass
Total: 66 arquivos, 1647 testes e 23156 asserções aprovados.

```

Lint executado:

```sh
XDG_CACHE_HOME=/tmp/n8-standard-cache npx --no-install standard apps/app/App.js apps/app/src/coverBackfillPass.js apps/app/src/useCoverBackfill.js apps/app/src/vitrine/request.js apps/app/test/coverBackfillPass.test.js apps/app/test/vitrine.test.js
```

Resultado final: saída vazia, código 0. A primeira execução com cache padrão foi impedida pelo sandbox: `Error: EPERM: operation not permitted, open '/Users/rodrigopavezi/.cache/standard/v17/.cache_1lhaj4w'`. Com cache gravável, houve dois apontamentos no teste novo: `Promise constructor parameters must be named to match "^_?resolve$" (promise/param-names)` e `The Function constructor is eval. (no-new-func)`. Ambos corrigidos; o hook é carregado por import ESM com dependências falsas.

Regressão: salvo o arquivo original em uma cópia temporária, `claim` foi movido para depois de `fetchStill`. `node apps/app/test/coverBackfillPass.test.js` saiu com código 1: `# tests = 13/18 pass`, `# asserts = 106/115 pass`, incluindo `not ok - claim precedes even the stored record request`. O original foi restaurado byte a byte; a mesma suíte voltou a `18/18` testes e `115/115` asserções. Depois foi acrescentada a conferência de uma reserva ainda pendente, dando o resultado final `19/19` e `119/119` registrado acima.

## Verificações em dispositivos, não executadas

1. **Android debug build: NÃO EXECUTADO.** Conferir uma publicação antiga já compartilhada com foto AVIF, sem tocar no botão: após o nó ficar ocioso, `/capa` deve servir a capa criada no aparelho, se houver decodificação. Registrar se o AVIF guardado virou JPEG ou retornou `null` (não medido). Conferir que uma segunda abertura não tenta esse post de novo e que `/capa` não serve nada depois de tirar a publicação da web. O debug não entra com passkey numa instalação de produção; a conferência com conta requer o APK de preview conforme `docs/development.md`.
2. **Simulador iOS: NÃO EXECUTADO.** Repetir a publicação antiga AVIF, a capa em `/capa` sem toque, a segunda abertura sem nova tentativa e `/capa` vazio após retirar da web. Registrar JPEG ou `null` para a decodificação do AVIF guardado (não medido). A entrada com passkey depende do domínio associado da conta Apple Developer.
3. **Web: NÃO EXECUTADO.** Repetir a publicação antiga AVIF, a capa em `/capa` sem toque, a segunda abertura sem nova tentativa e `/capa` vazio após retirar da web. Registrar JPEG ou `null` para a decodificação do AVIF guardado (não medido), inclusive no PWA.

Não executados: lint global, suíte global `npm test`, demo, builds, emulador, simulador e navegador. Este trabalho executou somente a seleção de testes e o lint dos arquivos alterados solicitados para a lane. Nenhuma instalação de dependências, operação de escrita do Git, workflow, implantação ou rede externa foi executada.
