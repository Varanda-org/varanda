# Rolagem das conversas no Android (branch fix/android-chat-scroll)

## O que foi conferido

A pessoa relatou que, no app Android, a conversa privada e a do grupo ainda pulavam para o fim, o que já não acontecia no PWA depois de #874 e #894. No nativo a lista continua a FlatList com janela (sem `allRowsOnWeb`). Este diagnóstico procurou o que ainda move a leitura sem pedido da pessoa, com a correção do teclado (T-B1) já aplicada: o `keyboardDidShow` de `Mensagem.js` e `Grupo.js` não rola quando a vista está longe do fim, e os seus timers são cancelados por uma rolagem da pessoa e na troca de conversa.

## Como foi medido

- Emulador Android `varanda-api36` (API 36, 1080x2400), build de debug `app.varanda.debug`, bundle de desenvolvimento do Metro com `EXPO_PUBLIC_VARANDA_VITRINE=1`.
- Edição temporária em `apps/app/src/vitrine/request.js`, desfeita no fim com `git checkout`:
  - 60 mensagens "antiga 1..60" antes da conversa com João Nascimento e no grupo "Passeios de bicicleta";
  - `dm.thread` e `group.read` passam a devolver `firstUnread` real na página mais nova, `mark` linhas antes do fim;
  - atraso opcional de leitura (`delay`) e, com `incoming`, uma mensagem nova acrescentada na primeira releitura depois de 5 s;
  - os valores vinham de um `cfg.json` servido em localhost e lido a cada leitura da página mais nova, então cada cenário trocava a configuração sem reiniciar o Metro.
- Registros temporários `[DB]` nas duas telas, restauradas no fim a partir de uma cópia do estado T-B1: cada `scrollToEnd` com quem chamou (`followEnd` com a origem, o timer de 50 ms, o teclado, o botão de ir ao fim, o envio), `scrollToIndex` e o `scrollToOffset` de reserva da abertura, `userScroll`, cada quadro de `trackBottom` (y, altura do conteúdo e da lista, `away`, `pinned`, `atBottom`, `placed`, tipo do plano, se a linha mais nova está entre as visíveis) e o ramo de `onContentSizeChange`.
- Para S6, um timer temporário de 6 s em cada tela relia a conversa (`reread` em `Mensagem.js`, `loadRef.current()` em `Grupo.js`).
- Posição de leitura: textos visíveis lidos por `uiautomator dump` em cada ponto (aberto, 2 s, depois da ação), mais capturas de tela. Gestos por `adb shell input`, sempre no meio da tela.

## Resultados

"Pulou" quer dizer que a posição de leitura mudou sem a pessoa pedir.

| Cenário | Conversa privada | Grupo |
|---|---|---|
| S1, tudo lido | Não pulou. Chega ao fim em cerca de 0,9 s com 11 `scrollToEnd` (`followEnd` por `csc` e `newest`, mais o timer de 50 ms), um por lote renderizado. | Não pulou. Chega ao fim em cerca de 0,6 s com 8 `scrollToEnd`, mesmo padrão. |
| S2, 20 não lidas | Não pulou. "Mensagens novas" no topo aos 1 s e aos 6 s. Nenhum `scrollToEnd` depois do pouso. | Não pulou. Igual. |
| S3, 40 não lidas | Não pulou. A abertura carrega uma página antiga (plano `older`), `scrollToIndex` falha e cai no `scrollToOffset` estimado, e pousa em "Mensagens novas" em cerca de 1,2 s. | Não pulou. Mesmo caminho, pouso em cerca de 1,1 s. |
| S4, leitura lenta (`delay=150`) | Não pulou. | Não pulou. |
| S5, toque no campo logo depois do pouso | Não pulou. `kbShow` com `atBottom=false, away=true`: nenhuma rolagem; a lista encolhe e mantém o topo. | Não pulou. Igual. |
| S6, mensagem nova durante a leitura das não lidas | Não pulou, parado no pouso e depois de rolar para baixo lendo. O conteúdo cresce (`csc` ramo `none-away`) ou nem cresce (linha fora da janela); só o contador do botão muda. | Não pulou, nos dois casos. |
| S7, carregar página antiga (rolar ao topo) | Não pulou. | Pulou para cima: com a leitura no topo, a página antiga entra e a vista vai para a primeira linha nova ("antiga 1") em vez de ficar na linha que estava no topo. Sem nenhuma rolagem do app (ver B5). |
| S8, rolar para cima, esperar 5 s, tocar no campo | Não pulou. `kbShow` com `away=true` não rola. | Não pulou. Igual. |

Uma tentativa extra para B2, rolando ao topo enquanto a mensagem nova chegava (cenário S6 com S7), também não pulou para o fim nas duas telas.

## Antes da correção (main)

Mesmo emulador e mesma edição da Vitrine (`mark` 20), com `Mensagem.js` e `Grupo.js` da `main` (sem T-B1). O toque no campo saiu assim que o pouso apareceu no registro; as posições foram lidas cerca de 2 s depois de o teclado abrir.

| Cenário | Conversa privada | Grupo |
|---|---|---|
| S5 | Pulou em 1 de 7. Nessa, nenhum quadro do pouso desligou `atBottom` antes do teclado: `kbShow` com `atBottom=true, away=true` e dois `scrollToEnd` (timers de 50 ms e 300 ms); "Mensagens novas" saiu da tela e as últimas mensagens apareceram. Nas outras 6, `atBottom=false` antes do teclado e nenhuma rolagem. | Não pulou em 7: `atBottom=false` antes do teclado em todas. |
| S8 | Não pulou. | Não pulou. |

