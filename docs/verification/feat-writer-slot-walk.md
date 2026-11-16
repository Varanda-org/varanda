# Vagas de escritor pela caminhada do diário (branch feat/writer-slot-walk)

Parte da #350, item 8a, primeira parte: a dobra, o nó core no que a dobra muda e o semeador. Desenho B com A: R = 8 congelados e K = 16 liberações por diário e raiz. Os clientes (nó core e nó do navegador gravando cortes, reserva pelos vivos, app) ficam para a segunda parte.

## O que mudou

Dobra (`packages/core/lib/group.js`, `packages/core/lib/records.js`):

- `slotWalk` (pura) percorre, por diário D e raiz G, os `group-join` e `group-cut` de D em ordem de seq. Estados: nenhum, vivo, congelado, liberado. Teto de vivos 8, ou 7 a partir da primeira entrada ligada de D no escritor G (a vaga da raiz). Corte 0 libera enquanto houver menos de 16 liberações; corte a partir de 1 congela um vivo enquanto houver menos de 8 congelados; sem espaço, o escritor fica onde está, com o corte. Corte em escritor sem entrada, já liberado ou na raiz é ignorado pela caminhada. Uma entrada depois de um corte que abriu vaga conta.
- `bindCores` usa a caminhada no lugar do teto por diário. Candidatos = vivos, congelados e liberados. Qualquer que seja o corte, ficam o bloco 0, as saídas (`group-leave`) e os blocos de chave (`group-key`); o resto conta só abaixo do corte. Com corte 0 (liberado, ou contado com corte 0 depois das 16 liberações) sobram só esses três, e o escritor continua esperado: decisão de Rodrigo, 16/11/2026 (abaixo). Um congelado vem depois dos vivos da sua camada no teto de 512, e um liberado depois dos congelados; os dois deixam a dobra `incomplete` enquanto não estão guardados. Exceção: num grupo privado, um liberado cuja última entrada do diário está desligada (o escritor sem caixa trocado) não é esperado, e um escritor com corte 0 cujo cabeçalho não bate com o tipo do grupo é rejeitado. A dobra devolve `released`. Uma lacuna no histórico de um diário ligado ao grupo deixa a dobra `incomplete`.
- Os registros param no menor corte entre o da caminhada e todas as marcas do diário que o leitor tem, mesmo uma que a caminhada ignorou (gravada antes da entrada, ou vista por um leitor cuja lacuna esconde a entrada). A caminhada decide a vaga, nunca os registros.
- `MAX_FROZEN_WRITERS_PER_DIARY = 8` e `MAX_WRITER_RELEASES_PER_DIARY = 16` em `records.js`.

Nó core (`packages/core/lib/member.js`, só o que a dobra obriga):

