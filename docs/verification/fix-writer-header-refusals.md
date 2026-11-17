# Escritores cujo cabeçalho nunca conta guardados como tocos (branch fix/writer-header-refusals)

Parte da #350, sobre `fix/released-boxless-writer` (PR #742) a partir de `1286d829`. Sem mudança de RPC nem de Termos; `docs/protocol.md` ganha a capacidade `CAP_HEADER_STUBS` (seção 5), o item "Header stubs" em "Member sync" (seção 10) e os ajustes nos itens que ele toca.

## O que mudou

O caso: um escritor W que um diário D liga (uma entrada `on: true` de D para W), mas cujo bloco 0, assinado pela chave de W, nunca pode contar para D. A dobra espera esse escritor enquanto não o tem, e as duas sincronizações o recusavam antes de guardá-lo, então um leitor ficava com a dobra `incomplete` para sempre. Os casos:

- (a) o `member` não bate com o tipo do núcleo (nulo num escritor de grupo, ou preenchido num CW), em qualquer corte;
- (b) o bloco 0 não decodifica ou não é um cabeçalho de escritor válido;
- (c) o cabeçalho é antigo (`v: 1`);
- (d) o cabeçalho nomeia outro grupo;
- (e) o cabeçalho nomeia outro diário, não o que o ligou.

Dobra (`packages/core/lib/group.js`):

- `bindCores` aceita `heads` (`[{ key, entries }]`): o bloco 0 sozinho de um núcleo guardado que um diário ligou e cujo cabeçalho não nomeia esse diário. Esse bloco entra na junção com as outras cópias do núcleo (um bloco 0 diferente é bifurcação) e não conta nenhum escritor.
- Um par (D, W) da caminhada não é mais esperado quando o bloco 0 de W, de qualquer cópia, não é cabeçalho de escritor válido ou nomeia outro grupo ou outro diário que não D. O bloco 0 é assinado pela chave de W, então nenhuma cópia faz um escritor cujo cabeçalho conta para (D, W) parecer descartado ali.
- O `member` que não bate passou para antes da checagem da caixa: rejeita o escritor em qualquer corte, com a caixa batendo ou não.
- `headerStubs(joins, firsts)` monta `heads` a partir do bloco 0 de cada núcleo guardado e do diário que um cabeçalho de escritor desta raiz nomeia. O carregador do nó core (`member.js` `readCoreParts`) e os do navegador (`member-ops.js` `foldGroup` e `foldCommunity`) passam `heads`.

Nó core (`packages/core/lib/sync.js`, `store.js`, `admission.js`, `net.js`):

- Portão: com a chave diferente do grupo, os vereditos `header-invalid`, `wrong-group` e `wrong-diary` do bloco 0 (b a e) e o `member` que não bate (a) viram toco quando o diário listado prova a entrada. A prova é a mesma de qualquer escritor (`diaryVerdict`: bloco 0 do diário e o bloco de entrada, do que o nó tem ou pela quarentena), sem ler a caminhada. Sem prova, a listagem fica com o veredito do cabeçalho e a cobrança de antes (`fail(head)`); um diário que não responde até o prazo é `timeout`, cobrado como tal.
- Toco: baixa só `[0, 1)`, a meta quer o bloco 0. Os casos b a e ficam em `header-stubs.json` (`{ key, group, diary }`, no máximo 256, o mais novo fica), com a vaga do limite por diário sob o par que o provou (`loadDiskSlots`). Com o registro cheio, um toco novo é recusado com `quota`, sem cobrança, e a dobra o espera como antes.
- Um toco cujo cabeçalho nomeia outro par cede à listagem desse par (`givesWay`): sai da tabela sem veredito, com os blocos, e a chave passa pelo portão como escritor dali, baixa inteira e sai do registro. Uma listagem desse par vista enquanto o toco passava pelo portão é testada de novo quando ele é aceito (`rescanGroup`).
- Caminho guardado: um núcleo guardado toma o diário do próprio cabeçalho, salvo quando o registro o nomeia como toco (e o diário do cabeçalho não está condenado aqui). Um núcleo guardado por outro motivo (escritor ou raiz de outro grupo, diário seguido ou de ligação) nunca vira toco: a listagem sai da tabela como antes (I4).
- Partida: `reviewHeaderStubs` mantém um toco enquanto a réplica guardada do diário que o provou ainda tem a entrada e o apaga senão. Uma chave que o nó agora escreve, segue, guarda como diário de ligação de um escritor aceito aqui, ou não guarda mais, só sai do registro, com os blocos. A varredura de legado (`sweepLegacyGroups`, parâmetro `keep`) não apaga um toco registrado.
- O nó anuncia `CAP_HEADER_STUBS = 8` no canal de admissão.

