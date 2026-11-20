# Conversa abre na primeira não lida (branch fix/chat-open-read-position)

Na web e no PWA, uma conversa com mensagens novas abria no fim. Agora uma conversa toda lida abre no fim, uma com mensagens novas abre na primeira não lida, sob a linha "Mensagens novas", e uma nunca lida abre na primeira mensagem. Enquanto a tela não está no fim, o botão de ir para o fim mostra quantas mensagens novas há abaixo. Um toque leva ao fim, esconde o botão e avança a posição de leitura (`dm.seen` com `upTo`). A posição continua sendo a do #776 (fichas de `dm.seen` e marca de `group.seen`), sem um segundo lugar para guardá-la, e segue para os outros aparelhos da mesma passkey pelo bloco de vistos.

## Causas

1. **Conversa nunca lida abria no fim.** `firstUnreadOf` (`packages/web-member/lib/dm.js`) devolvia `null` quando não havia nenhuma mensagem própria nem marcada, porque uma ficha que saía da janela de 128 do bloco de vistos não se distinguia de uma conversa nunca lida.
2. **Botão escondido logo na abertura.** O botão seguia `jumpVisible` (mais de 1,5 tela do fim) e uma contagem que só contava o que chegou depois de abrir. Uma abertura que pousava a menos de 1,5 tela do fim não mostrava nada.
3. **Web: o pouso lia uma lista sem medida.** `settleOpen` podia rodar antes de a lista medir a si mesma (quadro `{ y: 0, contentHeight: 0, layoutHeight: 0 }`), que se lia como "no fim" e escondia o botão. Na web, um pouso no alto não gera quadro de rolagem, e o conteúdo ainda cresce depois (482 para 2680 px na conferência). Dependia do tempo: aparecia ao abrir uma conversa depois de outra.
4. **Android: a lista travava numa página mais antiga.** Com `maintainVisibleContentPosition` (`keepVisiblePosition`), o `VirtualizedList` do RN 0.83 segura a janela de renderização depois de linhas inseridas no começo, até chegar um evento de rolagem. A busca da abertura insere a página mais antiga numa lista ainda menor que a tela, que nunca rola: ficavam só as primeiras 8 linhas, e todo `scrollToIndex` falhava. Já acontecia na `main` (vem do #776), e toda conversa nunca lida passa por esse caminho agora.
5. **A busca da mensagem direta parava depois de uma página.** Uma página que respondia antes de o React pintar o pedido deixava `loadingMore` falso nas duas renderizações, e o efeito da busca não rodava de novo.

## O que muda

- `packages/web-member/lib/dm.js`: `firstUnreadOf` sem posição devolve a primeira mensagem de quem conversa. `seenHeads(own)` devolve a posição de cada conversa como ficha de visto: a mensagem recebida mais nova marcada, nas 48 conversas próprias (`DM_HEADS_MAX`) de atividade mais recente, da menos recente para a mais recente. Nenhuma quando a posição é uma mensagem própria (essa chega sozinha aos outros aparelhos) ou quando nada foi lido.
- `packages/web-member/lib/seen-sync.js`: `keepHeads` dá a uma posição que o corte da janela tiraria um segundo acima de toda outra marca. Uma posição que já está na janela mantém o seu t, então uma sincronização sem marca nova não grava nada. As posições de dois aparelhos (até 96) cabem na janela de 128. Um leitor de posições que falha ou devolve lixo deixa a sincronização como antes. `session.js` liga `dmEngine.seenHeads` ao `createSeenSync`.
- `apps/app/src/readPosition.js`: `atEnd` (48 px de folga, quadro sem medida não é fim), `awayAfterFrame` (só a pessoa sai do fim; durante o pouso a tela conta como longe), `landingAway` (depois do pouso, sem quadro de rolagem, os tamanhos decidem, e uma lista sem medida conta como longe), `unreadBelow` (mensagens de quem conversa abaixo do cursor, ou a partir do alvo antes do pouso) e `jumpState` (botão sempre que longe, contagem até 99+, dica falada).
- `Mensagem.js` e `Grupo.js`: o botão segue `jumpState`; depois do pouso, `onLayout` e `onContentSizeChange` chamam `watchLanding` até o primeiro quadro de rolagem; `keepVisiblePosition={placed}`, só depois do pouso; a busca da mensagem direta depende de `next`; um envio próprio encerra um pouso ainda a caminho. `RefreshableList` repassa `onLayout`.
- `apps/app/src/ui/JumpToEnd.js`: a contagem no canto do botão, como a do `IconAction`, no lugar do ponto. `chatGestures.js` perde `jumpVisible` e `awayCount`.
- `docs/rpc.md` 5.78 (`firstUnread` de uma conversa nunca lida) e 5.96 (posições no bloco), `docs/protocol.md` §14 (regras locais e limites).

## Testes automatizados

Cada arquivo rodado sozinho (`node <arquivo>`):

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/app/test/readPosition.test.js` | 13/13 | 83/83 |
| `apps/app/test/chatGestures.test.js` | 29/29 | 495/495 |
| `apps/app/test/chatActions.test.js` | 20/20 | 117/117 |
| `packages/web-member/test/dm.test.js` | 95/95 | 922/922 |
| `packages/web-member/test/seen-sync.test.js` | 45/45 | 339/339 |
| `packages/web-member/test/dm-seen-heads-e2e.test.js` | 1/1 | 11/11 |
| `packages/core/test/seen-blob.test.js` | 38/38 | 243/243 |
| `packages/rpc/test/sizes.test.js` | 42/42 | 431/431 |

Arquivos que importam ou leem um módulo mudado, pelo executor (`node ../../scripts/run-tests.js <arquivos>`): 47 arquivos em `apps/app` e 33 em `packages/web-member` (os de mensagens diretas, do bloco de vistos e os que carregam `lib/session.js`), sem falha. `npm run lint` limpo. `npm run demo` termina com `DEMO OK`. A suíte inteira roda na CI do GitHub.

`dm-seen-heads-e2e.test.js` usa dois aparelhos da mesma passkey e o serviço de conta: o aparelho A lê parte de uma conversa e depois marca, em outras conversas, mais mensagens do que a janela guarda; o aparelho B abre a conversa na mesma mensagem.

Os testes de regressão falham sem a correção (cada correção desfeita sozinha, o teste rodado de novo):

| Correção desfeita | O que falha |
|---|---|
| `firstUnreadOf` volta a devolver `null` sem posição | `dm.test.js` (2 testes, 4 asserções) e `dm-seen-heads-e2e.test.js` |
| `keepHeads` não faz nada | `seen-sync.test.js` (2 testes, 5 asserções) e `dm-seen-heads-e2e.test.js` |
| `keepVisiblePosition` ligado desde a abertura | `chatGestures.test.js`, "the chats keep the visible row in place only after the landing" |
| a busca da mensagem direta sem `next` nas dependências | `chatGestures.test.js`, "the DM open walk asks the next older page" |
| `awayAfterFrame` sem o caso do pouso a caminho | `readPosition.test.js` (1 teste) e `chatGestures.test.js`, "an estimate scroll that clamps at the end" |
| o pouso lê `!atEnd` em vez de `landingAway` (em `Mensagem.js` ou em `Grupo.js`) | `chatGestures.test.js`, "a landing no scroll frame followed is decided by the sizes" |

## Nos aparelhos

Vitrine (`EXPO_PUBLIC_VARANDA_VITRINE=1`) com um acréscimo temporário, desfeito antes do commit: conversas de 80 mensagens (André toda lida, Bia lida até a 50, Tomás com a primeira não lida numa página mais antiga, Pessoa nunca lida, num pedido) e um grupo de 80 publicações com a primeira não lida duas páginas atrás. Build de debug do Android (emulador API 36), simulador iOS (iPhone 16e) e a web (`expo start --web`) num navegador com tela de celular.

| Caso | Android | iOS | Web |
|---|---|---|---|
| Toda lida | abre no fim, sem botão | abre no fim, sem botão | abre no fim, sem botão |
| Lida até a metade | abre em "Mensagens novas", botão com a contagem; o toque leva ao fim e esconde o botão | igual | igual |
| Primeira não lida numa página mais antiga | carrega a página e abre na 32, botão 33 (antes da correção, travava nas 8 primeiras linhas) | abre na primeira não lida, botão com a contagem | abre na primeira não lida, botão com a contagem |
| Sair no meio e voltar | abre na próxima não lida | igual | igual |
| Nunca lida, aberta depois de outra conversa | abre na mensagem 1, botão 65 | abre na mensagem 1, botão 68 | abre na mensagem 1, botão 68; o toque leva ao fim, `dm.seen` com `upTo` e depois o fim |
| Grupo, primeira não lida duas páginas atrás | abre na primeira não lida, botão com a contagem | igual | abre na G32, botão 41 |

O caso "nunca lida, aberta depois de outra conversa" é o que achou a causa 3 na web: antes de `landingAway`, a conversa abria na mensagem 1 sem botão. Conferido de novo nas três plataformas depois da correção. Também depois dela: "toda lida" nas três, a página mais antiga no Android e o grupo na web. As outras linhas são da rodada anterior a `landingAway`.

## O que não foi conferido

- Dois aparelhos de verdade: a posição levada pelo bloco de vistos foi conferida só no teste ponta a ponta (`dm-seen-heads-e2e.test.js`), não com duas instalações.
- Contas reais: a Vitrine não passa por `node.request`.
- PWA instalado: conferido no Chrome com a tela de celular, não com o PWA instalado.

## Limites conhecidos

- Primeira não lida mais de 3 páginas atrás: a conversa abre na linha mais antiga carregada, como no #776.
- O bloco guarda a posição das 48 conversas de atividade mais recente. Numa conversa fora delas, uma posição que saiu da janela abre no outro aparelho na posição mais antiga que esse aparelho tem.
- As marcas de uma Página ficam no aparelho que as fez: uma conversa da Página lida em outro aparelho abre lá como nunca lida.
- Um grupo sem marca abre no fim, como antes.
- Num aparelho novo, uma conversa aberta antes da primeira sincronização usa a posição desse aparelho.
- Logo depois do pouso, a contagem pode mudar uma vez quando o cursor anda para a última linha visível.
- Na web, o botão pode aparecer por um instante antes de a lista medir a si mesma, numa conversa que cabe inteira na tela; some quando os tamanhos chegam.
