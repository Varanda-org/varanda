# Escritores cortados guardados e lidos esparsos (branch feat/writer-slot-sparse)

Parte da #350, item 8a, passo 8a-3, sobre `feat/writer-slot-walk`. Decisão do dono (não reaberta aqui): o semeador guarda, dentro da cota normal, as saídas e os blocos de chave de um escritor cortado e um toco de cada escritor liberado.

## O que mudou

Dobra (`packages/core/lib/group.js`):

- `bindCores`: um escritor conta até o primeiro seq que nenhuma cópia tem e, depois desse buraco, só as saídas (`group-leave`) e os blocos de chave (`group-key`), e só quando o buraco está no corte ou depois dele (`max(corte, 1)`). Uma cópia esparsa de um escritor cortado dobra como a inteira; uma cópia parcial, cortada ou não, dobra como o prefixo de sempre.
- Cada cópia traz `signed` (o comprimento que o escritor assinou). Um bloco de chave cujo `auth` cita um escritor de comunidade (CW) cortado vale quando `auth.seq` não passa desse comprimento (`heldSeq = max(lastSeq, held, signed - 1)`), então um CW aparado no corte lê o histórico que a cópia inteira lê.

Leitores:

- Nó core: `readHeldBlocks` em `packages/core/lib/store.js` (o prefixo contíguo e, depois do primeiro buraco, só as saídas e os blocos de chave guardados, até `MAX_LOG_BLOCKS`); `readCoreParts` em `member.js` lê os escritores assim e passa `signed: core.length`. As raízes continuam lidas como prefixo.
- Nó do navegador: `readHeldBlocks` em `packages/web-member/lib/node-store.js`; em `member-ops.js`, `writerCoreState` para os escritores, o carimbo da memória da dobra (`groupStamp = replicaStamp`) nomeia as faixas de blocos guardados depois do comprimento contíguo (terceira rodada; antes, cada bloco), `signed` em `foldGroup` e `foldCommunity`, e `foldCommunity` passa a receber as marcas de corte dos diários.
- Serviço de contas: `apps/cli/lib/account/pages-groups.js` lê os escritores listados com `readHeldBlocks` e passa `signed`.

Semeador (`packages/core/lib/seeder.js`):

- Escritor cortado (`groupWalkCut` sobre a caminhada): o download para no corte; os blocos depois dele, até `MAX_LOG_BLOCKS`, são buscados de 256 em 256 (`CUT_CHUNK`), lidos só pelo tipo e limpos, menos saídas e blocos de chave (`_cutGroupCore`). O Hypercore guarda os nós da árvore que as provas dos blocos mantidos pedem.
- Liberado (corte 0): toco com o bloco 0, as saídas e os blocos de chave.
- A ligação em `admitted.json` guarda `cut`, `clearedFrom` e `clearedTo`, gravada antes de limpar cada pedaço; o próximo serviço relê essa faixa e limpa o que sobrou de uma queda no meio.
- Cota: na admissão e na partida, só os blocos abaixo do corte; com o núcleo inteiro acima da cota, os blocos abaixo do corte mais os mantidos depois dele, e os bytes deles. Passou: sai com `quota` e a entrada fica recusada, como na admissão (senão cada varredura buscaria de novo).
- Corte menor aplica na hora (também com o núcleo ainda abrindo); maior ou nenhum, só depois que a varredura alcançou o diário, e então o que a limpeza tirou é buscado de novo. Um corte restaurado na partida não limpa nada novo antes de a varredura confirmá-lo.
- Uma entrada recusada antes (`quota`, `header-invalid`) é tentada de novo uma vez a cada corte menor.
- Escritor sem caixa num grupo privado: `header-invalid` enquanto contado, toco depois de liberado (`groupVerdict(..., released)`, na admissão, na partida, no portão e na reverificação de caixa). Se a liberação some, é julgado de novo e sai.

Metas de conclusão com cópia esparsa (segunda rodada, pontos (a) e (b)):

- `packages/core/lib/sparse-held.js` (novo, roda no Node, no Bare e no navegador): `advertisedHeld(core, end)` é verdadeiro quando algum par conectado já sincronizou, todo par sincronizado já respondeu pelos blocos abaixo de `end` e todo bloco abaixo de `end` que um deles anuncia está guardado. Depois do comprimento contíguo de um par, o bitfield dele só chega como resposta ao pedido de um intervalo de download, então o par conta como respondido quando chegou a primeira página de cada segmento do bitfield que o intervalo toca (terceira rodada; antes, toda página até o fim).
- `diaryWriterCut(entries, G, W)` em `group.js`: o corte que a caminhada do diário dá ao escritor (0 quando liberado, `null` sem corte), igual ao `groupWalkCut` do semeador.
- Nó core (`sync.js`): na meta de `--once`, um escritor alheio guardado até o anunciado e com buraco depois conta como completo quando `advertisedHeld` vale até `min(comprimento assinado, MAX_LOG_BLOCKS)` (`sparseMet`, conferido de novo a cada `SPARSE_CHECK_MS` = 100 ms enquanto a meta espera). O próprio escritor cortado pelo diário conta como enviado quando o semeador o guarda até `max(corte, 1)`, nunca além do comprimento local, e (terceira rodada) já tem as saídas e os blocos de chave dele depois do corte; os cortes são lidos do diário quando a sincronização abre os escritores.
- Nó do navegador (`web-member/lib/sync.js`): as mesmas duas regras (`sparseMet` em `unmetGroupGoals`; `pushTarget` em `checkMedia`), com os cortes relidos a cada varredura do diário (`fold.cutEntries`, `ownCutEntries`), e `checkMedia` roda de novo depois de cada varredura.
- Serviço de contas (`pages-groups.js`): o `fetch` de um escritor listado termina, antes de `FETCH_TIMEOUT_MS`, quando todo bloco que o semeador anuncia abaixo do comprimento assinado está guardado (conferido a cada 50 ms), e então a cópia conta como completa. Raízes e diários continuam com a regra do contíguo.