Nó do navegador (`packages/web-member/lib/sync.js`, `node-store.js`, `member-ops.js`):

- Mesmo portão (`HEAD_REASONS`, `memberMismatch`) com `proveGroupJoin`. Sem prova, a entrada falha com o veredito do cabeçalho e `headHint`, então outra listagem da chave ainda passa pelo portão (até `MAX_GATE_HINTS`).
- kv `headerStubs` (no máximo 256), apagado com o núcleo (`purgeGroupCore`) e na troca de identidade (`deleteGroupData`). `givesWay`, `dropHeadStub` e `renoteHeadStub` fazem o que o nó core faz.
- Partida: um toco registrado, e um escritor guardado cujo `member` não bate, ficam só enquanto o diário de ligação guardado prova a entrada (`storedJoinProof`); senão são apagados. A varredura de legado (`purgeLegacyGroupCores`) pula um toco registrado que não está em kv `groupWriters`.
- O nó anuncia `CAP_HEADER_STUBS`.

Protocolo (`docs/protocol.md`): `CAP_HEADER_STUBS` em "Capabilities"; o cabeçalho do escritor e o texto do `member`; a regra do escritor ausente em `buildGroup` (com `heads`); as regras (1), (3) e (4) de "Bad hints and bounds on memory" e a exceção do navegador; o item (3) de "Released writers whose box does not match"; o novo item "Header stubs"; as metas de conclusão; `header-stubs.json` e kv `headerStubs` em "Data-dir files"; a exceção na varredura de legado.

## Como verificar

Cada arquivo rodou sozinho, com o código final, no Node 24.22.1: `VARANDA_TEST_CONCURRENCY=1 node <arquivo>`.

Nó core (`packages/core/test/`):

| Arquivo | Testes | Asserções |
|---|---|---|
| `sync-groups-8.test.js` (novo) | 11/11 | 55/55 |
| `sync-groups-4.test.js` | 14/14 | 73/73 |
| `sync-private.test.js` | 9/9 | 44/44 |
| `sync-groups.test.js` | 16/16 | 75/75 |
| `sync-groups-2.test.js` | 27/27 | 96/96 |
| `sync-groups-3.test.js` | 26/26 | 143/143 |
| `sync-groups-5.test.js` | 8/8 | 19/19 |
| `sync-groups-6.test.js` | 1/1 | 5/5 |
| `sync-groups-7.test.js` | 1/1 | 12/12 |
| `sync-groups-sparse.test.js` | 2/2 | 20/20 |
| `sync-communities.test.js` | 7/7 | 37/37 |
| `group.test.js` | 159/159 | 1324/1324 |
| `group-private.test.js` | 130/130 | 927/927 |
| `community-fold.test.js` | 121/121 | 1111/1111 |
| `community-member.test.js` | 25/25 | 262/262 |
| `group-member.test.js` | 15/15 | 158/158 |
| `group-member-2.test.js` | 10/10 | 53/53 |
| `admission-caps.test.js` | 11/11 | 50/50 |
| `private-rekey.test.js` | 11/11 | 53/53 |

Nó do navegador (`packages/web-member/test/`):

