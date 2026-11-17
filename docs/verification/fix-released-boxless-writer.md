# Escritor sem caixa liberado guardado como toco (branch fix/released-boxless-writer)

Parte da #350, sobre `feat/writer-slot-sparse` (PR #732) a partir de `d7a7b383`, com a `main` juntada depois. Fecha o ponto (f) de `docs/verification/feat-writer-slot-sparse.md` e um ponto da revisão do PR #732 sobre o semeador. Sem mudança de RPC nem de Termos.

## O que mudou

O caso: um aparelho que entrou num grupo privado antes de ter a raiz escreveu um escritor sem caixa (W0), que a entrada seguinte troca por um com caixa e corta em 0. A caminhada libera W0; a dobra o rejeita sem esperar quando o tem, mas o espera enquanto não o tem. As duas sincronizações recusavam W0 com `header-invalid` antes de guardá-lo, então um leitor que nunca o teve ficava com a dobra `incomplete` para sempre.

Nó core (`packages/core/lib/sync.js`, commit `14eeaecf`):

- Portão: um escritor cuja caixa não bate com a visibilidade da raiz passa como toco quando o nó tem o diário que o liga (o próprio, um seguido, um diário de ligação que não falhou, ou uma réplica guardada no armazenamento principal, `bindingHeldHere`) e a caminhada desse diário, como o nó o tem, dá corte 0 ao escritor (`heldRelease`, com o `diaryWriterCut` da dobra). Senão recusa com `header-invalid`, como antes, sem cobrar do semeador. O resto do portão (certificado, bloco de entrada, cota, limite por diário) vale igual para o toco.
- Toco: baixa só `[0, 1)`, a meta de conclusão quer só o bloco 0 e a checagem de caixa feita quando a visibilidade da raiz chega (`recheckGroupBoxes`) o pula. Os núcleos já guardados passam pelo mesmo portão (que lê o bloco 0 guardado), então a revalidação da partida segue a mesma regra.
- Recusa lembrada: `boxRefused` (memória limitada, que expira como as outras da regra (3) de "Bad hints") guarda o diário que o bloco 0 nomeia. Só a recusa pela caixa entra ali: o portão marca esse caso com `boxless: true`, e `box: true` continua querendo dizer só "não cobrado do semeador" (a recusa pelo `member` também tem `box`, mas não `boxless`, e fica recusada na rodada). A chegada ou o crescimento desse diário (seguido ou diário de ligação) chama `liftBoxRefused`, que lê a caminhada uma vez por diário (`boxLifts`; uma chamada no meio da leitura só pede mais uma volta), tira a recusa da rodada (`refused`, `failedWriters`) e testa de novo a listagem (`rescanGroup`). Toda recusa pela caixa também chama `liftBoxRefused` uma vez, logo depois de anotada: o diário pode ter crescido entre a leitura da caminhada no portão e a anotação, e esse crescimento não achou nada para levantar. `liftBoxRefused` não testa de novo quando o diário está bloqueado, bifurcado ou divergente (`localVerdict`), casos em que o portão recusaria de novo. Enquanto essa leitura roda, a meta espera `<diário>:liberação`.

Nó do navegador (`packages/web-member/lib/sync.js`, commit `a04ded99`):

- Mesmo portão; "o nó tem o diário" é `openBinding(d)` (o próprio diário, um seguido ou um diário de ligação aberto). A recusa fica na entrada falha (`boxRefused: true`, `refuseBox`); `liftBoxRefused` apaga essa entrada e anota de novo o item da listagem, que volta ao portão. Gatilhos: crescimento de um seguido, de um diário de ligação e do próprio diário, e, como no nó core, uma leitura depois de cada recusa pela caixa (quando a entrada fica falha, logo ou depois de apagada). A recusa pelo `member` sai de `groupVerdict` direto para `failGroupEntry`, sem `boxRefused`, então nunca é levantada (conferido no código).
- Toco: `[0, 1)`, meta 1, `recheckGroupBoxes` pula. Na partida, um escritor guardado cuja caixa não bate fica como toco quando o diário guardado o libera e é apagado (`header-invalid`) senão, como antes; essa decisão roda antes da regra que deixa em repouso a raiz de um grupo de que o aparelho não é membro.
- A checagem tardia da caixa (visibilidade da raiz aprendida durante o portão) passou para antes de replicar o núcleo. No hypercore 10, um núcleo fechado logo depois de `replicate()` pode terminar de abrir o canal depois de `Replicator.destroy`, que só fecha os canais dos pares já conhecidos; o canal fica aberto no protomux do enlace, e todo núcleo seguinte da mesma chave nesse enlace fica sem par (`onnochannel`), sem resposta a nenhum pedido. Com a ordem antiga, o teste 2 do navegador esgotava o tempo esperando o bloco 0 de W0 em parte das rodadas (cerca de 3 de cada 4 na investigação, 2 de 6 na prova de regressão).

