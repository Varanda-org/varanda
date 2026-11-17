# Vagas de escritor nos clientes (branch feat/writer-slot-clients)

Parte da #350, item 8a, segunda parte (8a-2): o nó core, o nó do navegador e o app passam a contar e a devolver vagas de escritor pela caminhada do próprio diário (`slotWalk`, da primeira parte, `feat/writer-slot-walk`, #713). A leitura esparsa e a limpeza no semeador (8a-3) ficam em outra branch; `seeder.js` não muda aqui. Decisões do dono que este PR segue sem reabrir: 8 vivos, 8 congelados e 16 liberações por diário e raiz; corte 0 libera e corte a partir de 1 congela; o bloco 0, as saídas e os blocos de chave de um escritor cortado continuam contando, e uma saída depois do corte também; o total por diário no semeador continua 1024; o autocorte não espera `CAP_WRITER_CUTS`.

## O que mudou

Nó core:

- `group.js`: `retiredWriterCut` (nova) dá o corte que um nó marca no próprio escritor que troca: 0 para um cabeçalho sem `rejoin` e mais nada, 1 para um cabeçalho com `rejoin` e mais nada (a geração lê o bloco 0), senão um a mais que a última seq guardada (o aparelho guarda o próprio núcleo inteiro), então nenhum registro dele deixa de contar. `null` sem o bloco 0. `replacedWriterCut` (escritor sem caixa de um grupo privado) continua dando 0 para o cabeçalho sem caixa e usa `retiredWriterCut` para o com caixa.
- `member.js`, `joinLoaded`: ao trocar o próprio escritor vivo (aposentado por uma saída de qualquer aparelho, ou citando um CW que a porta retirou), `retireLocalWriter` grava a entrada desligada (se a última entrada dele está ligada) e o corte, antes da entrada nova, salvo quando o diário já tem uma marca nele no mesmo corte ou abaixo. Só o escritor deste aparelho: o de outro aparelho só é cortado por `device.disconnect`. A entrada desligada, o corte e a entrada nova passam juntos por `walkHasRoom` antes de qualquer escrita: sem vaga viva para o novo (8 vivos, ou sem espaço para congelar ou liberar o antigo), nada é gravado e a resposta é `GROUP_FULL`.
- `member.js`, `communityJoin`: `COMMUNITY_FULL` pela caminhada do próprio diário (`walkHasRoom`), não mais pelos CWs guardados (`boundWriterCount` saiu). Um CW congelado ou liberado devolve a vaga; um que nunca contou não ocupa nenhuma.
- `sync.js`: os tetos por diário ao buscar escritores de grupo (núcleos guardados na partida, portas em andamento, `othersHolding`, e os dois candidatos a mais de `MAX_CAP_CONTENDERS`) usam `MAX_GROUP_HELD_PER_DIARY` = 32 (8 vivos, 8 congelados e 16 liberados), como o semeador guarda, no lugar de 8. Um congelado ou liberado pode guardar uma saída que a dobra lê. As vagas continuam indo para as entradas provadas mais antigas.
- `group-rekey.js`, `epochFacts({ cuts })`: um `group-sealed` de um escritor com corte, na seq igual ou acima de `max(corte, 1)`, não conta para a política da troca periódica, como a dobra o descarta. Os blocos de chave continuam contando. O nó core passa `view.cuts`.

Nó do navegador (`packages/web-member`):