O pulo que T-B1 corrige acontece na `main`, mas só às vezes: quando o teclado abre antes de um quadro do pouso desligar `atBottom`.

## Veredito

Conversa privada (`Mensagem.js`): não reproduzido. Nenhum salto para o fim em S1 a S8 com T-B1 aplicado.

Grupo (`Grupo.js`): salto para o fim não reproduzido. Confirmado só B5 para cima, em S7.

Por mecanismo:

- B2 (fim falso por quadro preso à altura medida): a condição apareceu, o salto não. No grupo, em S7, logo depois de uma página antiga entrar (de 24 para 48 linhas): quadro `y=1472, altura 2120, lista 648`, `bottom=true`, linha mais nova fora da vista, e `away` volta a `false`. Cerca de 400 ms depois, o quadro seguinte (`y=0`) devolve `away=true`. Nesse intervalo `pinned` ficou `false` e nenhuma linha nova chegou, então nenhum `followEnd` rolou. O salto exigiria uma linha nova (que rearma o `pinned`) dentro dessa janela.
- B3 (abertura com tudo lido anda até o fim lote a lote): confirmado como sequência, sem efeito visível depois do pouso. Conversa privada: quadros em `y=6, 423, 1351, 2208` entre os `scrollToEnd` de cada lote, tudo antes de 1 s. Grupo: o mesmo, em cerca de 0,6 s. Na captura de 1 s as duas já estão no fim.
- B4 (grupo segue o fim com o plano ainda nulo): só o primeiro lote (conteúdo de 212 px, menor que a lista) recebe um `scrollToEnd` antes do plano, e a conversa privada faz o mesmo. Sem efeito visível, inclusive com `delay=150`.
- B5 (ancoragem nativa): confirmado no grupo, em S7, sem rolagem do app. `maintainVisibleContentPosition` (`keepVisiblePosition={placed}`) usa `autoscrollToTopThreshold: 24` (`apps/app/src/ui/RefreshableList.js`). Sequência: quadro `y=0` com 48 linhas, a página antiga entra, a ancoragem mantém a linha (`y=2013`, altura 4283), e como o `y` anterior era até 24 px o `MaintainVisibleScrollPositionHelper` do Android chama `reactSmoothScrollTo(0)`, e o quadro seguinte é `y=0`. A pessoa sai de "antiga 19" e passa a ver "antiga 1". É um salto para cima, não para o fim.

## Limites

- A Vitrine não carrega fotos ("Mídia indisponível"), então não foi exercitado o crescimento de altura de uma linha com mídia depois do pouso, que passa por `onContentSizeChange`. Também não houve rede real, releitura por `dm.seen` com atraso real, nem a chegada de várias mensagens seguidas.
- T-B1 estava aplicado em todas as execuções. Ele cobre o caminho do teclado: antes dele, o pouso nas não lidas deixava `atBottom` ligado, e tocar no campo logo depois rolava até o fim pelos dois timers de `keyboardDidShow`; um arrasto ou uma troca de conversa logo depois de abrir o teclado também não cancelava esses timers. Longe do fim por rolagem da pessoa, `atBottom` já ficava desligado e o teclado não rolava. Em S5 e S8 o registro mostra `kbShow` com `away=true` e nenhuma rolagem.
- Só no emulador Android, sem aparelho físico e sem iOS.

## Correção

Este PR leva só a correção do teclado (T-B1), em `Mensagem.js` e `Grupo.js`: o `keyboardDidShow` não rola com `away` ligado (pouso nas não lidas ou leitura longe do fim), os dois timers ficam num ref, `userScroll` e a troca de conversa os cancelam, e o timer confere `away` de novo ao disparar. Não confere `atBottom` ao disparar, porque os quadros da primeira rolagem animada o desligam no meio do caminho e o timer de 300 ms existe para terminar uma rolagem que parou antes.

Testes em `apps/app/test/chatGestures.test.js`, quatro por tela, com `setTimeout` e `Keyboard` falsos:

| Teste | Sem a correção (`origin/main`) | Com a correção |
|---|---|---|
| arrastar a lista depois do teclado cancela as rolagens | falha | passa |
| pouso nas não lidas antes de qualquer quadro: o teclado não rola | falha | passa |
| `atBottom` desligado entre os timers: as duas rolagens acontecem | passa | passa |
| troca de conversa antes dos timers: nenhuma rolagem | falha | passa |

`apps/app/test/chatActions.test.js` fixa a nova linha dos timers.

## Pendências

- Salto para o fim fora do teclado não reproduzido na Vitrine. O mais provável, se T-B1 não bastar, é o que a Vitrine não exercita: linhas com mídia crescendo depois do pouso, rede real e várias mensagens seguidas.
- B2 fica registrado: a condição (fim falso com a linha mais nova fora da vista) aparece, mas o salto exige uma mensagem nova numa janela de cerca de 400 ms. Corrigir pede um `endInView` com a altura da linha mais nova, fora deste PR.
- B5 (grupo, S7) fica registrado: a página antiga leva a leitura ao topo por causa do `autoscrollToTopThreshold: 24` da ancoragem nativa. Mexer na ancoragem ficou fora do escopo deste PR.