Documentos: `docs/protocol.md` (bit `CAP_WRITER_CUTS`, entrada de `buildGroup` e `buildCommunity` com `signed`, "Slot walk" e "Writers named by a node" sobre o sem caixa, regra do `auth.seq` em "Diary cuts on own writers" e em "Community distributors", parágrafo novo "Sparse copies", "Cut writers" do semeador reescrito; na segunda rodada, "Completion goals" com a cópia esparsa, o próprio escritor cortado e o `fetch` do serviço de contas). Na terceira rodada, "Cut writers" com o fim do pedaço pelo anunciado e a faixa incerta, "Completion goals" com a regra do segmento, as saídas próprias depois do corte e a espera do navegador, e "Sparse copies" com o carimbo por faixas. `docs/rpc.md` não muda: nenhum método nem resultado mudou.

Terceira rodada (revisão em `d487e5e7`, sem P1):

- Semeador, pedaço depois do corte lido de pares esparsos (P2-1, `_groupPastRange` e `_cutGroupCore` em `seeder.js`): um pedaço termina quando todo bloco que os pares sincronizados anunciam ali está guardado (`advertisedHeld`), não só quando os 256 blocos chegaram. O que ele guarda ali é mantido (e contado na cota) ou limpo como antes, e o pedaço entra na faixa incerta da ligação (`unsureFrom`, `unsureTo`, dentro da faixa já lida), relida pedaço a pedaço em intervalos que dobram de 1 s a 5 minutos (e, desde a quarta rodada, na hora só quando um par que entra anuncia ali um bloco que falta); um pedaço relido inteiro sai dela. Antes, um semeador que só recebia o escritor de pares esparsos (outro semeador, ou depois de uma saída por `quota` que um corte menor levantou) nunca passava do primeiro pedaço, e uma saída em corte + 256 ou depois nunca era buscada.
- Dono de um escritor cortado (P2-2): o nó core (`ownKeptMissing` em `sync.js`) e o navegador (`seederHoldsKept` em `checkMedia`) só dão o escritor por enviado quando, além de o semeador guardá-lo até `max(corte, 1)`, o par de replicação do semeador anuncia cada `group-leave` e `group-key` próprio do corte em diante, ou recebeu esse bloco nesta conexão (evento `upload`: um par nunca anuncia um bloco que recebe a quem já o tem). `askHeld` (`sparse-held.js`) pede a esse par o bitfield ali, porque uma cópia inteira não manda pedidos próprios. Enquanto falta, o nó core responde `<W>:corte <seq>` e o navegador `<W>:push <comprimento>`, sem `group-pushed`.
- `peerAnswered` (P3-3): um pedido pede um segmento inteiro do bitfield (2097152 blocos), e a resposta traz a primeira página do segmento e as páginas seguintes que o par tem. O par conta como respondido quando chegou a primeira página de cada segmento do intervalo; antes era preciso toda página de 32768 bits até o fim, e um par esparso num escritor longo nunca respondia.
- `readHeldBlocks` (P3-6, `store.js` e `node-store.js`): depois do buraco, pula para o próximo bloco guardado pelo bitfield que o próprio `has()` lê (`firstSet`, presente no Hypercore 10 e no 11, conferido em `node_modules`), em vez de um `has()` por seq. Sessão que não seja a padrão (snapshot, batch) continua com o `has()` por bloco.
- Carimbo da memória da dobra (P3-5, `replicaStamp` em `member-ops.js`): nomeia as faixas de blocos guardados depois do prefixo (`heldRuns` em `sparse-held.js`), nulo só com mais de 4096 faixas. Antes ficava nulo com mais de 4096 blocos entre o contíguo e o comprimento, e um grupo com um toco longo ou um escritor cortado cedo perdia a memória de vez.
- `sparseMet` do navegador (P3-4): a espera entre conferências dobra até 5 s (`SPARSE_CHECK_MAX_MS`) enquanto a faixa guardada da cópia não muda; um download ou um par que entra ou sai volta a 100 ms. Antes eram 100 ms enquanto a aba ficasse aberta.
- Comentários (P3-7, `seeder.js`): `released = (cut === 0)` cobre também o escritor ainda contado cortado em 0 depois de gastas as 16 liberações; os dois ficam como toco.

Quarta rodada (revisão de `d487e5e7..9b2137f8`, sem P1 nem P2):

- `_groupPastRange` (P3-b): o laço confere `entry.dropped || this._closing` depois de cada `await` e sai com `null`. Antes, uma queda durante o `await advertisedHeld` deixava o laço parado para sempre, com um ouvinte `peer-add` num núcleo fechado: o `range.destroy()` do Hypercore não rejeita o `done()`, e o `stopQuota` só acorda uma espera já armada.
- Releitura da faixa incerta quando um par entra (P3-a, `_rereadIfOffered` em `seeder.js`, `peerOffers` em `sparse-held.js`): só relê na hora quando o par que entrou, depois de sincronizar e responder ao pedido do bitfield dessa faixa (`askHeld`), anuncia ali um bloco que o semeador não tem. Conferido a cada 1 s desde a entrada, até 10 vezes. Qualquer outro par (um leitor que conecta, um par que reconecta em laço) deixa o recuo como está. Antes, cada `peer-add` voltava o recuo a 1 s e relia a faixa inteira, então o recuo de 5 minutos nunca valia para um escritor cujo aparelho sumiu.
- `peerHolds` ganhou um teste de unidade com blocos servidos (a mutação R4 da terceira rodada passava).