| Arquivo | Testes | Asserções |
|---|---|---|
| `sync-groups-4.test.js` (novo) | 5/5 | 75/75 |
| `sync-groups-2.test.js` | 29/29 | 139/139 |
| `sync-groups-3.test.js` | 3/3 | 43/43 |
| `sync-groups.test.js` | 16/16 | 112/112 |
| `sync-groups-sparse.test.js` | 3/3 | 27/27 |
| `sync-private.test.js` | 4/4 | 16/16 |
| `sync-gate.test.js` | 15/15 | 127/127 |
| `community-sync.test.js` | 5/5 | 54/54 |
| `group-ops.test.js` | 64/64 | 487/487 |
| `private-ops.test.js` | 24/24 | 231/231 |
| `community-ops.test.js` | 77/77 | 564/564 |
| `group-seen.test.js` | 10/10 | 75/75 |
| `notices-link.test.js` | 7/7 | 43/43 |
| `session-groups.test.js` | 25/25 | 249/249 |
| `periodic-rekey.test.js` | 12/12 | 92/92 |
| `page-groups-sync.test.js` | 3/3 | 26/26 |
| `groups-e2e.test.js` | 2/2 | 94/94 |
| `private-e2e.test.js` | 2/2 | 85/85 |

`npm run lint` passa. Não rodaram aqui: o `npm test` inteiro e o `npm run demo`.

Os testes novos cobrem os casos a até e nos dois nós. No nó core, `sync-groups-8.test.js` cobre:

- o toco de cada caso b a e, com a dobra completa e o registro;
- a listagem sem prova, com o veredito e a cobrança;
- a segunda listagem que prova;
- a corrida `--once` entre dois semeadores;
- a cessão ao outro grupo e ao outro diário;
- a releitura (`rescanGroup`);
- a partida, que mantém um toco provado e apaga um sem prova;
- o toco que virou diário de ligação;
- as vagas depois da partida;
- o bit.

`sync-private.test.js` cobre o caso (a), dobrado e ao vivo (blocos depois do 0 no semeador, só o bloco 0 baixado, os posts nunca contam), e `group-private.test.js` cobre a regra da dobra. No navegador, `sync-groups-4.test.js` cobre:

- os casos a até e, com a partida;
- a listagem sem prova, que vira toco quando outra prova;
- a cessão ao outro diário;
- o bit;
- a troca de identidade.

## Prova de regressão

Cada mutação tira uma parte da correção, roda o teste que a cobre sozinho e volta o código. Todas foram pegas.

Dobra (`packages/core/lib/group.js`, `group-private.test.js`, "a writer whose held block 0 cannot count for the diary that bound it is never awaited"):

- MF1, o laço final ignora `heads`: as asserções 8, 10, 12, 14, 16 e 18 falham (indecodificável, inválido, antigo, outro grupo, outro diário, blocos extras), 17/23.
- MF2, o `member` só é checado quando a caixa bate (a ordem antiga): a asserção 5 ("member mismatch, box does not match either") falha, 22/23.

Carregador (`packages/core/lib/member.js`):

- ML1, `readCoreParts` não passa `heads`: `sync-groups-8` teste 1, a asserção 22 ("the fold no longer waits for them") falha, 22/23.

Portão e registro do nó core (`packages/core/lib/sync.js`, `store.js`):