- `member-ops.js`: `GROUP_FULL` e `COMMUNITY_FULL` (entrada normal e pendente) pela caminhada do próprio diário (`ownWalkHasRoom`); `retireOwnWriter` em `joinLoaded`, com as mesmas regras do nó core; `missingWriters` (o que uma admissão espera) escolhe pela caminhada (`walkCounted`), com a exceção do grupo privado da primeira parte; saídas e concessões nomeiam só os vivos (`countedCuts(..., { frozen: false })`), e uma admissão ou um rebaixamento nunca nomeia um escritor além do corte do diário (`cappedCut`), como `countedCuts` e `groupCuts` do core; a dobra da comunidade (`foldCommunity`) passa a ler as marcas `group-cut` dos diários, como o nó core.
- `group.info` (5.42) e `community.info` (5.59): `writersBound` passa a ser as vagas vivas do diário (vivos mais a vaga da raiz, de 0 a 8); novos `writersFrozen` (congelados, sem os liberados) e `frozenRoom` (8 menos `writersFrozen`); na comunidade, também `generalWritersFrozen` e `generalFrozenRoom`, de Geral, lidos do próprio diário. Resposta pendente: `0`, `0` e `8`. Sem mudança de versão do RPC: os campos de resultado não são validados por esquema, e `writersBound` entrou do mesmo jeito.
- `sync.js`: `capVictim` e `capExcess` com `MAX_GROUP_HELD_PER_DIARY` = 32, pelas entradas provadas mais antigas, como no core.
- `sync.js`, adoção de raízes ligadas ao diário (item da coordenação, achado numa revisão da `main` depois da #713): as duas leituras do próprio diário (`fold.joinEntries`) guardavam só `group-join`, então `diaryGroupKeys` caminhava sem os cortes, e um 9º escritor que ocupava uma vaga que um corte liberou contava para o semeador e para a dobra, mas não para essa adoção. Agora guardam `group-join` e `group-cut` (`WALK_TYPES`). `liveDiaryWriters`, que ainda usava a regra dos 8 primeiros, passa à caminhada (vivos e congelados) e sai do fechamento para o módulo, para o teste de unidade alcançá-la.
- A troca periódica passa `g.built.cuts` para `epochFacts`.

App (`apps/app`):

- `src/groups.js`: auxiliares puros `groupSlots`, `communitySlots`, `slotReturn` (`legacy`, `returns` ou `final`, pela presença de `frozenRoom`), `reserveText`, `reserveJoinText`, `slotFullText` e `slotRefusal`. Com um nó que informa `frozenRoom`, o aviso da reserva diz que cada aparelho usa uma das 8 vagas da conta neste grupo (ou nesta comunidade) e que desconectar um aparelho antigo em Aparelhos conectados devolve a vaga, ou, com `frozenRoom` 0, que ali desconectar já não devolve. Com um nó antigo, o texto antigo (`DEVICE_RESERVE_TEXT`).
- Telas `Grupo.js`, `Comunidade.js` (as duas chamadas de `community.join`) e `ComunidadeInfo.js`: o aviso pelos auxiliares; uma recusa `GROUP_FULL` ou `COMMUNITY_FULL` (sem `uncertain`) relê as informações e, se uma raiz está com as 8 vagas vivas, mostra "Sua conta já usa as 8 vagas de aparelho neste grupo. Desconecte um aparelho antigo em Aparelhos conectados para liberar uma vaga." (ou a variante sem reserva). Senão, o erro original. O segundo toque de confirmação continua.
- `src/vitrine/request.js`: as respostas de `group.info` e `community.info` com os campos novos.

Documentos: `docs/protocol.md` ("Writers named by a node", "Bounds on hints", "Diary-bound roots (browser)", "Automatic device enrolment"), `docs/rpc.md` (5.42, 5.59 e o parágrafo da entrada automática em 5.63, que dizia que o semeador nunca devolve a vaga) e `docs/app.md` (aviso da reserva).

## Como verificar

Cada arquivo sozinho, a partir da raiz, com `node <arquivo>` (os do app com `cd apps/app && node test/<arquivo>`), mais `npx standard` nos arquivos mudados. A suíte inteira e a demo ficam para a CI de chegada da sessão que coordena.

Testes novos ou mudados:

- `packages/core/test/writer-slot-member.test.js` (novo), 5/5 (34 asserções): "a rejoin after a leave cuts the retired writer at its length before the new join, so the new one counts at the cap"; "with no frozen room left, a rejoin after a leave gets GROUP_FULL with nothing written"; "a group rejoin after the CW was retired cuts a header-only writer at 0, after its off join"; "community.join counts the own diary's slot walk, not the CWs held: COMMUNITY_FULL with nothing written"; "community.join takes a slot a cut freed in the own diary's walk".
- `packages/core/test/group.test.js`, 154/154 (1303): novo "retiredWriterCut and replacedWriterCut: the cut a node marks on the own writer it replaces (#350)".
- `packages/core/test/group-member-4.test.js`, 10/10 (83): "a grant lists every live writer of the promoted diary at its local length" (antes "every counted writer"): a volta agora corta o escritor aposentado, a caminhada o congela, e a concessão nomeia só o vivo.
- `packages/core/test/sync-groups-2.test.js`, 26/26 (94): novo "writers a diary cut froze or released are still fetched past its live slots (#350)". `sync-groups-3` 16/16 (71), `sync-groups-4` 14/14 (73) e `sync-groups-5` 8/8 (19) usam o teto novo (`sync-groups-4` lista 32 + 8 escritores).
- `packages/core/test/group-rekey.test.js`, 16/16 (118): novo "facts: envelopes of a frozen or released writer at or past its cut do not count (#350)". `private-rekey` 10/10 (49).
- `packages/web-member/test/group-ops.test.js`, 61/61 (468): novos "a rejoin at the per-diary cap cuts the retired writer at its length before the new join, and takes its slot (#350)", "a leave names the live writers only, never one a diary cut froze (#350)", "with the frozen reserve spent, a rejoin at the per-diary cap refuses with nothing written (#350)", "a group rejoin after the CW was retired cuts a header-only writer at 0, after its off join (#350)" e "a pending join counts the own diary's slot walk: a cut frees a slot, eight live refuse (#350)".
- `packages/web-member/test/community-ops.test.js`, 73/73 (542): novos "community.join counts the own diary's slot walk, not the CWs held: COMMUNITY_FULL with nothing written (#350)" e "community.join takes a slot a cut freed; community.info counts live and frozen slots, Geral's too (#350)".
- `packages/web-member/test/device-upkeep-ops.test.js`, 31/31 (214): novo "a cut that freezes a writer gives its live slot back to the automatic enrolment (#350)"; o teste do escritor sem caixa que não é trocado sob um CW passa a criar 6 CWs a mais (antes 5), porque o corte agora congela o CW antigo e devolve a vaga.
- `packages/web-member/test/sync-groups-2.test.js`, 28/28 (137): novos "the per-diary cap holds every writer the slot walk counts: 8 live, 8 frozen and 16 released (#350)" e "the own diary scan keeps the cuts: a writer joined after released slots binds its root and is live (#350)" (8 escritores ligados, desligados e cortados em 0, mais um ligado depois: `diaryGroupKeys` devolve o grupo, `liveDiaryWriters` devolve o último, e o controle só com as entradas não devolve nada).
- `packages/web-member/test/sync-diary-roots.test.js`, 9/9 (85): novo "a root the diary binds through a writer joined after released slots is fetched (#350)": ponta a ponta na DHT local, B (outro aparelho de A) adota e busca a raiz de uma comunidade que o diário de A liga por um escritor que entrou depois de 8 liberações. Usa uma sincronização contínua com `lender()`, porque o semeador nunca admite os escritores fantasmas e a página fica incompleta numa sincronização única.
- `apps/app/test/groups.test.js`, 37/37 (554): novo "device slots: the reserve warning and the full refusal follow frozenRoom (#350)". `vitrine.test.js` 42/42 (4004), com as listas de chaves atualizadas.

Também verdes, sozinhos, com o código final: no navegador, `periodic-rekey` 12/12 (92), `private-ops` 24/24 (231), `devices-ops` 8/8 (70), `session-groups` 25/25 (249), `community-devices` 10/10 (47), `page-groups` 7/7 (60), `sync-private` 4/4 (16), `devices-private-e2e` 1/1 (35), `devices-auto-e2e` 1/1 (24), `groups-e2e` 2/2 (94); no app, mais 24 arquivos, entre eles `platformGate` 6/6 (762) e `group-flow` 61/61 (473).

## Prova de regressão

Cada correção foi conferida tirando só ela, de forma temporária (cópia guardada fora do repositório, sem `git stash`), rodando o teste novo sozinho e restaurando o arquivo.

- Nó core, `member.js` sem `retireLocalWriter` e com `boundWriterCount`: `writer-slot-member` teste 1 cai com `limite do grupo atingido`, o 3 passa 4 de 9 asserções, o 4 passa 2 de 4. Os testes 2 e 5 são controles (recusa sem nada gravado; vaga livre).
- Navegador, sem o autocorte: `group-ops` teste "a rejoin at the per-diary cap..." cai com `limite do grupo atingido`; "a group rejoin after the CW was retired..." passa 6 de 10 (faltam a entrada desligada, o corte 0, a ordem e a liberação).
- Navegador, saídas nomeando os congelados (`frozen: true`): "a leave names the live writers only..." cai com `registro inválido: cuts-invalid`.
- Navegador, entrada pendente pela contagem antiga: "a pending join counts the own diary's slot walk..." cai com `limite do grupo atingido`.
- Navegador, `COMMUNITY_FULL` pela contagem antiga: "community.join counts the own diary's slot walk..." passa 1 de 3. Com o `member-ops.js` da base inteiro, "community.join takes a slot a cut freed..." cai com `limite da comunidade atingido`.
- Navegador, `writersBound` pela contagem antiga: "a cut that freezes a writer gives its live slot back..." passa 1 de 3 (0 de 3 com o `member-ops.js` da base inteiro).
- Navegador, teto de sincronização em 8: `sync-groups-2` "the per-diary cap holds every writer..." passa 0 de 4.
- Nó core, teto de sincronização em 8: `sync-groups-2` "writers a diary cut froze or released are still fetched..." passa 8 de 11 (um recusado pelo teto, dois não guardados).
- `epochFacts` sem o corte: `group-rekey` 15/16 (117/118), falha o teste novo.
- Adoção de raízes com `WALK_TYPES` só com `group-join`: `sync-groups-2` "the own diary scan keeps the cuts..." passa 1 de 3, e `sync-diary-roots` "a root the diary binds through a writer joined after released slots..." estoura o tempo em "B adopted L" (4 de 5). Com `liveDiaryWriters` pela regra antiga dos 8 primeiros (e os cortes lidos): o teste de unidade passa 2 de 3 (o escritor tardio não é vivo).
- App, `slotReturn` sempre `legacy`: `groups.test.js` "device slots..." falha 12 asserções. `vitrine/request.js` sem os campos novos: `vitrine.test.js` 37/42.
- Com cada correção de volta, todos passam (contagens acima).

## Decisões tomadas

Escolhas que o roteiro não fixava, com o motivo:

1. Só o escritor deste aparelho recebe o autocorte numa entrada; o de outro aparelho só por `device.disconnect`, porque um aparelho não sabe o comprimento que outro guarda.
2. A entrada pendente do nó core (antes de a raiz chegar) continua sem conferência por diário, como antes deste PR (não havia contagem ali para trocar). A do navegador já conferia e passa à caminhada, com a mensagem `GROUP_FULL` também numa comunidade pendente, como antes.
3. Tetos de sincronização em 32 nos dois nós, pelas entradas provadas mais antigas, e não pela caminhada: uma sincronização nunca lê a caminhada de um diário que pode ter só em parte, e só o próprio diário liga um escritor além da caminhada.
4. A dobra da comunidade do navegador lê as marcas `group-cut`, e a adoção de raízes lê `group-cut` com as entradas; `liveDiaryWriters` subiu para o módulo.
5. A conferência de "atrás" dos CWs próprios do navegador (`ownCwsBehind`) usa a caminhada. `countedCuts` do navegador espelha o do core (6ef7b3ab): congelados só em admissões e rebaixamentos, nunca além do corte do diário.
6. Sem mudança de versão do RPC (motivo acima).
7. App: o aviso decide pela presença de `frozenRoom`; a recusa relê as informações só numa recusa `GROUP_FULL` ou `COMMUNITY_FULL` sem `uncertain`; as duas chamadas de `community.join` em `Comunidade.js` passam pela mesma recusa; telas de comunidade dizem "nesta comunidade".
8. O nó core não informa campos de vaga: ele é um aparelho por diário e não tem a tela que os usa.

## Fica de fora

- O app ainda não tem a tela Aparelhos conectados; os textos já apontam para ela, como pedido no roteiro.
- `community.join` que troca um CW aposentado não grava corte nesta versão (nos dois nós), então esse CW continua ocupando a vaga até um `device.disconnect`.
- O rebaixamento na comunidade do navegador recusa com mais de 8 cortes, enquanto o core apara a lista.
- Leitura esparsa e limpeza no semeador: 8a-3.