Quinta rodada: merge da `main` em `4e901c15` (#717, #721, #722), commit `955ae568`, com a mensagem padrão do git.

- Conflitos, resolvidos mantendo os dois lados:
  - `seeder.js`: a varredura dobra o `group-cut` pelo `foldGroupRecord` da #717, dentro de `foldGroupCut`, que guarda a regra deste PR: um corte menor tenta de novo a entrada recusada.
  - `sync.js` do nó core: os imports das duas.
  - `sync.js` do navegador:
    - os imports, o campo `deletedHoles` da #717 e as exportações das duas;
    - `fold.cutEntries` saiu: a #722 já guarda os cortes em `fold.joinEntries` (`WALK_TYPES`), e `ownCutEntries` passa a ser essas entradas.
  - `member-ops.js`: um comentário.
  - `seeder-groups-cuts.test.js`: os imports e o teste novo da #721 antes do de liberação.
  - `protocol.md`: o texto da `main` com as frases deste PR. O escritor sem caixa substituído é recusado pela sincronização, e o semeador o guarda como toco. `buildCommunity` recebe `signed?`.
- Além de escolher lados:
  - `_pageArrived` (#717): um `group-cut` apagado, buscado uma vez depois da varredura, também passa por `foldGroupCut`. Um corte menor que chega assim levanta a recusa da entrada como na varredura. Há teste novo em `seeder-delete.test.js`, cujo fixture ganhou `groupRefused`.
  - Teste de unidade da #721 "a stored binding the scan no longer lists gets its on join too": montava a entrada do diário sem `core` nem `scanned`. O `_reconcileGroups` deste PR chama `_groupCutScan`, que lê os dois, e o arquivo parava com `TypeError` no commit do merge. O fixture ganhou um diário lido até o fim e uma entrada servida.
  - Teste "a cut that is gone after a restart fetches again what clearing removed": apagava o registro de corte para o corte sumir. Com a #717 um `group-cut` apagado continua valendo, então o semeador nunca limpava o bloco e o teste esgotava o tempo em "corte apagado no semeador". Virou dois testes:
    - "a cut its diary deleted still applies at the seeder, after a restart too": o bloco e o corte ficam, também depois de reiniciar, e nada limpo é buscado de novo.
    - "a persisted cut the diary does not give is dropped once the scan caught up, and what clearing removed is fetched again": o mesmo caminho de antes (`caught && cut !== now`), agora com um corte guardado no `admitted.json` que o diário não tem e W limpo depois dele com o semeador parado.
- Interações conferidas:
  1. **Teto de 32 escritores por diário e grupo (#722) e guarda esparsa.** O leitor conta núcleos guardados pelo seq da entrada provada (`othersHolding`, `MAX_GROUP_HELD_PER_DIARY`). O semeador conta ligações por diário e grupo, com o mesmo 8 + 8 + 16. Nenhum dos dois olha os blocos, então um escritor cortado guardado esparso ocupa uma vaga como o inteiro. Quem conta, nos dois, é a caminhada do diário. A guarda esparsa só muda quais blocos ficam, e a dobra (`bindCores`) dobra a cópia esparsa como a inteira.
  2. **Cortes de substituição automáticos (#722).** `retiredWriterCut` põe o corte um depois do último seq que o aparelho tem, isto é, no comprimento do escritor; o teste 7 de `community-member-leave-5.test.js` confere isso.
     - A meta do dono vira `min(comprimento, max(corte, 1))`, que é o comprimento. No nó core `ownKeptMissing` nem é chamado, e no navegador `seederHoldsKept` devolve `true` (`cut >= length`).
     - Só quando o corte vai na marca menor que já estava no escritor sobram saídas e chaves depois dela. Elas são confirmadas como as de qualquer corte, pelo caminho que Q1, Q2, R1 e R3 seguram.
     - O escritor aposentado também deixa de ser o `writer` do grupo em `groups.json`, então nem entra na meta.
  3. **O seq da listagem (#721, `onSeq`) é um seq do diário.** Ele vem da caminhada que a varredura do diário monta. A guarda esparsa só vale para núcleos de escritor (raízes e diários seguem pelo contíguo), então não o muda. O teste novo da #721 passa com a guarda esparsa.
  4. **Busca única dos blocos apagados mantidos (#717).** Acontece nos diários (`entry.deleted`, `groupSeqs`, `fold.deletedHoles`). `keptPast`, `keptPastBytes` e a cota do que fica são dos núcleos de escritor, que não têm registros de apagar. O único encontro é um `group-cut` apagado que chega depois: ele baixa o corte pelo caminho da varredura (`_reconcileGroups`, `_groupCutScan`, `_applyGroupCut`, que tira de `keptPast` o que fica abaixo do novo `clearedFrom`), e agora também levanta a recusa.

## Como verificar

Cada arquivo sozinho, a partir da raiz, com `node <arquivo>`, e `npx standard` nos arquivos mudados:

| Arquivo | Testes | Asserções |
|---|---|---|
| `packages/core/test/seeder-groups-cuts.test.js` (testes 7 a 14 novos) | 14/14 | 327/327 |
| `packages/core/test/sync-groups-sparse.test.js` (novo, DHT local) | 1/1 | 12/12 |
| `packages/core/test/group-private.test.js` | 128/128 | 898/898 |
| `packages/core/test/group-member-6.test.js` | 10/10 | 72/72 |
| `packages/web-member/test/group-memo.test.js` | 11/11 | 60/60 |
| `packages/web-member/test/group-ops.test.js` | 57/57 | 436/436 |
| `packages/core/test/seeder-private.test.js` | 4/4 | 34/34 |
| `packages/core/test/seeder-groups.test.js` | 43/43 | 262/262 |
| `packages/core/test/seeder-groups-3.test.js` | 6/6 | 33/33 |
| `packages/core/test/seeder-groups-waits.test.js` | 12/12 | 61/61 |
| `packages/core/test/seeder-communities.test.js` | 9/9 | 59/59 |
| `apps/cli/test/pages-groups.test.js` | 3/3 | 153/153 |
| `apps/cli/test/account-pages-groups.test.js` | 1/1 | 49/49 |

Segunda rodada (depois do merge da `main` com #710, #711, #713 e #714), cada arquivo sozinho:

| Arquivo | Testes | Asserções |
|---|---|---|
| `packages/core/test/sync-groups-sparse.test.js` (asserções novas do `--once`) | 1/1 | 14/14 |
| `packages/web-member/test/sync-groups-sparse.test.js` (novo, DHT local) | 1/1 | 11/11 |
| `apps/cli/test/pages-groups-sparse.test.js` (novo, DHT local) | 1/1 | 8/8 |
| `packages/core/test/sync-groups-3.test.js` | 16/16 | 71/71 |
| `packages/core/test/sync-private.test.js` | 4/4 | 16/16 |
| `packages/core/test/group-member.test.js` | 13/13 | 151/151 |
| `packages/core/test/seeder-groups-cuts.test.js` | 14/14 | 327/327 |
| `packages/web-member/test/sync-groups-2.test.js` | 26/26 | 130/130 |
| `packages/web-member/test/private-ops.test.js` | 24/24 | 231/231 |
| `packages/web-member/test/group-memo.test.js` | 11/11 | 60/60 |
| `apps/cli/test/pages-groups.test.js` | 3/3 | 152/152 (153 na primeira rodada: a asserção sobre a Geral só existe quando a entrada na comunidade também entrou nela, `joined.group`; dá 152 também com o `fetch` novo tirado) |
| `apps/cli/test/account-pages-groups.test.js` | 1/1 | 49/49 |

`npm run lint` passa.

O teste de ponta a ponta: A cria a comunidade e dois grupos; B escreve nos dois, congela o escritor de G1 no comprimento (dois posts e a saída depois do corte) e libera o de G2 (um post e a saída). Depois que o semeador guarda os dois esparsos, R, novo, sincroniza só com ele: guarda W1 abaixo do corte mais a saída e W2 como toco, e a comunidade e os dois grupos (info, membros e leitura) dobram igual a quando R recebe as cópias inteiras de B.

Na segunda rodada ele confere também que o `sync --once` do dono (B) e o do leitor novo (R) terminam `ok` antes do prazo de 30 s. `packages/web-member/test/sync-groups-sparse.test.js` (novo, DHT local e semeador atrás de WebSocket) faz o mesmo no nó do navegador com um escritor congelado: o `--once` de B e o de R terminam `ok`, R guarda o escritor abaixo do corte mais a saída, a saída conta e o post depois do corte não. A saída ali é escrita direto no escritor, como faria um aparelho offline: `group.leave` também desliga a entrada no diário, e esse caso esbarra num problema anterior a este PR (ponto (g) abaixo). `apps/cli/test/pages-groups-sparse.test.js` (novo, arquivo próprio porque `pages-groups.test.js` já usa boa parte do tempo por arquivo do executor): com o semeador guardando esparso o escritor congelado de B, a Página entra na comunidade, entra no grupo e posta, e a leitura dela vem com `incomplete: false`, o post abaixo do corte e sem o de depois. Selar (`group-seal`, grupo privado) passa pela mesma conferência `loaded.partial` e não tem teste próprio aqui.

Terceira rodada, cada arquivo sozinho:

| Arquivo | Testes | Asserções |
|---|---|---|
| `packages/core/test/sparse-held.test.js` (novo) | 2/2 | 8/8 |
| `packages/core/test/sync-groups-sparse.test.js` (teste 2 novo) | 2/2 | 20/20 |
| `packages/core/test/seeder-groups-cuts.test.js` (teste 15 novo) | 15/15 | 336/336 |
| `packages/core/test/sync-groups-3.test.js` | 16/16 | 71/71 |
| `packages/core/test/group-member.test.js` | 13/13 | 151/151 |
| `packages/core/test/group-member-6.test.js` | 10/10 | 72/72 |
| `packages/core/test/sync-private.test.js` | 4/4 | 16/16 |
| `packages/web-member/test/sync-groups-sparse.test.js` (testes 1 e 3 novos) | 3/3 | 27/27 |
| `packages/web-member/test/sync-groups-2.test.js` | 26/26 | 130/130 |
| `packages/web-member/test/private-ops.test.js` | 24/24 | 231/231 |
| `packages/web-member/test/group-memo.test.js` (teste 2 novo) | 12/12 | 65/65 |
| `apps/cli/test/pages-groups-sparse.test.js` | 1/1 | 8/8 |
| `apps/cli/test/pages-groups.test.js` | 3/3 | 153/153 (a asserção sobre a Geral voltou a rodar, `joined.group`, como na primeira rodada) |

`npm run lint` passa.

O teste 15 de `seeder-groups-cuts.test.js` monta o caso P2-1: o primeiro semeador guarda W esparso (corte 3; cinco posts, mais 300, a saída e mais um post, então a saída fica depois de corte + 256); B sai, e um segundo semeador recebe W só do primeiro. Ele guarda a saída, conta-a na cota (`keptPast`) e lista como incerta a faixa lida só de pares esparsos (`unsureFrom` 3, `unsureTo` o comprimento); quando B volta com W inteiro, relê a faixa, limpa de novo o que não fica e tira a faixa incerta da ligação. O teste 2 de `packages/core/test/sync-groups-sparse.test.js` e o teste 3 de `packages/web-member/test/sync-groups-sparse.test.js` seguram `_groupPastRange` do semeador: com a saída só no aparelho, o `--once` do dono não termina `ok` e diz o que falta (nó core `<W>:corte <seq>`, navegador `<W>:push <comprimento>` e nenhum `group-pushed`); solto o semeador, termina `ok`. O caso do `peerAnswered` (`packages/core/test/sparse-held.test.js`, teste 1) usa um escritor de 40000 blocos e um par com `[0, 10)` mais o bloco 500, como o repro da revisão. O pulo pelo bitfield do `readHeldBlocks` tem teste só no nó core (teste 2 do mesmo arquivo); o do navegador são as mesmas quatro linhas, sem teste próprio. O teste da espera do `sparseMet` (P3-4) é de unidade, sobre `sparseCheckDelay`; o empurrão por download ou par não tem teste que falhe sem ele, e os testes esparsos do navegador passam com ele.

Quarta rodada, cada arquivo sozinho com `VARANDA_TEST_CONCURRENCY=1 node <arquivo>`:

| Arquivo | Testes | Asserções |
|---|---|---|
| `packages/core/test/seeder-groups-cuts.test.js` (teste 15 com o par que nada oferece, teste 16 novo) | 16/16 | 340/340 |
| `packages/core/test/sparse-held.test.js` (testes 3 e 4 novos) | 4/4 | 18/18 |

`npm run lint` passa.

No teste 15, antes de B voltar, o recuo do segundo semeador é empurrado para 5 minutos e A abre W vazio: o par novo não oferece nada na faixa incerta, nenhuma passada começa em 3 s e o recuo fica. B volta com W inteiro e a faixa é relida na hora, pelo anúncio de B, não pelo recuo. O teste 16 (novo, de unidade) chama `_groupPastRange` com um núcleo falso cujo `has()` derruba a entrada e leva os pares durante o `advertisedHeld`: a espera tem de terminar com `null` e sem ouvinte no núcleo. Os testes 3 e 4 de `sparse-held.test.js` (novos, de unidade) cobrem `peerHolds` com blocos servidos e `peerOffers`.

Quinta rodada, depois do merge da `main` em `4e901c15`, cada arquivo sozinho com `VARANDA_TEST_CONCURRENCY=1 node <arquivo>`. Primeiro no commit do merge (`955ae568`), depois de novo nos arquivos que os ajustes mexem:

| Arquivo | Testes | Asserções |
|---|---|---|
| `packages/core/test/sparse-held.test.js` | 4/4 | 18/18 |
| `packages/core/test/sync-groups-sparse.test.js` | 2/2 | 20/20 |
| `packages/core/test/seeder-groups-cuts.test.js` (no merge: `TypeError` no teste da #721; depois do ajuste do fixture e dos dois testes de corte apagado) | 20/20 | 361/361 |
| `packages/core/test/sync-groups-3.test.js` (rodado de novo depois do corte tardio) | 26/26 | 143/143 |
| `packages/core/test/group-member.test.js` | 15/15 | 158/158 |
| `packages/core/test/group-member-6.test.js` | 10/10 | 72/72 |
| `packages/core/test/sync-private.test.js` | 4/4 | 16/16 |
| `packages/core/test/seeder-delete.test.js` (35/35, 288/288 no merge; com o teste do corte tardio) | 36/36 | 290/290 |
| `packages/core/test/sync-groups-7.test.js` | 1/1 | 12/12 |
| `packages/core/test/writer-slot-member.test.js` | 9/9 | 61/61 |
| `packages/core/test/sync-groups-2.test.js` | 27/27 | 96/96 |
| `packages/core/test/group-rekey.test.js` | 16/16 | 118/118 |
| `packages/core/test/community-member-leave-5.test.js` | 10/10 | 86/86 |
| `packages/core/test/deletion.test.js` (rodado de novo depois do corte tardio) | 65/65 | 963/963 |
| `packages/core/test/community-fold.test.js` | 121/121 | 1111/1111 |
| `packages/web-member/test/sync-groups-sparse.test.js` | 3/3 | 27/27 |
| `packages/web-member/test/sync-groups-2.test.js` | 29/29 | 139/139 |
| `packages/web-member/test/private-ops.test.js` | 24/24 | 231/231 |
| `packages/web-member/test/group-memo.test.js` | 12/12 | 65/65 |
| `packages/web-member/test/sync-groups-3.test.js` | 1/1 | 14/14 |
| `packages/web-member/test/group-ops.test.js` | 64/64 | 487/487 |
| `packages/web-member/test/community-ops.test.js` | 77/77 | 564/564 |
| `apps/cli/test/pages-groups-sparse.test.js` | 1/1 | 8/8 |
| `apps/cli/test/pages-groups.test.js` | 4/4 | 157/157 |

`npm run lint` passa.

Não rodados aqui, por regra do brief: a suíte inteira e a demo (a sessão que abriu esta roda a CI de entrega).

## Prova de regressão

Cada correção foi tirada e o arquivo rodado de novo. O brittle para no primeiro erro lançado, então nos casos de "tempo esgotado" o resto do arquivo não roda.

Dobra (`group.js`, `packages/core/test/group-private.test.js`), com o `bindCores` de `feat/writer-slot-walk`: 126/128 testes, 894/898 asserções. Falham "the signed length keeps the history readable" e "the sparse CW folds like the whole one" (CW aparado no corte e bloco de chave que o cita), "a hole below the cut: the prefix" e "an uncut writer: the prefix".

Nó core (`packages/core/test/group-member-6.test.js`), com `readBlocks` no lugar de `readHeldBlocks` em `readCoreParts`: 9/10, 71/72, falha "the sparse copy folds like the whole one".

Nó do navegador (`packages/web-member/test/group-memo.test.js`):

- `groupCoreState` em vez de `writerCoreState` para os escritores: 9/11, 56/60, falham "the leave past the hole counts" e "the sparse copy folded like the whole one" (grupo) e "the leave past the cut counts" e "the sparse copy folded like the whole one" (comunidade).
- `foldCommunity` sem as marcas de corte: 10/11, 58/60, falham "the leave past the cut counts" e "the sparse copy folded like the whole one" (comunidade).
- Carimbo antigo (`contiguous`, `length`, `fork`): a conferência da memória lança "stored fold differs from a fresh one".

Semeador (`packages/core/test/seeder-groups-cuts.test.js`), uma mutação por vez:

| Mutação | Resultado |
|---|---|
| M1 `_cutGroupCore` retorna na hora (nada é limpo) | tempo esgotado "W cortado em 3" (teste 7) |
| M2 cota da admissão sobre o núcleo inteiro | tempo esgotado "group-admitted" (teste 12) |
| M3 bytes mantidos depois do corte fora da cota | tempo esgotado "group-rejected ... quota" (teste 12) |
| M4 sem `caught && cut !== now` (corte que some não é aplicado) | tempo esgotado "W buscado de novo" (teste 11) |
| M5 sem `&& !released` no veredito do sem caixa | tempo esgotado "group-admitted" (teste 14) |
| M6 recusa não levantada por um corte menor | tempo esgotado "group-admitted" (teste 14) |
| M7 sem `groupRefused.set` ao sair pela cota do que guarda | 13/14, 326/327, falha "a writer dropped for what it keeps is not fetched again" |
| M8 `_groupCutScan` depois do teste de servido | o teste 13 estoura os 150000 ms |
| M9 veredito da partida sem a liberação | 13/14, 325/327, falham "N served at ready" e "not purged" |
| M10 `cut`, `clearedFrom` e `clearedTo` fora da ligação | falha "from its persisted cut" (teste 10), depois tempo esgotado "sem corte persistido" (teste 11) |

Ponta a ponta (`packages/core/test/sync-groups-sparse.test.js`):

- E1, `readBlocks` em `readCoreParts` (nó core lê os escritores como prefixo): 0/1, 11/12, falha "the sparse copies fold like the whole ones". O semeador e as cópias de R estão certos; só a dobra difere.
- E2, M1 no semeador (escritores cortados guardados inteiros): tempo esgotado "run condition", o semeador nunca fica esparso.

Segunda rodada, uma mutação por vez (`node <arquivo>` com a mudança tirada, depois restaurada):

| Mutação | Arquivo | Resultado |
|---|---|---|
| A1 meta do leitor sem `sparseMet` (nó core) | `packages/core/test/sync-groups-sparse.test.js` | 0/1, 13/14, falha "R's run ends ok before its deadline: tempo esgotado: <W1>:2/5, <W2>:1/4" |
| A2 meta do próprio escritor no comprimento inteiro (nó core) | o mesmo | 0/1, 13/14, falha "B's run ends ok before its deadline: tempo esgotado: <W1>:5/2, <W2>:4/1" |
| A3 meta do leitor sem `sparseMet` (navegador) | `packages/web-member/test/sync-groups-sparse.test.js` | 0/1, 10/11, falha "R's run ends ok before its deadline: tempo esgotado: <W>:2/4" |
| A4 `pushTarget` devolve o comprimento inteiro (navegador) | o mesmo | 0/1, 10/11, falha "B's run ends ok before its deadline: tempo esgotado: <W>:push 4" |
| B1 o `fetch` do escritor listado como antes | `apps/cli/test/pages-groups-sparse.test.js` | tempo esgotado "group join" (60 s de `indisponivel`) |
| B2 o `fetch` esparso sem `advertisedHeld` | o mesmo | tempo esgotado "group join" |

Terceira rodada, uma mutação por vez:

| Mutação | Arquivo | Resultado |
|---|---|---|
| C1 `peerAnswered` exige toda página de 32768 bits até o fim | `packages/core/test/sparse-held.test.js` | 1/2, 7/8, falha "every advertised block is held well before the deadline" |
| F1 `readHeldBlocks` com um `has()` por seq | o mesmo | 1/2, 7/8, falha "has() asked 40000 times, not once per block" |
| P1 pedaço depois do corte termina só com `range.done()` | `packages/core/test/seeder-groups-cuts.test.js` | tempo esgotado "W lido do primeiro semeador" (teste 15) |
| P2 sem a releitura da faixa incerta | o mesmo | tempo esgotado "W relido inteiro" (teste 15) |
| Q1 dono sem conferir as saídas depois do corte (nó core) | `packages/core/test/sync-groups-sparse.test.js` | 1/2, 18/20, falham "B's run does not count W pushed at its cut alone" e "it waits for the leave" |
| Q2 `askHeld` não pede nada (nó core) | o mesmo | 1/2, 19/20, falha no teste 1 "B's run ends ok before its deadline: tempo esgotado: <W1>:corte 4, <W2>:corte 3" |
| R1 dono sem conferir as saídas (navegador) | `packages/web-member/test/sync-groups-sparse.test.js` | 1/2, 17/20, falham "B's run does not confirm W at its cut alone", "it waits for W: []" e "and never reports it pushed" |
| R2 `askHeld` não pede nada (navegador) | o mesmo | passa, 2/2, 20/20 (abaixo) |
| R3 blocos servidos não contam (navegador) | o mesmo | 1/2, 18/20, falham "once the seeder reads past the cut the run ends ok: tempo esgotado: <W>:push 4" e "W reported pushed at its length" |
| R4 blocos servidos não contam (nó core) | `packages/core/test/sync-groups-sparse.test.js` | passa, 2/2, 20/20 (abaixo) |
| S1 carimbo com o limite antigo de 4096 blocos | `packages/web-member/test/group-memo.test.js` | 11/12, 63/65, falham "signed with 5990 blocks missing past its prefix" e "a block arriving past the hole changes it" |
| S2 espera sempre de 100 ms | `packages/web-member/test/sync-groups-sparse.test.js` | 2/3, 25/27, falham "twice the last wait while unchanged" e "up to the bound" |

As linhas R e Q rodaram antes do teste de unidade da S2, por isso 2 testes no arquivo do navegador. R2 passa porque, neste teste, o pedido que `seederHoldsMedia` já faz ao conectar (o segmento 0, antes de chegar a faixa contígua) traz o bitfield depois do corte; `askHeld` cobre o caso em que isso não acontece, e Q2 mostra no nó core que sem ele o dono não termina. R4 passa porque no nó core a resposta do bitfield costuma chegar depois de o semeador buscar a saída; R3 mostra no navegador o caso em que só a contagem do que foi servido confirma, e na quarta rodada o teste de unidade de `peerHolds` (T3, abaixo) falha sem ela.

Quarta rodada, uma mutação por vez:

| Mutação | Arquivo | Resultado |
|---|---|---|
| T1 sem conferir a queda depois do `advertisedHeld` | `packages/core/test/seeder-groups-cuts.test.js` | 15/16, 338/340, falham "the wait ends with nothing read" e "and listens on the core no more" (teste 16) |
| T2 cada `peer-add` volta o recuo a 1 s e relê (o código antigo) | o mesmo | 15/16, 338/340, falham "a peer offering nothing there starts no pass" e "and leaves the backoff" (teste 15) |
| T4 um par que oferece um bloco não relê nada | o mesmo | tempo esgotado "W relido inteiro" (teste 15: com o recuo em 5 minutos, só o anúncio de B relê) |
| T3 `peerHolds` sem os blocos servidos (R4) | `packages/core/test/sparse-held.test.js` | 3/4, 17/18, falha "a block served to it counts" |

Quinta rodada, depois do merge, uma mutação por vez:

| Mutação | Arquivo | Resultado |
|---|---|---|
| U1 `_pageArrived` dobra o corte apagado tardio só com `foldGroupRecord` (o código da #717) | `packages/core/test/seeder-delete.test.js` | 35/36, 289/290, falha "the writer the late cut released is tried again" (teste 32) |
| V1 sem `caught && cut !== now` (a M4 de antes) | `packages/core/test/seeder-groups-cuts.test.js` | tempo esgotado "W buscado de novo" (teste 15) |

A M4 rodou sobre o teste que apagava o registro de corte, que a #717 tornou impossível (acima); a V1 é a mesma mutação sobre o teste que o substitui. No commit do merge, antes do ajuste do fixture, `seeder-groups-cuts.test.js` parava com `TypeError` em `scanCaughtUp` no teste da #721: é o encontro do `_groupCutScan` deste PR com o `_reconcileGroups` da #721, não uma mutação.

## Decisões tomadas aqui

- A regra do buraco mora na dobra (`bindCores`), não só nos leitores: assim o nó core, o nó do navegador e o serviço de contas dobram igual mesmo com cópias diferentes do mesmo escritor, e um bloco depois de um buraco abaixo do corte nunca conta.
- Os escritores são lidos com `readHeldBlocks`; as raízes continuam com o prefixo (nunca são cortadas por um diário).
- No nó do navegador, `foldCommunity` passa a receber as marcas de corte: sem elas, um CW cortado guardado esparso dobrava diferente da cópia inteira.
- O semeador grava `cut`, `clearedFrom` e `clearedTo` antes de limpar; uma recontagem a cada serviço limpa o que uma queda deixou. A faixa lida fica numa peça só: um corte menor lê para baixo a partir de `clearedFrom` antes de seguir para cima.
- Um corte restaurado do `admitted.json` serve na hora, mas não limpa nada novo antes de a varredura do diário confirmá-lo (`cutConfirmed`). Corte menor aplica na hora (a varredura só acrescenta marcas, então nunca fica acima do corte do diário); corte maior ou ausente só depois de a varredura alcançar o diário (`scanCaughtUp`).
- Uma entrada recusada é tentada de novo uma vez a cada corte menor que a caminhada dá ao escritor: um corte faz caber na cota quem não cabia, e a liberação faz o sem caixa valer como toco. O custo é no máximo uma busca do bloco 0 por registro de corte.
- Um escritor que sai por causa do que guarda fica com a entrada recusada (`groupRefused`), como uma recusa na admissão; sem isso ele seria admitido, buscado e derrubado a cada varredura.
- A cota do que fica guardado usa `_overQuota` (núcleo inteiro) como atalho: só conta blocos e bytes quando o núcleo inteiro já passa da cota. Os bytes abaixo do corte são lidos um a um só nesse caso.
- Segunda rodada, (a): o anúncio que conta é o de todo par conectado que já sincronizou, não só o do semeador, e um par que ainda não respondeu pelo intervalo segura a meta. O próprio escritor usa o corte do diário (0 vira 1: o bloco 0 sempre fica), nunca o que o semeador lista.
- Segunda rodada, (b): só os escritores listados ganham a regra nova no serviço de contas; raiz e diário não são cortados e continuam pelo contíguo. O `fetch` ainda espera no máximo `FETCH_TIMEOUT_MS`; a diferença é terminar antes quando o anunciado já está guardado.
- (c) As dobras de catálogo (comunidade no índice) não recebem marcas e leem o prefixo, o que continua seguro. Mantido como está.
- (d) As cotas do lado do leitor usam o comprimento assinado, como já era. Mantido como está.
- (e) O semeador baixa os blocos depois do corte, até `MAX_LOG_BLOCKS`, só para ler o tipo; os pedaços de 256 limitam o que fica guardado além do mantido, não o que trafega. Mantido como está.
- O fragmento de changelog de `feat/writer-slot-walk` (que diz que o semeador guarda o escritor inteiro) não foi mexido: é de outro PR; o deste PR diz o comportamento novo.

## Riscos residuais e pontos em aberto

- (a) e (b) feitos na segunda rodada (acima).
- (c), (d) e (e): decisões mantidas (acima). Riscos que ficam: (c) uma dobra de catálogo vê menos de um CW cortado do que a dobra completa (só o prefixo), nunca mais; (d) um escritor esparso perto da cota de um leitor conta pelo comprimento assinado, não pelo que o leitor guarda; (e) a banda do semeador para um escritor cortado longo continua a do escritor inteiro até `MAX_LOG_BLOCKS`.
- (f) Feito depois, em `fix/released-boxless-writer` (`docs/verification/fix-released-boxless-writer.md`). Quando este PR foi escrito: as sincronizações (core e navegador) ainda recusam com `header-invalid` o cabeçalho sem caixa num grupo privado antes de guardá-lo, então um leitor que nunca o teve fica com a dobra `incomplete`, embora o semeador mantenha o toco. Fazer exige que o veredito do portão dependa da caminhada do diário que liga o escritor (o registro de corte 0, não só o bloco de entrada que o I1 admite), levantar a recusa da rodada (`refused`) quando essa caminhada muda, guardar só `[0, 1)`, pular esse escritor em `recheckGroupBoxes`, na revalidação da partida e na meta de conclusão, e decidir o que acontece quando a liberação some (registro de corte apagado). Isso muda as regras de admissão (I1 a I4) nas duas sincronizações.
- (g) Encontrado na segunda rodada, anterior a este PR (vem da #713): o semeador lista um escritor que o diário desligou com `group.leave` com o seq desse `group-join` `on: false`, e o portão do leitor exige `on: true` naquele seq, então recusa como `unbound` (no navegador, visto no teste: `group-skipped` com `reason: 'unbound'`; no nó core pela leitura do código, `joinVerdict`), cobra como dica ruim do semeador e nunca guarda o escritor. Com o diário guardado, a caminhada espera o escritor e a dobra pode ficar `incomplete`. Não mexido aqui. Quinta rodada: a #721, que entrou no merge, lista o escritor que saiu pelo seq do `group-join` `on: true` mais novo (`onSeq`). Conferido só pela leitura do código e pelo teste de unidade da #721, que passa aqui; o teste do navegador com `group.leave` não foi refeito.
- O "respondeu" de `advertisedHeld` é uma aproximação: a primeira página de um segmento criada por outra mensagem do par (o anúncio de um bloco só, um `range` de comprimento 1, por exemplo) antes da resposta ao pedido faz o par contar como respondido cedo. A faixa contígua do par não cria página, então isso só acontece com um bloco anunciado avulso nos primeiros 32768 blocos do segmento. O efeito é um `--once` terminar antes de um bloco anunciado chegar: a dobra trata a cópia como o prefixo (o que está depois do buraco e não chegou não conta) até a próxima sincronização, sem erro.
- Um semeador que só tem pares esparsos de um escritor cortado guarda o que eles têm depois do corte; uma saída ou um bloco de chave que nenhum par conectado tem só chega quando um par mais completo aparece (a faixa incerta é relida na hora quando um par que entra anuncia ali um bloco que falta e, sem isso, a cada até 5 minutos). Um par que só tem esse bloco depois da faixa contígua dele conta pela resposta ao pedido do bitfield; se ela não chega em 10 s, vale o recuo.
- No nó core, os cortes do próprio diário são lidos uma vez, quando a sincronização abre os escritores: um corte escrito durante a mesma execução só vale na próxima.