- MG1, `headRefusal` sempre falso (recusa como antes): `sync-groups-8` teste 1, as asserções 2-4, 6-8, 10-12, 14-16, 18-20 e 22 falham, 7/23.
- MG2, o `member` que não bate é recusado como antes: `sync-private` teste 7, as asserções 1, 3 e 5 falham; no teste ao vivo, as 2, 3 e 5 (5/11).
- MG3, o veredito de um toco sem prova é julgado como do próprio escritor: no teste `--once` de `sync-groups-8`, a asserção 2 falha (1/2).
- MG4, o toco sem prova não é cobrado: `sync-groups-8` teste 2, os vereditos ficam `timeout` e o semeador nunca é cortado, asserções 1-29 e 31 falham (1/31).
- MG5, `givesWay` sempre falso: `sync-groups-8` teste 5, as asserções 3 e 4 falham; o teste 6 nunca alcança a condição ("tempo esgotado: run condition", saída 1).
- MG6, sem releitura depois de guardar um toco: o teste da listagem vista enquanto o toco passava pelo portão, as asserções 2 e 3 falham (1/3).
- MG7, `loadDiskSlots` ignora `header-stubs.json`: o teste das vagas depois da partida, as asserções 2 e 3 falham (1/3).
- MG8, a partida nunca apaga: o teste da partida, as asserções 4 e 7 falham (5/7).
- MG9, a varredura de legado ignora os tocos registrados (`store.js`): o teste da partida, as asserções 3 e 7 falham (5/7).
- MG10, um núcleo guardado volta a tomar o diário do próprio cabeçalho mesmo registrado como toco: a asserção 5 do teste da partida falha (6/7).
- MG11, o registro não sai quando o núcleo passa pelo portão como escritor do próprio par: `sync-groups-8` testes 5 e 6, a asserção "and no longer recorded as a stub" falha em cada um.
- MG12, o toco nunca é registrado: `sync-groups-8` teste 1, as asserções 4, 8, 12, 16 e 20 falham; o teste da partida, as 2, 3, 4 e 7 (21/30).
- MG13, um núcleo guardado sem registro vira toco: `sync-groups.test.js` teste 14 ("a page item naming a stored core that is no writer of the group leaves it untouched"), a asserção 3 falha (5/6).
- MG14, a partida apaga o toco que virou diário de ligação: a asserção 5 desse teste falha (4/5).
- MC1, o nó core não anuncia o bit: "a member announces that it holds header stubs", 0/1.

Nó do navegador (`packages/web-member/test/sync-groups-4.test.js`, só o teste citado):

- WG1, o toco nunca se forma (`HEAD_REASONS` ignorado): no teste 1, as asserções 11 a 25, 29 e 32 a 35, entre outras, falham.
- WG2, o `member` que não bate é recusado como antes: teste 1, as asserções 26, 27, 29 e 40 falham (39/44).
- WG3, a listagem sem prova não fica como dica (`headHint` ignorado): o teste 2 nunca alcança "the proven listing makes it a stub" (tempo esgotado, saída 1).
- WG4, `givesWay` sempre falso: o teste 3 nunca alcança "fetched in full once listed with B" (tempo esgotado, saída 1).
- WG5, o toco aceito não vai para kv `headerStubs`: teste 1, as asserções 13, 16, 19, 22, 25, 36, 39, 42 e 44 falham (35/44).
- WG6, os tocos registrados não são carregados na partida: teste 1, as asserções 39, 42 e 43 falham (41/44).
- WG7, a partida mantém todo toco registrado, provado ou não: teste 1, as asserções 42 e 43 falham (42/44).
- WG8, a varredura de legado ignora os tocos registrados (`node-store.js`): teste 1, a asserção 36 ("legacy: kept, never refused") falha (43/44).
- WG10, `foldGroup` não passa `heads` (`member-ops.js`): teste 1, a asserção 29 ("the fold no longer waits for them") falha (43/44).
- WC1, o nó do navegador não anuncia o bit: teste 4, a asserção 2 falha (1/2).
- WR1, a troca de identidade não apaga kv `headerStubs` (`deleteGroupData`): teste 5, a asserção 2 falha (1/2).

## Decisões tomadas aqui

