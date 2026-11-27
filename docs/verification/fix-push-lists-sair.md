# Listas do service worker esvaziadas ao sair (branch fix/push-lists-sair)

A partir de `origin/main` `63f912982`. Sem mudança de RPC, de Termos nem de `apps/app/scripts/sw.js`: o worker já troca a lista inteira a cada mensagem `varanda-blocks` ou `varanda-mutes`, então uma lista vazia é a limpeza, e um worker antigo ainda ativo a entende.

## O que mudou

- `apps/app/src/pushBlocks.web.js`: `clearPushLists()` envia `[]` para as duas listas e fecha um portão; `openPushLists()` o abre. Com o portão fechado, `reportBlocks` e `reportMutes` não enviam nada. O portão começa fechado a cada carga da página, porque `block.list` e `mute.list` respondem sem conta aberta. Um contador por tipo descarta um envio que ainda esperava o `serviceWorker.ready` quando outro (ou a limpeza) foi feito depois.
- `apps/app/src/pushBlocks.native.js`: os mesmos quatro nomes, sem efeito.
- `apps/app/src/node.js`: `clearPushLists()` na troca de dono (antes de o estado mostrar o novo dono), em `forgetConfig` e, para Sair e Recomeçar, só depois de a operação dar certo. Um Sair que falha mantém as listas. Bloquear o app não as limpa, de propósito: a conta continua no aparelho e os avisos de quem foi bloqueado ou silenciado continuam quietos.
- `apps/app/src/blocksProvider.js` e `apps/app/src/mutesProvider.js`: com uma sessão aberta (`unlocked`, sem `signedOut`, com `publicKey`), abrem o portão e reenviam a lista atual se uma leitura completa foi gravada desde a última limpeza dos caches locais. Uma resposta de `mute.list` pedida antes de uma limpeza não conta.
- Limpeza que não chega ao worker: `clearPushLists()` também grava a marca `varanda-push-lists-clear` no `localStorage`, e cada carga da página envia as listas vazias de novo enquanto a marca existir; `openPushLists()` a apaga. Sem `localStorage`, a limpeza vai uma vez, como antes.
- Um nó antigo sem `identity.signOut` faz Sair como `lock`; aí as listas não são limpas, porque a sessão continua guardada. A limpeza só roda quando `signOut` ou `reset` de fato rodou.
- Uma resposta de `block.list` ou `mute.list` sem lista de chaves não vai mais ao worker (antes chegava como "ninguém bloqueado"): o worker fica com a última lista boa. As telas continuam como antes.

## Comandos

Da raiz da worktree, um arquivo por vez:

| Comando | Resultado |
|---|---|
| `node apps/app/test/pushLists.test.js` (novo) | 13/13 testes, 55/55 asserções |
| `node apps/app/test/sw.test.js` (um teste novo) | 131/131, 2183/2183 |
| `node apps/app/test/snapshotSafety.test.js` | 15/15, 116/116 |
| `node apps/app/test/memberMutes.test.js` | 8/8, 43/43 |
| `node apps/app/test/comunidadesShelves.test.js` | 15/15, 70/70 |
| `node apps/app/test/publicGroupsBoxScreen.test.js` | 6/6, 44/44 |
| `node apps/app/test/localCaches.test.js` | 13/13, 70/70 |
| `node apps/app/test/memberBlocks.test.js` | 16/16, 65/65 (ver abaixo) |
| demais testes de `apps/app/test` que leem estes arquivos (backgroundTask, connectText, crashSignal, emptyAccount, dm, hardening, historyCopy, hostedContext, installationStore, momentosScreen, nodeHandle, musicPlayerCard, musicRecents, openLine, passkeysScreen, peekKeep, requestQueue, storageFullNote, slowRequest, startWipe, vitrineIndex, webnodeHandle, vitrineGuard, workletLease, platformGate) | todos passam |
| `npm run lint` | sem erros |
| `npm run demo` | `DEMO OK` |

Regressão: com o `pushBlocks.web.js` da `main`, os testes 1 a 5 de `pushLists.test.js` falham (4/9 testes passam): sem `clearPushLists`, a lista antiga que esperava o worker chega por último, e uma carga da página envia a lista antes de haver conta aberta.

`memberBlocks.test.js`: os testes 9 a 11 enviam uma lista sem antes abrir o portão, então passam a chamar `openPushLists()` antes de `reportBlocks` e `reportMutes`.

Segunda rodada (marca no `localStorage`, Sair num nó sem `identity.signOut`, resposta sem lista de chaves): oito mutações, cada uma derruba um teste novo. Exemplo: sem a linha `if (owed()) sendClear()`, o teste 8 de `pushLists.test.js` falha (53/55 asserções).

O teste novo de `sw.test.js` passa também na `main`: depois de `varanda-blocks` e `varanda-mutes` vazios, um push de quem estava bloqueado ou silenciado aparece de novo, inclusive num worker recriado com o mesmo Cache API.

## Fora daqui

- Não conferido num navegador nem no PWA instalado.
- Bloquear o app mantém as listas (por desenho).