Semeador (`packages/core/lib/seeder.js`, commit `cffdeb56`, ponto da revisão do PR #732): um `group-join` que era um buraco apagado quando a varredura passou e chega depois refaz a caminhada, e um corte que a varredura ignorou (num escritor que ainda não contava) passa a valer. Antes só um corte tardio levantava a recusa por cota, e o escritor ficava recusado até outro corte menor ou um reinício. Agora os dois tipos de registro passam por `foldGroupWalk` (no lugar de `foldGroupCut`), que refaz a caminhada e testa de novo a entrada recusada quando o corte que ela dá ao escritor baixa. Só o corte do escritor do registro é comparado; um comentário diz por que basta: uma entrada recusada contava quando foi testada, então seu escritor tinha vaga na entrada, e um registro sobre outro escritor só muda a vaga que sobra ali (o escritor recusado fica com a vaga ou passa a não contar, e nunca é esperado), enquanto as marcas dele valem com ou sem espaço de congelados e de liberados.

Protocolo (`docs/protocol.md`): a exceção no cabeçalho do escritor e na "Slot walk", a regra (1) de "Bad hints and bounds on memory" (o I1 do código) e a exceção do navegador para `header-invalid`, o novo item "Released writers whose box does not match" em "Member sync" (portão, toco, levantamento com `<diary>:liberação`, só a recusa pela caixa lembrada e levantada, a leitura depois de cada recusa e a regra conservadora) e o toco nas metas de conclusão.

## Como verificar

Cada arquivo sozinho, a partir da raiz, com `VARANDA_TEST_CONCURRENCY=1 node <arquivo>`, e `npm run lint`:

| Arquivo | Testes | Asserções |
|---|---|---|
| `packages/core/test/sync-private.test.js` (testes 5 e 6 novos, DHT local) | 6/6 | 26/26 |
| `packages/web-member/test/sync-groups-3.test.js` (testes 2 e 3 novos, DHT local) | 3/3 | 43/43 |
| `packages/core/test/seeder-delete.test.js` (teste 33 novo) | 37/37 | 293/293 |
| `packages/core/test/sync-groups-sparse.test.js` | 2/2 | 20/20 |
| `packages/web-member/test/sync-groups-sparse.test.js` | 3/3 | 27/27 |
| `packages/core/test/sync-groups-2.test.js` | 27/27 | 96/96 |
| `packages/web-member/test/sync-groups-2.test.js` | 29/29 | 139/139 |
| `packages/web-member/test/sync-private.test.js` | 4/4 | 16/16 |
| `packages/core/test/group-private.test.js` | 129/129 | 904/904 |
| `packages/web-member/test/private-ops.test.js` | 24/24 | 231/231 |
| `packages/web-member/test/device-upkeep-ops.test.js` | 31/31 | 214/214 |
| `packages/core/test/community-fold.test.js` | 121/121 | 1111/1111 |
| `packages/core/test/seeder-groups-cuts.test.js` | 20/20 | 361/361 |

`npm run lint` (standard) passa. A suíte inteira e a demo não rodaram aqui.

Rodada de revisão (recusa pelo `member` fora de `boxRefused`, leitura depois de cada recusa pela caixa, comentário do semeador), depois do merge da `main`, cada arquivo tocado sozinho:

| Arquivo | Testes | Asserções |
|---|---|---|
| `packages/core/test/sync-private.test.js` (teste 7 novo) | 7/7 | 29/29 |
| `packages/web-member/test/sync-groups-3.test.js` | 3/3 | 43/43 |
| `packages/web-member/test/sync-private.test.js` | 4/4 | 16/16 |
| `packages/core/test/seeder-delete.test.js` | 37/37 | 293/293 |

`npm run lint` passa.

Testes novos:

- Nó core, `packages/core/test/sync-private.test.js`:
  - 5, "a fresh reader holding the diary that released a boxless writer keeps its block 0 alone and folds complete (#350)": um leitor novo R, que já guarda o diário de B (com o CW e W1), sincroniza um grupo privado em que B trocou W0 por W1. W0 não é recusado, R guarda só o bloco 0 dele, nenhuma meta sobre W0 fica aberta e a dobra fica completa.
  - 6, "a boxless writer refused before its diary is held is gated again as a stub once the diary releases it (#350)": R ainda não tem o diário de B, então W0 é recusado; quando o diário chega, W0 é guardado só com o bloco 0, contado como guardado, e a dobra fica completa.
  - 7, "a writer refused for its member is not gated again when its diary releases it (#350)": o cenário do 6, com o cabeçalho de W0 sem `member`. O diário de B chega e libera W0, e W0 é recusado uma vez só na execução (um `group-skipped`, então um portão e uma busca do bloco 0) e nunca é guardado. Uma execução `--once` não expira suas memórias, então o limite é exato, sem folga.
- Nó do navegador, `packages/web-member/test/sync-groups-3.test.js`:
  - 2, "a fresh reader holds a released boxless writer as a stub, block 0 alone, and folds complete (#350)": a execução `once` de R termina ok, R guarda só o bloco 0 de W0 e a dobra de G fica completa.
  - 3, "a boxless writer refused before its diary is held is gated again as a stub once the diary is (#350)": a listagem esconde W1 e o CW, então R não tem o diário de B e W0 é recusado com `header-invalid`. Quando a listagem os mostra, R aceita W1, abre o diário de B, W0 é guardado só com o bloco 0, R tem a comunidade de G e a execução assenta; a dobra fica completa. Uma segunda execução `once` termina ok, sem recusar W0, ainda com o bloco 0 só e a dobra completa.
- Semeador, `packages/core/test/seeder-delete.test.js`, 33, "a deleted join that arrives after the scan tries again the join whose cut it brings back (#350)".

O arquivo inteiro do navegador (`sync-groups-3`) rodou quatro vezes seguidas depois da correção da ordem: 3/3 testes e 43/43 asserções em todas.

## Prova de regressão

Cada correção foi tirada e o arquivo rodado de novo (`VARANDA_TEST_CONCURRENCY=1`). O brittle para no primeiro erro lançado, então nos casos de "tempo esgotado" o resto do arquivo não roda.

Semeador (`packages/core/test/seeder-delete.test.js`, sem a mudança: 37/37, 293/293):

| Mutação | Resultado |
|---|---|
| S1: `_pageArrived` dobra um `group-join` tardio com `foldGroupRecord` (só um corte tardio levanta a recusa, o código do PR #732) | 36/37, 292/293; o teste 33 falha em "and the writer is tried again" |

Nó core (`packages/core/test/sync-private.test.js`, sem a mudança: 6/6, 26/26):

| Mutação | Resultado |
|---|---|
| C1: o portão recusa toda caixa que não bate (sem toco, o código anterior) | 4/6, 20/26; o 5 falha em "W0 is not refused", "R holds W0's block 0 alone" e "and the fold is complete"; o 6 em "W0 is refused while B's diary is not held", "then W0 is held, block 0 alone" e "and the fold is complete" |
| C2: `liftBoxRefused` nunca levanta | 5/6, 24/26; o 6 falha em "then W0 is held, block 0 alone" e "and the fold is complete" |
| C3: o toco baixa inteiro | 4/6, 24/26; falham "R holds W0's block 0 alone" (5) e "then W0 is held, block 0 alone" (6) |
| C4: a meta quer o comprimento inteiro do toco | 4/6, 24/26; falham "and counts it held: no goal on W0 is left open" (5) e "and counted held" (6) |

No C1, "W0 is refused while B's diary is not held" falha porque a asserção espera uma recusa só: com o portão antigo e o resto da correção no lugar, cada recusa pede uma leitura do diário, a leitura acha a liberação e testa W0 de novo, e o portão o recusa outra vez (316 `header-invalid` nessa rodada).

C1 a C4 rodaram antes da rodada de revisão, com 6 testes no arquivo. Na rodada de revisão (sem a mudança: 7/7, 29/29):

| Mutação | Resultado |
|---|---|
| M1: a recusa pelo `member` também marca `boxless` (o caso achado na revisão: era a flag `box` que decidia) | 6/7, 28/29; o 7 falha em "W0 is refused once: one gate, one fetch of its block 0", com 395 `header-invalid` para W0 numa execução de 15 s |

A leitura depois de cada recusa pela caixa (o crescimento do diário entre a leitura da caminhada no portão e a anotação da recusa) não tem teste: provocar o crescimento exatamente nessa janela exigiria um gancho de teste novo no portão. Pela leitura do código: antes, o crescimento nessa janela não achava a recusa ainda anotada, e a recusa de um portão que tinha lido a caminhada não pedia nova leitura, então o escritor ficava recusado até o diário crescer de novo ou a memória expirar; agora a leitura depois da anotação vê esse crescimento. Ela não entra em laço: só testa de novo um escritor que a caminhada libera, com o diário num estado que o portão lê, e aí o portão o aceita como toco.

Nó do navegador (`packages/web-member/test/sync-groups-3.test.js`, sem a mudança: 3/3, 43/43):

| Mutação | Resultado |
|---|---|
| W1: o portão recusa toda caixa que não bate, sem lembrar (o código anterior) | o 2 falha em "R holds W0's block 0 alone" e "R's fold of G is complete"; o 3 esgota o tempo em "W0 held as a stub, the run settled" |
| W2: `liftBoxRefused` nunca levanta | igual ao W1: o diário de B só abre em R depois que W1 é aceito, então também no teste 2 o primeiro portão de W0 pode vir antes do diário |
| W3: o toco baixa inteiro | 3/3, 43/43: sobrevive (abaixo) |
| W4: a meta quer o comprimento inteiro do toco | o 2 falha em "R's run ends ok" (`tempo esgotado: <W0>:1/2`); o 3 esgota o tempo em "W0 held as a stub, the run settled" |
| W5: a revalidação da partida apaga todo escritor de caixa errada | o fixture esgota o tempo em "the seeder holds W0 as a stub": a partida de B apaga o W0 que ele mesmo escreveu, e o semeador nunca recebe o toco |
| W5b: a partida mantém o toco só do próprio diário (apaga o de outro diário) | 2/3, 41/43; o 3 falha em "still block 0 alone" (R não tem mais W0) e "and the fold still complete", na segunda execução de R |
| W6: a checagem tardia da caixa depois de replicar (a ordem antiga) | intermitente: 2 de 6 rodadas falham, as duas no teste 2, em "R's run ends ok" (`tempo esgotado: <W0>:0/1`), "R holds W0's block 0 alone" e "R's fold of G is complete"; 4 de 6 passam |

W3 sobrevive no navegador porque o único par do leitor é o semeador, que guarda W0 como toco (o bloco 1 foi limpo): baixar o escritor inteiro só traz o bloco 0. O nó core prova a mesma regra no C3, com um semeador falso que tem W0 inteiro.

W6 é uma corrida: a falha depende de o canal do núcleo recusado terminar de abrir depois de ele ser fechado. Na investigação, com a ordem antiga, o teste 2 esgotou o tempo em cerca de 3 de cada 4 rodadas; depois da correção, o arquivo inteiro passou nas 4 rodadas seguidas e o teste 2 passou nas 6 rodadas em que rodou sozinho durante a investigação.

## Decisões tomadas aqui

- Regra conservadora (pedida na rodada): enquanto o nó não tem a liberação, o escritor é recusado e esperado exatamente como antes. Isso cobre o diário que o nó não tem, um diário bloqueado, bifurcado ou divergente, e o registro de corte que ainda não chegou. Um corte apagado continua valendo desde a #717, então na prática só o leitor que ainda não tem o registro de corte está nesse caso. Um toco guardado cujo diário deixa de liberá-lo (registros posteriores nunca baixam uma liberação, então na prática é um diário que o nó deixou de ter) é recusado no próximo portão ou na próxima partida, como qualquer escritor de caixa errada.
- Toda recusa pela caixa é seguida de uma leitura da caminhada (o `walked` da primeira versão, que pulava essa leitura quando o portão já tinha lido a caminhada, saiu na revisão: perdia um crescimento no meio). Custa uma leitura do diário por recusa, e uma chave recusada não volta ao portão na rodada, salvo quando a caminhada a libera. Não há laço: a leitura só testa de novo um escritor que a caminhada libera, e o portão então o aceita.
- Só a recusa pela caixa é lembrada e levantada (`boxless`), separada de `box` (não cobrar do semeador), que a recusa pelo `member` também usa.
- O próprio diário do nó core não tem gatilho: só esse nó escreve nele, e o portão sempre lê a liberação dele.
- No navegador, "tem o diário" é `openBinding(d)`. Um diário de ligação só abre depois de um escritor dele aceito (`ensureGroupDiary`), então um leitor que não segue B passa a ter o diário quando aceita W1, o escritor atual de B, e é esse crescimento que levanta a recusa (teste 3).
- A revalidação da partida do nó core é o próprio portão (os núcleos guardados passam por ele com o bloco 0 guardado); o navegador decide ao ler o armazenamento, com o diário guardado.
- O vazamento do canal no hypercore 10 foi contornado mudando a ordem no `sync.js` do navegador (checar antes de replicar), sem tocar na dependência.
- O teste 3 do navegador assenta dentro da execução contínua: uma raiz guardada de um grupo de que o aparelho não é membro fica em repouso nas execuções seguintes (comportamento que já existia), então a comunidade de G só chega na mesma execução. A segunda execução `once` prova que a revalidação da partida mantém o toco e não recusa W0.
- No navegador o toco emite `group-writer` como qualquer escritor aceito.

## Riscos residuais e pontos em aberto

- Cada levantamento lê o diário inteiro uma vez (`readAll`), agrupado por diário; um diário grande que cresce muitas vezes enquanto uma recusa espera custa uma leitura por volta.
- Se nada fizer o leitor ter o diário que liga o escritor (nenhum seguido, nenhum outro escritor desse diário aceito), o escritor fica recusado e a dobra `incomplete`, como antes desta mudança.
- No navegador, uma visibilidade da raiz aprendida depois de o núcleo de um escritor já estar replicado (`recheckGroupBoxes`, que apaga) ainda pode deixar o canal aberto no hypercore 10, e o novo portão do toco espera outro enlace. É mais raro que o caso corrigido: a sonda da raiz teria de demorar mais que o portão inteiro do escritor.
- O semeador só tem o toco se o aparelho que trocou o escritor o servir; a regra do semeador é a do PR #732, sem mudança aqui.
- Um escritor recusado pelo `member` que o diário liberou continua esperado pela dobra: no teste 7 a dobra de R fica `incomplete` (conferido uma vez com um registro temporário, depois tirado). É o comportamento de antes desta branch; mudar isso é decisão de produto, fora deste PR.
- `liftBoxRefused` percorre `boxRefused` inteira a cada crescimento de um diário com recusa (memória limitada a `gateLimit`). Um índice diário para chaves não entrou: a memória expira e despeja entradas sem aviso, e manter o índice em dia daria mais código que o ganho.
- O caminho de troca de caixa (o aparelho que escreve W1) não mudou no nó core.
- O `[0, 1)` do toco não é observável nos testes do navegador (W3 sobrevive): o leitor só fala com o semeador, que guarda W0 como toco. A regra é a mesma do nó core, coberta pelo C3.
- W6 (a ordem antiga da checagem tardia no navegador) só falha em parte das rodadas, por ser uma corrida; a prova de regressão dessa parte é estatística.