- Todas as recusas de cabeçalho entram neste PR (escolha do mantenedor): os casos a até e, nos dois nós.
- Custo limitado pelos tetos que já existem: provar a entrada de um toco custa o mesmo que provar a de qualquer escritor (bloco 0 do diário e o bloco de entrada, do que o nó tem ou pela quarentena), sem leitura da caminhada e sem outra leitura de diário. O registro tem teto de 256.
- Só um bloco 0 verificado chega à regra: ele é assinado pela chave do escritor e buscado contra a árvore assinada, e a entrada é um bloco assinado do próprio diário. Um par só consegue fazer um escritor parecer descartado para um diário que de fato ligou uma chave cujo bloco 0 não nomeia esse diário; um escritor cujo cabeçalho nomeia G e D nunca é descartado para (D, W), e um toco que nomeia outro par cede à listagem desse par.
- Um `timeout` continua `timeout`: uma listagem sob um diário que ninguém serve espera o prazo do portão e é cobrada como timeout (`MAX_TIMEOUT_HINTS`), no lugar da recusa imediata de antes (`wrong-diary` ou `header-invalid`). É o mesmo custo de uma listagem de aparência honesta sob um diário inalcançável. Os testes antigos que listavam lixo sob um diário aleatório passaram a listar sob um diário servido cuja entrada não nomeia o escritor, para manter o que provam (a cobrança e o corte do semeador): `packages/core/test/sync-groups.test.js` (teste 2), `sync-groups-4.test.js` (testes 8 e 9), `sync-groups-5.test.js` (teste 5) e `packages/web-member/test/sync-groups-2.test.js` (testes 1 e 3).
- No nó core, um núcleo guardado só vira toco quando `header-stubs.json` o nomeia: um núcleo guardado por outro motivo deixa a tabela como antes (I4), e um núcleo guardado continua tomando o diário do próprio cabeçalho (MG10, MG13).
- A revisão da partida erra para o lado de manter: `groupCerts` pode ainda ter diários antigos quando ela roda (`pruneGroupCerts` roda depois, em `loadDiskSlots`), e uma chave ali só sai do registro, sem apagar.
- O toco do caso (a) não é registrado: o cabeçalho nomeia o próprio par, então a partida o julga pelo diário que o cabeçalho nomeia, como qualquer escritor guardado.
- A capacidade só é anunciada. Nenhum semeador a lê; o próximo PR faz o semeador listar tocos só para quem anuncia o bit.
- Asserções antigas que mudaram para a nova regra: em `packages/core/test/group.test.js`, um escritor e um CW com só um bloco 0 inválido não são mais esperados (`incomplete` passa a `false`); em `packages/core/test/sync-private.test.js`, o teste 7 (o escritor recusado pelo `member` não era testado de novo quando o diário o liberava) virou "a writer refused for its member is held as a stub, block 0 alone, once its diary's join is proven"; em `packages/core/test/sync-communities.test.js`, o teste 6 (um escritor com `member` sob uma comunidade era recusado) passou a esperar o toco.

## Riscos residuais e pontos em aberto

- Hoje só o caso (a) chega de um semeador: o semeador recusa b a e na admissão. Esses casos valem quando outro par os lista, e passam a valer de ponta a ponta com o próximo PR do semeador.
- O registro cheio (`quota` com 256 tocos) não tem teste: exigiria 256 tocos num teste de rede. Pela leitura do código, o toco novo é recusado sem cobrança e a dobra o espera como antes.
- No navegador, a listagem do par do cabeçalho vista enquanto o toco passava pelo portão (`renoteHeadStub`) não tem teste próprio; no nó core o caso tem teste (MG6).
- No navegador, um escritor que passa pelo portão antes de o tipo da raiz ser conhecido não é julgado pelo `member` e baixa inteiro; a dobra o rejeita do mesmo jeito. Já era assim antes desta branch.
- Lixo listado sob um diário que nenhum par serve agora espera o prazo do portão (15 s) antes de ser cobrado como timeout.
- O carregador do serviço de conta (`apps/cli/lib/account/pages-groups.js`) não passa `heads`: uma Página com um escritor desses continua parcial ali.
- Uma caixa que não bate num escritor com corte maior que 0 continua esperada, como antes (fora do escopo).
- `heldCatalogue` não mudou.
- A política de cobrança de tocos listados por semeadores que anunciam o bit fica para o próximo PR.