- `countedCuts(..., { frozen })`: saídas e concessões listam só os vivos (com 8 vivos e congelados a lista passava do limite de 8 cortes de uma saída); admissões e rebaixamentos mantêm os congelados, nunca além do corte do diário, e nunca nomeiam um liberado (16 liberados não caberiam em `MAX_GROUP_CUTS`). O mesmo vale para `cutsFor` e `countedCuts` do nó do navegador.
- `groupCuts` (grupos): uma admissão, um banimento ou um rebaixamento nunca nomeia um escritor além do corte do diário nele.
- `unheldCountedWriters` segue a caminhada: um congelado e um liberado são esperados (as saídas deles ainda contam), salvo, num grupo privado, um liberado cuja última entrada está desligada; um 9º depois de um congelamento também é.
- Escritor sem caixa num grupo privado (entrada antes de a raiz chegar): ao trocá-lo, o nó core e o nó do navegador (`joinLoaded` nos dois) gravam, depois da entrada desligada e antes da entrada nova, um `group-cut` nele (`replacedWriterCut` em `group.js`: 0 para um cabeçalho sem caixa, seja o que for que ele guarde; para um cabeçalho com caixa de outra chave, um a mais que a última seq guardada, 1 com só o `rejoin`, 0 com só o cabeçalho). Antes de gravar qualquer coisa, o nó passa pela caminhada do próprio diário a entrada desligada e o corte que gravaria (`walkHasRoom` em `group.js`): se o escritor novo não ganharia vaga de vivo, nada é gravado e a resposta é `GROUP_FULL`. Sem isso, a entrada desligada continua ocupando a vaga na caminhada, e a entrada nova com caixa no limite de 8 nunca contaria: o teste do navegador "at the writer cap a boxed rejoin does not count the boxless writer it unbinds" falhava com `limite do grupo atingido`. É o único autocorte deste PR; os outros ficam para os clientes.
- Depois da junção com a `main` (#688, `deviceUpkeepPlan` com troca automática do escritor sem caixa): a troca automática chama `groupJoin`, que passa pelo mesmo `joinLoaded`, então os dois caminhos gravam um só corte. O teste "a boxless private writer is reboxed once the root arrives, then nothing is left to plan" de `packages/web-member/test/device-upkeep-ops.test.js` agora confere o corte 0 único entre a entrada desligada e a nova, o diário com 3 registros novos (antes 2) e a caminhada contando o escritor novo.

Semeador (`packages/core/lib/seeder.js`, `admission.js`, `net.js`):

- O escaneamento passa os `group-join` e os `group-cut` de cada diário pela caminhada (`groupWalks`, no lugar de `groupFirst`). `liveGroupJoins` admite a raiz, os vivos, os congelados e os liberados (estes como tocos). Um contado cuja última entrada está desligada também é admitido, como `left`, quando o grupo dele está entre os 64 escolhidos ou não tem nenhuma entrada ligada contada. A raiz nunca entra assim.
- Até 32 núcleos por diário e grupo (8 vivos, 8 congelados e um toco de cada um dos 16 liberados) e 64 × 16 = 1024 por diário no total, tocos incluídos.
- Escritor com corte (congelado, liberado, ou vivo com corte quando os congelados ou as liberações acabaram): o corte fica na ligação persistida (`cut`), o download contínuo vai de 0 ao corte (a 1 com corte 0), e o semeador busca o que vem depois, lê cada bloco e limpa (`clear`) tudo menos as saídas e os blocos de chave, que a dobra ainda conta: um leitor que só fala com semeadores dobra como quem tem o núcleo inteiro. Com corte 0 sobra um toco: bloco 0, saídas e blocos de chave. A cota é a do núcleo inteiro, como a de qualquer escritor, conferida na quarentena, depois da abertura e a cada `append`. Um corte menor, visto depois, abaixa o corte e lê o resto de novo; visto com o núcleo ainda abrindo, vale já na abertura.
- Na partida, a ligação restaurada traz o corte (0 inclusive) e o escaneamento seguinte o abaixa.
- O canal de admissão anuncia o bit `CAP_WRITER_CUTS = 4`. Nenhum cliente o lê ainda.

Documentos: `docs/protocol.md` (registro `group-cut`, bit de capacidade, limites, "Slot walk", "Writers named by a node", cortes do diário com a regra do corte 0, direito à chave, admissão do semeador com "Cut writers" e tocos, riscos residuais, chaves do nó do navegador). `docs/rpc.md` não muda: nenhum método mudou.

## Como verificar

Cada arquivo sozinho, a partir da raiz, com `node <arquivo>`:

- `packages/core/test/seeder-groups-cuts.test.js` (novo): 11 testes, 299 asserções.
  1. "liveGroupJoins: a cut frees a slot for a 9th writer, never past 8 live, 8 frozen and 16 stubs (#350)".
  2. "liveGroupJoins: a counted writer whose join is off stays, left; an uncounted one does not (#350)".
  3. "liveGroupJoins: groups past MAX_GROUPS_PER_DIARY keep no writer, left or not (#350)".
  4. "liveGroupJoins: a join, cut 0, join loop stops at K releases (#350)": 24 escritores pedidos, todos guardados como tocos, 8 deles presos em corte 0 depois das 16 liberações.
  5. "liveGroupJoins: without cuts it keeps what the earliest-join rule kept": 200 rodadas aleatórias contra a regra antiga.
  6. "a cut after the download clears from the cut, keeps only leaves and key blocks past it, and serves what it keeps with proofs (#350)": o semeador baixa W inteiro, o diário corta W; o semeador limpa do corte em diante menos a saída e o bloco de chave, um leitor novo que só fala com o semeador verifica os blocos guardados e não recebe os outros.
  7. "a 9th writer after a freeze is admitted at its cut, a counted writer whose join is off is admitted as left, the 10th never (#350)".
  8. "a writer its diary released (cut 0) is kept as a stub that serves its leave to a fresh reader (#350)": W com saída no bloco 6; o semeador guarda só os blocos 0 e 6, e um leitor novo recebe a saída.
  9. "a restart restores a writer at its persisted cut and the scan lowers it or makes it a stub (#350)".
  10. "a cut writer is held to its whole log's quota: refused past it at admission, dropped once it grows past it (#350)".
  11. "a lower cut seen while a writer core is still opening is the cut it is served at (#350)".
- `packages/core/test/admission-caps.test.js` e `packages/core/test/seeder-discovery.test.js`: o bit `CAP_WRITER_CUTS` é 4, sai em `net` e é anunciado com e sem descoberta.
- Dobra: `group.test.js`, `community-fold.test.js`, `group-private.test.js`; nó core: `group-member.test.js`. Os testes novos de dobra:
  - "slotWalk: the rules one by one (#350)", "slotWalk: one result for any input order, and every prefix agrees with the whole diary (#350)", "slotWalk: with no cut off the root it keeps the slots of the per-diary cap (#350)".
  - "slot walk: a 9th writer counts after a diary cut froze or released one, never without (#350)", "slot walk: cuts at the exact length change no member and no post (#350)", "slot walk: a frozen writer keeps its leave and its rejoin target (#350)", "slot walk: an old boxless writer holds its slot until a cut 0 releases it (#350)", "slot walk: a cut on an entitled writer asks for a new key, the frozen writer is entitled to none (#350)", "over 512 writers a frozen writer goes before the live ones of its layer (#350)", "diaryGroupKeys: a diary cut gives a slot back to a later join (#350)".
  - "countedCuts: a frozen writer stays in admissions at its cut, out of leaves and grants (#350)", "unheldCountedWriters follows the slot walk (#350)".
  - "group-cut: a cut never undoes a leave nor the rejoin naming it, cut 0 included (#350)": volta à forma da #693 (cortes 0, 1 e 2), mais as conferências de `released` e de um liberado não guardado que deixa a dobra `incomplete`.
  - "group-cut: a copy held below the cut plus its leave and key blocks folds like the full copy (#350)", "group-cut: a reader whose hole hides the join still cuts by the mark it holds (#350)" e, no teste "group-cut on an own writer", marcas gravadas antes da entrada (cortes 0 e 1) que ainda cortam os registros.
  - `group-private.test.js`: "a diary cut below its own leave keeps the diary left and the removal (#350)" e "a key block past a diary cut stays readable, never sendable (#350)" voltam aos laços da #693 (cortes 0, 1 e 2; 0 e 1): com corte 0, X continua fora, com a remoção, o escritor novo não tem direito à chave e o histórico selado continua legível. Novo: "replacedWriterCut: a boxless writer is released whatever it holds, a writer boxed to another key keeps what counts (#350)".
  - `group.test.js`: "walkHasRoom: a new writer counts only where the walk has a live slot, after the caller's own events (#350)". `group-member.test.js`: "groupCuts: an admit or a ban never names a writer past the diary's cut on it (#350)", e os testes de `countedCuts` e `unheldCountedWriters` com um liberado (fora das listas, esperado).
- `packages/core/test/private-member-3.test.js`, teste novo "private: at the writer cap a boxed rejoin cuts the boxless writer, so the new one counts (#350)": 7 escritores com caixa mais o sem caixa; a nova entrada fica `requested`, o sem caixa recebe corte 0 antes da entrada nova, a caminhada o libera e conta o novo, e entrar de novo não grava outro corte. E "private: a full diary whose boxless writer never counted gets GROUP_FULL with nothing written (#350)"; no nó do navegador, o mesmo em `private-ops.test.js` ("a full diary whose boxless writer never counted gets GROUP_FULL with nothing written (#350)").
- `apps/cli/test/seed-ws-discovery.test.js`: um semeador sem descoberta anuncia só `CAP_WRITER_CUTS` (antes, 0).
- `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo`.

Resultados da segunda e da terceira rodada (revisão e decisão sobre o corte 0), cada arquivo sozinho com `node <arquivo>`:

- `community-fold` 112/112 (1051 asserções), `group-private` 121/121 (847), `group-member` 13/13 (151), `group` 147/147 (1237), `seeder-groups-cuts` 11/11 (299), `private-member-3` 7/7 (37), `private-ops` do navegador 24/24 (231).
- Também sozinhos e verdes com o código da terceira rodada: no core, `group-member` 2 a 6, `private-member` 5/5 (115), `private-member-2` 5/5 (66), `private-member-4` 5/5 (22), `community-member` 25/25 (262), `community-member-leave` 1 a 5, `sync-groups` 1 a 6, `sync-private` 4/4, `sync-communities` 7/7, `session-groups` 16/16 (638), `group-events` 18/18, `group-index` 12/12, `seeder-groups` 40/40 (249), `seeder-groups-3` 6/6, `seeder-groups-waits` 12/12, `seeder-communities` 8/8, `seeder-private` 4/4, `admission-caps` 11/11, `groups-net` 17/17; no navegador, os 17 arquivos de grupos, comunidades, privados, aparelhos e sincronização, entre eles `device-upkeep-ops` 29/29 (203), `session-upkeep` 26/26 (151), `sync-groups` 16/16, `sync-groups-2` 26/26, `private-e2e` 2/2, `groups-e2e` 2/2 e `devices-private-e2e` 1/1. `private-member-3` estourou o tempo duas vezes no teste "private: fake bans from an unadmitted writer never inflate a rotation" com a máquina carregada (load perto de 5), como já acontecia com a base; numa cópia só com ele, passou (3 asserções), e numa cópia sem ele, os outros passaram (34 asserções).

Resultados da primeira rodada, cada arquivo sozinho (máquina com load entre 5 e 9):

- Semeador: `seeder-groups-cuts` 9/9 (253 asserções), `admission-caps` 11/11 (50), `seeder-discovery` 6/6 (75), `seeder-groups` 40/40 (249), `seeder-groups-3` 6/6 (33), `seeder-groups-waits` 12/12 (61), `seeder-communities` 8/8 (54), `seeder-private` 4/4 (33), `seeder` 29/29 (163), `seeder-dm` 11/11 (109), `seeder-feira` 26/26 (157), `seeder-media` 9/9 (84), `seeder-post-public` 4/4 (69), `seeder-stream` 20/20 (166).
- Dobra e nó core: `group` 146/146 (1226), `group-private` 120/120 (829), `community-fold` 110/110 (1029), `group-member` 12/12 (145). Também passaram, numa rodada anterior com o mesmo código de dobra: `group-member` 2 a 6, `community-member`, `community-member-leave` 1 a 5, `private-member`, `private-member-2`, `private-member-4`, `sync-groups` 1 a 6, `sync-communities`, `session-groups`, `group-events`, `group-index`.
- Nó do navegador (usa a dobra do core): `packages/web-member/test/group-ops.test.js` 57/57 (436), `community-ops.test.js` 71/71 (535), `session-groups.test.js` 25/25 (249).
- `seeder-groups-cuts`, na primeira rodada final, falhou no teste 9 ("W served at ready"): o semeador era fechado antes de ter baixado W, e a restauração o descartava como sem cabeçalho. O teste agora espera W e W2 baixados antes do fechamento; depois disso, 9/9.
- Suíte afetada (`npm test -- --affected=origin/main`, 797 arquivos, antes da correção do escritor sem caixa): 7 arquivos falharam. Dois eram desta branch e foram corrigidos: `apps/cli/test/seed-ws-discovery.test.js` (esperava capacidade 0 de um semeador sem descoberta) e `packages/web-member/test/private-ops.test.js` (o escritor sem caixa, acima). Os outros cinco foram de tempo, com a máquina carregada por outras sessões: `apps/cli/test/update.test.js`, `community-member`, `seeder-groups` (tempo do executor), `group-member-3` e `private-member-3` (tempo de 30 s de um teste). Sozinhos, com o código final (correção do escritor sem caixa incluída), todos passam: `update` 73/73 (1901 asserções), `community-member` 25/25 (262), `seeder-groups` 40/40 (249), `group-member-3` 10/10 (84), `private-member-3` em duas cópias, o teste lento sozinho 1 teste (3 asserções) e os outros 6 (29), `private-ops` 23/23 (227), `seed-ws-discovery` 3/3 (18). Também sozinhos e verdes depois da correção: `private-member` 5/5, `private-member-2` 5/5, `private-member-4` 5/5, `group-member` 12/12, `group-member-4` 10/10, `sync-private` 4/4, `group` 146/146, `group-private` 120/120, `community-fold` 110/110, `seeder-groups-cuts` 9/9, `group-ops` 57/57, `community-ops` 71/71, `session-groups` 25/25. A suíte inteira não foi rodada de novo depois da correção.
- `npm run demo`: `DEMO OK`.
- `private-member-3.test.js`: o teste "private: fake bans from an unadmitted writer never inflate a rotation" (5000 registros) estourou o tempo de 30 s duas vezes com o código final e uma vez com `group.js`, `member.js` e `records.js` da base (6110675e), com a máquina carregada; numa cópia que roda só ele, passou. Como o estouro derruba o arquivo, os testes seguintes foram rodados numa cópia sem ele (6/6).

## Prova de regressão

Cada regressão foi conferida trocando, de forma temporária, o arquivo da biblioteca pela cópia da base guardada fora do repositório (sem `git stash`), rodando os testes e restaurando o arquivo novo.

- Dobra, `group.js` da base (6110675e) com um calço que só exporta nomes vazios para as funções novas: `group.test.js` 139/146 (falham os testes da caminhada; dois dos sete leem o código-fonte e falham pelo calço), `community-fold.test.js` 103/110, `group-private.test.js` 116/120. Com a mudança: 146/146, 110/110, 120/120. O teste de ordem e prefixo passa até com o calço, porque um resultado vazio concorda consigo mesmo: ele vale como teste de propriedade do código novo, não como regressão.
- Nó core, `member.js` da base: os dois testes novos de `group-member.test.js` falham (6 de 12 asserções num executor só deles; o arquivo inteiro cai em `cuts-invalid`). Com a mudança: 12/12.
- Semeador, `seeder.js`, `admission.js` e `net.js` da base (6ef7b3ab):
  - `seeder-groups-cuts.test.js`, testes puros: 1, 2 e 4 falham; 3 passa (a regra dos 64 grupos já existia); 5 passa por desenho (equivalência com a regra antiga).
  - Testes de rede, cada um sozinho: o 6 estoura o tempo esperando o corte em 3 (a base nunca limpa); o 7 estoura esperando a admissão do 9º escritor; o 8 estoura esperando a purga `released`; o 9 estoura o tempo esperando o núcleo de W baixado só até o corte 4 (a base baixa os 6 blocos); numa versão anterior do teste, sem essa espera, falhava a asserção "from its persisted cut" e estourava o tempo esperando a purga `released`.
  - `admission-caps.test.js` 10/11 e `seeder-discovery.test.js` 4/6 (falham as asserções do bit novo).
  - Com a mudança, tudo passa.

- Escritor sem caixa, `member.js` e `member-ops.js` de HEAD (8772d908) com os testes novos: o teste novo de `private-member-3` falha 2 asserções ("cut at 0", "the cut comes before the new join") e depois cai com `limite do grupo atingido` na segunda entrada; `private-ops.test.js` cai com `limite do grupo atingido`. Com a mudança, passam.
- `seed-ws-discovery.test.js` com o semeador da base: 2/3 testes (17/18 asserções), falha o do bit. Com o semeador novo: 3/3 (18/18).

Segunda e terceira rodada, cada correção conferida da mesma forma (arquivo da biblioteca trocado à mão pela cópia de antes da correção, sem `git stash`):

- Marca que a caminhada ignorou ainda corta (d7e1b405): `community-fold.test.js` 109/111 (1037/1040 asserções) sem a correção, 111/111 (1040) com ela.
- Escritor sem caixa liberado seja o que for que guarde (9edc5fcc): `group-private.test.js` 120/121 (835/840) sem, 121/121 (840) com.
- Vaga conferida pela caminhada antes de gravar (afc54a0d): o teste novo de `private-member-3` falha 2 de 5 asserções sem a correção; `private-ops.test.js` 229/231 sem, 231/231 com.
- Saídas e blocos de chave guardados depois do corte, cota do núcleo inteiro (94ad897d): sem a correção, o teste 6 de `seeder-groups-cuts` falha em "keeps only" e o teste da cota estoura o tempo esperando a recusa `quota` na quarentena; com ela, 10/10 (261). O teste de dobra "a copy held below the cut plus its leave and key blocks folds like the full copy" passa também com a dobra antiga: é teste de propriedade, não de regressão.
- `groupCuts` preso ao corte (76d559f8): `group-member.test.js` 12/13 (147/148) sem, 13/13 (148) com.
- Corte menor com o núcleo ainda abrindo (7e8d6604): sem a correção, o teste novo estoura o tempo em "corte menor na ligação"; com ela, `seeder-groups-cuts` 11/11 (266).
- Corte 0 guarda saídas e blocos de chave, tocos no semeador (terceira rodada): `community-fold` 108/112 (1038 asserções) com a dobra anterior (mais um calço que devolve `released` vazio), 112/112 (1051) com a nova; `group-private` 119/121 (839) sem, 121/121 (847) com; `group-member` 11/13 com o `member.js` anterior e 12/13 com o `group.js` anterior, 13/13 (151) com os dois novos; `seeder-groups-cuts` com o semeador anterior: os testes puros 1 e 4 falham (246/248 asserções) e o teste do toco estoura o tempo em "W reduzido a um toco"; com o novo, 11/11 (299).

## `clear` no Hypercore 11

Pergunta do estudo (3.4): depois de `clear` acima do corte, o Hypercore mantém as provas dos blocos abaixo e continua servindo esses blocos?

- Leitura do código (hypercore 11.40.4, `SessionState.clear`): a limpeza sobe a árvore a partir da folha `start * 2` e só descarta um nó e a subárvore irmã quando todo o intervalo da irmã está dentro do trecho limpo ou não tem nenhum bloco guardado; senão para. Nenhum tio de um bloco mantido é descartado, então as provas dos blocos abaixo do corte continuam completas.
- Na prática: os testes 6 e 8 acima. Um leitor novo, que só alcança o semeador, verifica os blocos abaixo do corte e as saídas e blocos de chave guardados depois dele, intercalados com trechos limpos, e não recebe os blocos limpos.
- Não verificado: o Hypercore 10 do nó do navegador (ele não usa `clear` neste PR).

## Inventário dos consumidores de `writers` (contados)

Mudou neste PR:

- `group.js`: `bindCores`, `entitled` (congelado nunca tem direito), teto de 512 (congelados depois dos vivos), `liveWriters` e `authorityWriters` (congelado fora), `diaryGroupKeys` (pela caminhada), `incomplete` (congelado não guardado, lacuna).
- `member.js`: `countedCuts` (vivos em saídas e concessões, congelados em admissões e rebaixamentos), `unheldCountedWriters`, `liveOwnWriter` (lê `liveWriters`, que já exclui congelados).
- `seeder.js`: `liveGroupJoins`, `_reconcileGroups`, `_groupStillWanted`, `_groupSupported`, `_groupFullFor`, `_admitGroup`, `_admitGroupReserved`, `_serveGroup`, `_cutGroupCore`, partida.

Ficou para o PR dos clientes (cada um conta ou decide por contados e deveria passar a contar só vivos, ou usar a caminhada):

- Nó core (`member.js`): `boundWriterCount` (conta núcleos guardados), usado em `GROUP_FULL` de `joinLoaded` e em `COMMUNITY_FULL`; o `- (boxStale ? 1 : 0)` de `joinLoaded` (o corte no escritor sem caixa já é gravado neste PR, mas a conta de `GROUP_FULL` ainda é por núcleos guardados); os autocortes ao trocar o próprio escritor (saída, sem caixa, CW retirado) gravados antes da entrada nova.
- `packages/core/lib/sync.js`: os tetos por diário ao buscar escritores de grupo (`othersHolding`, `gatesInFlight`, `held.length` contra `MAX_GROUP_WRITERS_PER_DIARY`). Sem mudança, o nó sincronizado pode deixar de buscar o 9º escritor depois de um congelamento, ou um congelado ou liberado que a dobra espera.
- Nó do navegador (`packages/web-member`): a dobra já é a do core, então ele já vê a caminhada; falta `capVictim` e `capExcess` (`sync.js`), `diaryBound`, `autoEnrolRoom`, `GROUP_FULL` e `COMMUNITY_FULL` pelos vivos (`member-ops.js`), os autocortes, `device.disconnect` e os campos `writersFrozen` e `frozenRoom` nas informações.
- App (`apps/app/src/groups.js` e telas): a reserva por `writersBound` (vivos), o aviso sobre as vagas e a recusa com 8 vivos apontando para Aparelhos conectados.
- `docs/protocol.md`, "Bounds on hints" (tetos de sincronização), e `docs/rpc.md` quando os campos novos entrarem.
- O teto extra do estágio 2 do estudo: os clientes ainda contam os escritores ligados alguma vez, para ninguém entrar numa vaga devolvida antes de os semeadores estarem atualizados.

## Riscos residuais

- Ciclos de saída e volta gastam a franquia: depois de 8 congelamentos e 16 liberações num grupo, a conta fica em 8 vivos, como antes.
- Bifurcação por quem tem a chave de um escritor desconectado: o semeador purga um núcleo bifurcado, e o histórico abaixo do corte se perderia nos semeadores. Com o download parando no corte, talvez o semeador nem perceba uma bifurcação acima dele. Não verificado no Hypercore 11 nem no 10.
- Cota do escritor cortado: é a do núcleo inteiro, então quem tem a chave de um escritor cortado pode escrever depois do corte até passar da cota e fazer os semeadores largarem o núcleo, com o histórico abaixo do corte junto. Antes, a cota contava só abaixo do corte, mas aí o semeador não guardava as saídas depois do corte.
- Teto de 512 por grupo: um grupo cheio perde primeiro congelados das camadas baixas. Um congelado descartado que guarda uma saída faz o membro reaparecer, como já acontece com escritores que saíram.
- Versões antigas do app não verão os posts de um aparelho que entrou numa vaga devolvida.
- R e K são decisão do dono; o total por diário no semeador foi decidido (abaixo).

## Decisões tomadas

Decidido por Rodrigo em 16/11/2026:

1. Corte 0 libera a vaga do escritor (para a caminhada e para o teto de 16 liberações), mas o bloco 0, as saídas e os blocos de chave dele continuam contando, e ele continua esperado. Um diário não desfaz a própria saída com corte 0, nem quem tem a identidade destravada desfaz a saída de outro aparelho do dono. Antes era o ponto 3.
2. O semeador guarda, depois do corte, as saídas e os blocos de chave de um escritor cortado (sob a cota normal), e um toco de cada liberado (bloco 0, saídas e blocos de chave), além dos 16 núcleos inteiros por diário e raiz. Antes eram os pontos 3, 4 e 5.
3. Contados com entrada desligada continuam admitidos nos grupos escolhidos e nos grupos sem entrada ligada contada. Antes era o ponto 8.
4. O total por diário no semeador continua 1024 (64 × 16), tocos incluídos. Antes era o ponto 9.
5. O autocorte do escritor sem caixa não espera o bit `CAP_WRITER_CUTS`, que só é anunciado. Antes era o ponto 13.

## Decisões a confirmar

Escolhas conservadoras onde o estudo não decide:

1. A vaga da raiz vale a partir da primeira entrada ligada de D no escritor G (estável por prefixo). Um diário que liga a raiz depois de já ter 8 escritores fica com 9 núcleos contados naquele grupo.
2. Qualquer diário que ligue o escritor G reserva a vaga da raiz (a regra do semeador); antes, na dobra, só o criador.
3. Para guardar, o semeador trata como cortado todo contado com corte (inclusive o vivo com corte, quando os 8 congelados estão ocupados) e guarda como toco todo escritor com corte 0 (inclusive o vivo com corte 0, quando as 16 liberações acabaram).
4. A cota de um escritor cortado é a do núcleo inteiro (risco acima).
5. Uma admissão presa ao corte (`groupCuts`) não vê uma saída gravada depois do corte, a não ser por uma volta que a nomeie.
6. Liberados nunca entram nas listas de cortes que um nó grava (admissão, banimento, saída e concessão).
7. Num grupo privado, um liberado cuja última entrada do diário está desligada não é esperado (é o escritor sem caixa trocado, que semeadores e sincronização recusam).
8. No semeador, o teto por diário e grupo é 32 núcleos com os tocos, dentro do total de 1024 por diário: um diário que use 64 grupos com 16 núcleos inteiros em cada não tem lugar para tocos.
9. Os tetos de sincronização (`sync.js` do core e do navegador) podem não buscar um congelado ou liberado: fica para o PR dos clientes.
10. Uma lacuna deixa a dobra `incomplete` só para diários com entrada ligada no grupo.
11. Marcas sem seq válida são ignoradas pela caminhada.
12. O teto de 512 escritores por grupo no semeador pode recusar um vivo enquanto congelados ou tocos o ocupam, o que não segue a ordem da dobra (vivos antes dos congelados na camada). Fica como risco.
13. O autocorte do escritor sem caixa entrou neste PR, embora os clientes fiquem para a segunda parte, porque a dobra nova quebrava a troca desse escritor no limite de 8 (teste do navegador). O corte usa o comprimento que o nó tem; sem o núcleo guardado, nenhum corte é gravado e a entrada nova pode ficar acima do teto, como antes de a dobra contar o sem caixa.
