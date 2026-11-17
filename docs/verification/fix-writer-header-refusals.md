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
- `headerStubs(joins, firsts)` monta `heads` a partir do bloco 0 de cada núcleo guardado e do diário que um cabeçalho de escritor desta raiz nomeia. O carregador do nó core (`member.js` `readCoreParts`), os do navegador (`member-ops.js` `foldGroup` e `foldCommunity`) e o do serviço de conta (`pages-groups.js` `partsHeld`) passam `heads`.

Nó core (`packages/core/lib/sync.js`, `store.js`, `admission.js`, `net.js`):

- Portão: com a chave diferente do grupo, os vereditos `header-invalid`, `wrong-group` e `wrong-diary` do bloco 0 (b a e) e o `member` que não bate (a) viram toco quando o diário listado prova a entrada. A prova é a mesma de qualquer escritor (`diaryVerdict`: bloco 0 do diário e o bloco de entrada, do que o nó tem ou pela quarentena), sem ler a caminhada. Sem prova, a listagem fica com o veredito do cabeçalho e a cobrança de antes (`fail(head)`); um diário que não responde até o prazo é `timeout`, cobrado como tal.
- Toco: baixa só `[0, 1)`, a meta quer o bloco 0. Os casos b a e ficam em `header-stubs.json` (`{ key, group, diary }`, no máximo 256), com a vaga do limite por diário sob o par que o provou (`loadDiskSlots`). Com o registro cheio, um toco novo é recusado com `quota`, sem cobrança, e a dobra o espera como antes.
- Um toco cujo cabeçalho nomeia outro par cede à listagem desse par (`givesWay`): sai da tabela sem veredito, com os blocos, e a chave passa pelo portão como escritor dali, baixa inteira e sai do registro. Uma listagem desse par vista enquanto o toco passava pelo portão é testada de novo quando ele é aceito (`rescanGroup`).
- Caminho guardado: um núcleo guardado toma o diário do próprio cabeçalho, salvo quando o registro o nomeia como toco (e o diário do cabeçalho não está condenado aqui). Um núcleo guardado por outro motivo (escritor ou raiz de outro grupo, diário seguido ou de ligação) nunca vira toco: a listagem sai da tabela como antes (I4).
- Partida: `reviewHeaderStubs` mantém um toco enquanto a réplica guardada do diário que o provou ainda tem a entrada e o apaga senão. Uma chave que o nó agora escreve, segue, guarda como diário de ligação de um escritor aceito aqui, ou não guarda mais, só sai do registro, com os blocos. A varredura de legado (`sweepLegacyGroups`, parâmetro `keep`) não apaga um toco registrado.
- O nó anuncia `CAP_HEADER_STUBS = 16` no canal de admissão.

Nó do navegador (`packages/web-member/lib/sync.js`, `node-store.js`, `member-ops.js`):

- Mesmo portão (`HEAD_REASONS`, `memberMismatch`) com `proveGroupJoin`. Sem prova, a entrada falha com o veredito do cabeçalho e `headHint`, então outra listagem da chave ainda passa pelo portão (até `MAX_GATE_HINTS`).
- kv `headerStubs` (no máximo 256), apagado com o núcleo (`purgeGroupCore`) e na troca de identidade (`deleteGroupData`). `givesWay`, `dropHeadStub` e `renoteHeadStub` fazem o que o nó core faz.
- Partida: um toco registrado, e um escritor guardado cujo `member` não bate, ficam só enquanto o diário de ligação guardado prova a entrada (`storedJoinProof`); senão são apagados. A varredura de legado (`purgeLegacyGroupCores`) pula um toco registrado que não está em kv `groupWriters`.
- O nó anuncia `CAP_HEADER_STUBS`.

Serviço de conta (`apps/cli/lib/account/pages-groups.js`):

- `partsHeld` anota o bloco 0 de cada núcleo de escritor que já lê para a raiz (os da Página e os que o semeador lista), com o diário que um cabeçalho de escritor desta raiz nomeia, e passa `headerStubs(joins, firsts)` como `heads`, como `readCoreParts`. Não guarda tocos nem abre outro núcleo.
- O caso que isso fecha: o semeador ainda lista um escritor W sob um diário B cujo certificado o serviço já recusa (o serviço lê a cada chamada as revogações publicadas pela moderação, e o semeador só as segue quando adota o snapshot novo), e outro diário aceito, A, liga W. W não entra em `writers`, porque B não é aceito, e antes a dobra esperava o par (A, W): a leitura do grupo voltava `incomplete` e a entrada de uma Página no grupo respondia `indisponivel`.

Protocolo (`docs/protocol.md`): `CAP_HEADER_STUBS` em "Capabilities"; o cabeçalho do escritor e o texto do `member`; a regra do escritor ausente em `buildGroup` (com `heads`); as regras (1), (3) e (4) de "Bad hints and bounds on memory" e a exceção do navegador; o item (3) de "Released writers whose box does not match"; o novo item "Header stubs", com o carregador do serviço de conta no item (6); as metas de conclusão; `header-stubs.json` e kv `headerStubs` em "Data-dir files"; a exceção na varredura de legado.

## Como verificar

Cada arquivo rodou sozinho, com o código de antes da rodada de revisão 1 (os números com o código final estão na seção dela), no Node 24.22.1: `VARANDA_TEST_CONCURRENCY=1 node <arquivo>`.

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

Serviço de conta (`apps/cli/test/`, depois do merge):

| Arquivo | Testes | Asserções |
|---|---|---|
| `pages-groups.test.js` (teste novo) | 8/8 | 184/184 |
| `pages-groups-sparse.test.js` | 1/1 | 8/8 |
| `account-pages-groups.test.js` | 1/1 | 49/49 |

Depois do merge da `main` (`9d062303`: o conflito foi o bit 8, que a `main` deu a `CAP_PEER_PROOF`), rodaram de novo, sozinhos: no navegador, `sync-groups-4` (5/5, 75/75), `sync-groups-2` (29/29, 139/139), `sync-groups-3` (3/3, 43/43), `sync-gate` (15/15, 126/126), `group-ops` (64/64, 487/487), `private-ops` (24/24, 231/231) e `sync-prove` (11/11, 48/48, da `main`); no nó core, `sync-groups-8` (11/11, 55/55), `admission-caps` (11/11, 50/50), `sync-slots` (8/8, 27/27, da `main`) e `sync-private` (9/9, 44/44). As asserções de `sync-gate` variam com o número de anúncios `have` da corrida (o laço de "have ... covers only stored blocks"): 127 antes, 126 aqui.

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

No serviço de conta, o teste novo de `apps/cli/test/pages-groups.test.js` ("another diary's join of a listed writer whose diary the service refuses ...") monta o caso: o certificado de Bia vem de um emissor que o serviço revoga e o semeador não, o semeador lista o escritor de Bia sob o diário dela, e o diário de Ana liga esse escritor. O teste confere que a leitura do grupo fica inteira, que o post de Bia fica de fora e que a Página entra na comunidade e no grupo.

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

Serviço de conta (`apps/cli/lib/account/pages-groups.js`, `apps/cli/test/pages-groups.test.js`, só o teste novo):

- Antes da correção (o teste rodou sobre o código sem `heads`): as asserções 1 ("the group reads whole") e 4 ("and the group: no join answers indisponivel") falham (2/4). A entrada na comunidade passa: só a dobra do grupo espera o escritor de Bia.
- MS1, `partsHeld` não passa `heads` (`heads = []`): as mesmas asserções 1 e 4 falham (2/4).
- MS2, o bloco 0 dos escritores listados não é anotado (só o dos escritores da Página): as mesmas asserções 1 e 4 falham (2/4).

## Rodada de revisão 1

A revisão do PR pediu as mudanças abaixo, em duas levas. Commits: `6d4d0614` (nó core), `da082e9b` (navegador) e o deste texto.

O que mudou, nos dois nós salvo quando dito:

- Uma raiz que passa pelo portão como raiz do próprio grupo, depois de guardada como toco de outro grupo, sai do registro (antes só um escritor saía). Na partida, um registro sozinho nunca apaga um núcleo que é mais que um toco aqui: a raiz de um grupo de `groups.json` (navegador: kv `groupWriters`), um núcleo com um bloco além do 0 (na rodada 2 esse fica com o registro), ou um escritor de um desses grupos cujo diário do próprio cabeçalho, como guardado, o ligou (`beyondStub`). Esse núcleo só sai do registro, e a partida o lê pelo próprio cabeçalho. Isso também cobre uma falha de `saveHeaderStubs`: um registro que ficou para trás não apaga um núcleo inteiro. A partida do nó core também apaga um toco cujo grupo está bloqueado; a do navegador tira do registro uma chave que o aparelho escreve.
- Nó core: o bloco 0 de uma chave que nunca pode contar para o diário listado fica na memória do processo (`MAX_HEAD_BLOCKS` = 256 chaves, cada bloco até `MAX_BLOCK_BYTES`, o mais antigo sai primeiro), e uma dica nova da mesma chave só prova o diário. No navegador, `MAX_GATE_HINTS` (4) já limita as listagens que passam pelo portão por chave numa execução, então nada mudou ali.
- Nó core: um portão que falha pela listagem (prazo, dica refutada, recusa por veredito deste nó ou pelos dados do próprio escritor) testa de novo, na hora, as listagens da chave sob os outros grupos do nó (`rescanElsewhere`), que esperavam enquanto o portão segurava a chave. Na hora, como `rescanGroup`: numa execução `--once`, um portão que era o último em andamento encerraria a execução antes de um teste adiado.
- O teto do registro: o texto de "Data-dir files" dizia "o mais novo fica", mas nenhum toco sai por um novo, que é recusado como `quota`. Agora um portão reserva a vaga desde a checagem do teto até o registro entrar ou a entrada sair (`stubSlots` no nó core, `ge.stubSlot` no navegador), então portões em andamento nunca registram além do teto.
- Nó core: uma listagem recusada por `quota` com o registro cheio fica numa memória por dica (no máximo 256, o mais antigo sai primeiro) e não passa pelo portão de novo a cada página; quando um toco sai do registro (cede, é apagado ou sai na passagem pelo portão), o grupo dela é testado de novo (`stubSlotFreed`).
- Nó core: todo apagamento do núcleo de um toco tira o registro (`purgeKey`).
- Nó core (mudou na rodada 2: um toco desta execução sai com a listagem, e o bloqueio ou a revogação do par que provou um toco revê o registro na hora): um veredito sobre a listagem de um toco ou sobre o diário que o provou nunca apaga o toco; só um veredito sobre a própria chave apaga (a chave bloqueada, a bifurcação dela, a divergência, a vaga do limite por diário que ele cede, `own: true`). Uma chave que o nó guarda em outro papel (o próprio diário ou um escritor deste aparelho, um diário seguido, um diário de ligação) nunca é apagada por um veredito sobre um núcleo de grupo, salvo bloqueada.
- Navegador: um núcleo guardado antes do portão só vira toco quando kv `headerStubs` o registra; senão fica com o veredito do cabeçalho, como antes. `failGroupEntry` nunca apaga um toco guardado antes desta execução por um veredito sobre a listagem ou o diário, salvo com a própria chave bloqueada.
- Navegador: o cache da caminhada de um diário de ligação sai quando o núcleo dele fecha (`dropWalk`), como no nó core.
- `docs/protocol.md`: as regras (1), (2) e (3) de "Bad hints", o item "Header stubs" (a raiz de outro grupo, a reserva da vaga, os vereditos que apagam, o registro que sai com o núcleo, a partida) e uma frase de compatibilidade: um bloco 0 que esta versão não decodifica conta como (b), então uma versão nova de cabeçalho deixa os escritores dela de fora nos nós antigos até eles atualizarem.
- Navegador (mudou na rodada 2, com a revisão do registro na hora): a varredura dos núcleos guardados depois de um bloqueio (`purgeKeptGroupCores`, de `purgeGroupCoresOf` e `stopBlockedGroup`) deixa um toco registrado para a próxima partida, salvo com a própria chave bloqueada: o bloqueio do diário que o provou ou do grupo da listagem é veredito sobre a listagem.

Testes novos desta rodada, nó core (`packages/core/test/sync-groups-8.test.js`):

- "a group root first held as a stub of another group leaves the record once its own listing gates it, and a record alone never purges it at start": uma execução contínua guarda a raiz R como toco de G, depois a listagem de R como raiz passa pelo portão; R baixa inteira e sai do registro. Depois, um registro escrito à mão nomeando R com um diário que não o prova, e uma partida sem semeador: R fica inteira e o registro sai.
- "at start a record alone never purges a core that is more than a stub here: the core only leaves the record": registros que nomeiam um diário qualquer para a raiz de um grupo de `groups.json`, para um escritor de um grupo que o nó não segue guardado além do bloco 0, e para um escritor que o diário do próprio cabeçalho, guardado, liga. A partida mantém os três e tira os três do registro.
- "a key whose block 0 can never count is read once a run, however many hints list it": quatro diários listam a mesma chave indecodificável, uma dica nova por página; o bloco 0 passa pela quarentena uma vez.
- "a gate that fails for its listing lets the key's listing under another group proceed in the same run": numa execução `--once`, a chave falha sob G e passa pelo portão sob o próprio grupo, baixando inteira, na mesma execução.
- "gates in flight never record header stubs past the cap": com teto 1, dois portões abertos ao mesmo tempo; um toco entra e o outro é recusado como `quota`, uma vez.
- "a header stub refused for a full record is not gated again until a stub leaves the record, and is then held": com teto 1 e o registro cheio, o toco novo é recusado uma vez, não a cada página; quando o toco do registro cede à listagem do próprio grupo e sai do registro, o recusado vira toco.
- "a stub purged for its own key leaves the record, and a restart does not bring it back": o bloqueio da chave do toco apaga o núcleo e o registro, e a partida seguinte não reabre a chave.
- "a verdict on the diary that proved a stub leaves the stub's core in place": o bloqueio do diário que provou o toco tira a listagem, e o bloco 0 do toco fica.

Nó do navegador (`packages/web-member/test/sync-groups-4.test.js`):

- "a group root first held as a stub of another group leaves the record once gated as its root, and a record alone never purges it at start": o mesmo caso do nó core, com a raiz de um grupo que Ana criou, kv `headerStubs` e uma partida sem semeador.
- "a core stored before its gate is a header stub only when kv headerStubs records it": um núcleo guardado, sem registro, fica com o veredito do cabeçalho (`wrong-group`) e não entra no registro.
- "a verdict on the diary that proved a recorded stub leaves the stub's core in place": numa execução contínua, o bloqueio do diário que provou um toco registrado tira a listagem (um veredito `blocked`), e o núcleo do toco fica com o bloco 0.

Cada arquivo tocado rodou sozinho com o código final (`VARANDA_TEST_CONCURRENCY=1 node <arquivo>`, Node 24.22.1). Nó core (`packages/core/test/`):

| Arquivo | Testes | Asserções |
|---|---|---|
| `sync-groups-8.test.js` (testes novos) | 19/19 | 81/81 |
| `sync-groups.test.js` | 16/16 | 75/75 |
| `sync-groups-2.test.js` | 27/27 | 96/96 |
| `sync-groups-3.test.js` | 26/26 | 143/143 |
| `sync-groups-4.test.js` | 14/14 | 73/73 |
| `sync-groups-5.test.js` | 8/8 | 19/19 |
| `sync-groups-6.test.js` | 1/1 | 5/5 |
| `sync-groups-7.test.js` | 1/1 | 12/12 |
| `sync-groups-sparse.test.js` | 2/2 | 20/20 |
| `sync-private.test.js` | 9/9 | 44/44 |
| `sync-communities.test.js` | 7/7 | 37/37 |
| `sync-slots.test.js` | 8/8 | 27/27 |
| `admission-caps.test.js` | 11/11 | 50/50 |

Nó do navegador (`packages/web-member/test/`):

| Arquivo | Testes | Asserções |
|---|---|---|
| `sync-groups-4.test.js` (testes novos) | 8/8 | 123/123 |
| `sync-groups-2.test.js` | 29/29 | 139/139 |
| `sync-groups-3.test.js` | 3/3 | 43/43 |
| `sync-groups.test.js` | 16/16 | 112/112 |
| `sync-groups-sparse.test.js` | 3/3 | 27/27 |
| `sync-private.test.js` | 4/4 | 16/16 |
| `sync-gate.test.js` | 15/15 | 127/127 |
| `community-sync.test.js` | 5/5 | 54/54 |
| `page-groups-sync.test.js` | 3/3 | 26/26 |
| `session-groups.test.js` | 25/25 | 249/249 |
| `groups-e2e.test.js` | 2/2 | 94/94 |
| `private-e2e.test.js` | 2/2 | 85/85 |

`npm run lint` passa. Não rodaram aqui: o `npm test` inteiro e o `npm run demo`.

Prova de regressão desta rodada: cada mutação tira uma parte da correção, roda sozinho o teste que a cobre (`VARANDA_TEST_CONCURRENCY=1`) e volta o código. Todas foram pegas; com o código final, cada teste passa.

Nó core (`packages/core/lib/sync.js`, testes de `sync-groups-8.test.js`):

- C1, uma raiz aceita como raiz do próprio grupo continua no registro (só um escritor sai, como antes): o teste da raiz, a asserção 3 ("and it leaves the record") falha (5/6).
- C2, a partida julga o registro sozinho, sem `beyondStub`: o teste da raiz, a asserção 5 ("the root of a group of groups.json is kept in full") falha (5/6); o teste da partida, as asserções 2, 3 e 4 falham (os três núcleos são apagados).
- C3, sem a memória do bloco 0 (`headBlocks`): o teste da leitura única, a asserção 2 ("block 0 is read once; each later hint proves only its diary") falha (1/2).
- C4, sem `rescanElsewhere`: o teste do portão que falha pela listagem, as asserções 1 e 2 falham (0/2).
- C5, sem a reserva da vaga (`stubSlots`): o teste dos portões em andamento, as asserções 1 e 2 falham (0/2): os dois tocos entram no registro.
- C6, sem a memória da recusa por `quota`: o teste do registro cheio, a asserção 1 ("refused once for the full record, not on every page") falha (2/3).
- C7, um toco que sai do registro não testa de novo o grupo recusado (`stubSlotFreed`): o teste do registro cheio nunca alcança a condição ("tempo esgotado: run condition", saída 1).
- C8, `purgeKey` não tira o registro: o teste do toco apagado, a asserção 2 ("and its record goes with its core") falha (3/4).
- C9, sem a guarda de `failGroupCore`: o teste do veredito sobre o diário, a asserção 2 ("but its block 0 stays") falha (1/2).

Nó do navegador (`packages/web-member/lib/sync.js`, testes de `sync-groups-4.test.js`; os números de asserção contam as do `stubWorld`):

- W1, uma raiz aceita como raiz do próprio grupo continua no registro: o teste da raiz, a asserção 18 ("and it leaves the record") falha (19/20).
- W2, a partida julga o registro sozinho, sem `beyondStub`: o teste da raiz, a asserção 19 ("a core held past block 0 is kept in full") falha (19/20).
- W3, um núcleo guardado sem registro vira toco (sem `headerStubs.has` na regra do cabeçalho): o teste do núcleo guardado antes do portão, as asserções 12 e 13 ("refused with its header's verdict, not made a stub") falham (12/14).
- W4, sem a guarda de `failGroupEntry` para um toco guardado antes da execução: o teste do veredito sobre o diário, as asserções 13 ("but its core stays") e 14 falham (12/14).
- W5, a varredura dos núcleos guardados depois de um bloqueio (`purgeKeptGroupCores`) apaga um toco registrado: o mesmo teste, as asserções 12 ("for the blocked diary that proved it": dois vereditos `blocked`, não um), 13 e 14 falham (11/14). Antes desta correção o teste falhava do mesmo jeito sobre o código da rodada.

Decisões desta rodada e o que ficou sem teste próprio:

- O caso do serviço de conta com o diário bloqueado continua o limite descrito em "Riscos residuais".
- No navegador, a leitura única do bloco 0 (P2-b) não mudou: `MAX_GATE_HINTS` já limita a 4 as listagens de uma chave que passam pelo portão numa execução.
- No navegador, o teste de novo das outras listagens da chave quando um portão falha (P3, item 1) não mudou: um portão sem resposta fica pendente e pergunta de novo (`gateUnanswered`) em vez de falhar, e um portão que falha por uma razão de dica deixa a listagem da chave sob outro grupo passar na próxima página desse grupo (até `MAX_GATE_HINTS`).
- A vaga do limite por diário que um toco cede a um join provado mais cedo é veredito sobre a própria chave (`own: true`) e apaga o toco, como antes.
- Um bloco 0 maior que `MAX_BLOCK_BYTES` não fica na memória `headBlocks`: uma dica nova da chave lê o bloco de novo.
- Sem teste próprio: a regra de `heldElsewhere` (só pesa num veredito sobre a própria chave, como bifurcação, divergência ou a vaga cedida, de uma chave que o nó guarda em outro papel); a reserva da vaga no navegador (`ge.stubSlot`; no nó core o teste dos portões em andamento a cobre, C5); a limpeza do cache da caminhada no navegador (`dropWalk`).

## Rodada de revisão 2

A revisão e a auditoria de `6d4d0614..0dc5e2ae` pediram as mudanças abaixo (itens A a F). Os commits desta rodada são os que vêm depois de `0dc5e2ae`.

O que mudou:

- A, nó core e navegador. Na partida, um bloco além do 0 guardado só impede que o toco seja apagado: o registro fica, e com ele a vaga do limite sob o par que provou o toco (`loadDiskSlots`). Uma listagem de outra chave pode fazer o nó guardar esse bloco, então ele não prova nada. Só a raiz de um grupo de `groups.json` (navegador: kv `groupWriters`) e um escritor que o diário do próprio cabeçalho ligou saem do registro (`beyondStub` devolve `'root'`, `'joined'`, `'held'` ou `false`; `PROVEN_STUB`).
- A, nó core. Quando o diário de uma dica é lido por uma réplica do armazenamento principal (`replicaStored`/`openMain`), o bloco 0 dela é lido e julgado como registro de diário antes do bloco `e.seq`. Um núcleo guardado por outro motivo (um toco, um núcleo de grupo) nunca recebe assim um bloco posterior. Uma dica não é recusada só porque a chave do diário é um toco registrado ou um núcleo de grupo.
- B, nó core. Quando o registro de um toco sai porque a chave passou pelo portão inteira sob outro par, a vaga que ele ocupava no par que o provou sai junto (`leaveRecord`, com `slotFreed`). Na saída de uma vaga guardada pelo limite do par, uma chave aceita aqui sob outro par, guardada em outro papel ou cujo registro não nomeia mais esse par só perde a vaga, sem ser apagada. Os caminhos de `condemnGroupCore` que apagam direto também respeitam `heldElsewhere`.
- C, nó core. `failGroupCore` só poupa um toco guardado em outro papel (`heldElsewhere`) ou guardado antes desta execução (`e.wasStored`); um toco desta execução sai com a listagem e leva o registro (`purgeKey`). Quando um snapshot bloqueia ou revoga um diário ou bloqueia um grupo, cada registro que o nomeia é revisto na hora, como na partida (`reviewStubRecords`): o toco é apagado com o registro, salvo guardado em outro papel, seguido, raiz de um grupo de `groups.json` ou escritor ligado pelo diário do próprio cabeçalho (aí só o registro sai). `groupsAdopted` deixa para essa revisão o toco guardado antes, aceito sob o par do registro.
- C, navegador. `failGroupEntry` ganha `review`: um toco guardado antes desta execução continua poupado por um veredito sobre a listagem, mas não pela revisão do registro. `dropGroupsOfDiary` e `stopBlockedGroup` deixam o toco guardado antes, aceito sob o par do registro, para `reviewStubRecords`, que apaga o toco (ativo, em nova checagem, falho mas guardado, ou em repouso) com o registro, salvo raiz de um grupo de kv `groupWriters` ou escritor ligado pelo diário do cabeçalho (`provenBeyondStub`). `purgeKeptGroupCores` continua deixando um toco registrado para essa revisão.
- D, nó core. A checagem tardia da caixa em `onGroupGate` não vale para um toco (`r.stub`): o toco é guardado pelo bloco 0, nunca pela caixa.
- E, nó core. Um bloco 0 conhecido de uma chave que só pode ser toco é recusado como `quota` antes de ler o diário da dica quando o registro está cheio.
- F, nó core. Teste da regra `heldElsewhere`.
- `docs/protocol.md`, item "Header stubs": a leitura do bloco 0 do diário da dica, os vereditos que apagam um toco desta execução, a revisão do registro no bloqueio ou na revogação, a vaga que sai com o registro, e o bloco além do 0 que mantém o registro.
- Gancho de teste `diskSlotOf(key)` em `inspectHook`.

Testes novos ou mudados, nó core (`packages/core/test/sync-groups-8.test.js`):

- "at start a record alone never purges the root of a listed group or a writer its header's diary joined" (mudou: o núcleo além do bloco 0 saiu deste teste) e "at start a recorded stub holding a block past 0 is not purged, and keeps its record and the slot of the pair that proved it" (A).
- "a listing whose diary is a stub held here never makes this node store a later block of it, and the stub keeps its record and slot across a restart" (A): Ki, toco de (G, Da) cujo cabeçalho nomeia (G, Dv); uma listagem de Z com o diário Ki e seq 1 é recusada, o bloco 1 de Ki nunca é guardado, e depois de reiniciar o registro fica e o 32º escritor de Dv baixa inteiro.
- "a slot a stub record held never purges a core gated here under another pair or held in another role when the cap of the pair that proved it fills" (B): K e KD, tocos de (G, Da); K passa inteiro sob D2 (a vaga de (G, Da) sai na hora) e KD liga X; os 32 escritores de Da não apagam nenhum dos dois.
- "a recorded stub gated as a stub of another pair is never refused when the cap of the pair that proved it fills" (B): K, toco registrado de (G, Da), aceito como toco de (G, Dx); os 32 escritores de Da não o recusam.
- "a block of the diary that proved a stub stored in this run purges the stub with its record" (C, era "a verdict on the diary that proved a stub leaves the stub's core in place").
- "a block of the diary that proved a stub stored before this run purges the stub in the same run" (C).
- "a block of the diary that proved a stub leaves the stub's core in place while it is held here in another role" (F): D2, toco de (G, DX) e diário de ligação de W; o bloqueio de DX tira o toco da tabela, e D2 e W ficam.
- "a stub stays held when its root's visibility is learned while its gate runs" (D).
- "a stub refused for a full record is refused before its diary is read when a new hint lists it" (E).

Navegador (`packages/web-member/test/sync-groups-4.test.js`):

- "a group root first held as a stub of another group leaves the record once gated as its root, and a record alone never purges it at start, where a block past 0 keeps the record" (A, mudou): com um registro escrito à mão e duas partidas sem semeador, a raiz fica inteira e o registro fica.
- "a block of the diary that proved a stub stored in this run purges the stub with its record" (C).
- "a block of the diary that proved a stub stored before this run purges the stub in the same run" (C, era "a verdict on the diary that proved a recorded stub leaves the stub's core in place").

Prova de regressão desta rodada: cada mutação tira uma parte da correção, roda sozinho o teste que a cobre (`VARANDA_TEST_CONCURRENCY=1`) e volta o código.

Nó core:

- A1, um bloco além do 0 tira o registro na partida: o teste do bloco além do 0 falha nas asserções do registro e da vaga, nas duas partidas (4/8).
- A2, o bloco 0 do diário da dica não é julgado antes do bloco `e.seq`: o teste da listagem com o diário Ki falha em "and Ki's block 1 is never stored" (7/8).
- B1, o registro sai e deixa a vaga sob o par que provou o toco: o teste da vaga falha em "K's slot of (G, Da) went with its record when K was gated in full" (6/7).
- B2, a saída de uma vaga guardada apaga o que a ocupa: o teste do toco aceito sob outro par falha em "K is never refused" (3/4).
- B3, `condemnGroupCore` apaga uma chave guardada em outro papel: sozinha não é pega, porque o único caminho que chega lá com essa chave passa antes pela checagem de B2. Com B2 e B3 tiradas juntas, o teste da vaga falha em "KD, the binding diary of X, stays" (5/6).
- C1, `failGroupCore` poupa um toco desta execução: o teste do toco desta execução falha em "the stub leaves the table for its diary" (dois vereditos, 2/3).
- C2a, sem a revisão do registro no bloqueio: o teste do toco guardado antes falha (1/4: o toco fica, com o registro).
- C2b, `groupsAdopted` julga também o toco guardado antes sob o par do registro: o mesmo teste falha em "the stub leaves the table for its diary, once" (3/4).
- D, a checagem tardia da caixa vale para um toco: o teste da visibilidade falha (1/4: o toco é recusado pela caixa).
- E, o diário da dica é lido com o registro cheio: o teste falha em "the new hint's diary is never read" (1/2).
- F, `failGroupCore` apaga uma chave guardada em outro papel: o teste F falha em "but D2, the binding diary of W, stays" (2/4).

Navegador:

- WA1, um bloco além do 0 tira o registro na partida: o teste da raiz falha em "and keeps its record", nas duas partidas (20/22, contando as asserções do `stubWorld`).
- WC1, `failGroupEntry` poupa também um toco desta execução: o teste do toco desta execução falha em "once, for the blocked diary that proved it" (a revisão do registro apaga depois, com um segundo veredito; 11/12).
- WC2, a revisão do registro não apaga um toco guardado antes: o teste do toco guardado antes falha em "it is purged in this run" e "and its record goes with it" (12/14).
- WC3, sem a revisão do registro no bloqueio de um diário: o mesmo teste nunca vê o toco sair da tabela ("tempo esgotado: the stub leaves the table").

Cada arquivo tocado rodou sozinho com o código final (`VARANDA_TEST_CONCURRENCY=1 node <arquivo>`, Node 24.22.1).

Nó core (`packages/core/test/`):

| Arquivo | Testes | Asserções |
|---|---|---|
| `sync-groups-8.test.js` | 27/27 | 122/122 |
| `sync-groups.test.js` | 16/16 | 75/75 |
| `sync-groups-2.test.js` | 27/27 | 96/96 |
| `sync-groups-3.test.js` | 26/26 | 143/143 |
| `sync-groups-4.test.js` | 14/14 | 73/73 |
| `sync-groups-5.test.js` | 8/8 | 19/19 |
| `sync-groups-6.test.js` | 1/1 | 5/5 |
| `sync-groups-7.test.js` | 1/1 | 12/12 |
| `sync-groups-sparse.test.js` | 2/2 | 20/20 |
| `sync-private.test.js` | 9/9 | 44/44 |
| `sync-slots.test.js` | 8/8 | 27/27 |
| `admission-caps.test.js` | 11/11 | 50/50 |

Nó do navegador (`packages/web-member/test/`):

| Arquivo | Testes | Asserções |
|---|---|---|
| `sync-groups-4.test.js` | 9/9 | 137/137 |
| `sync-groups.test.js` | 16/16 | 112/112 |
| `sync-groups-2.test.js` | 29/29 | 139/139 |
| `sync-groups-3.test.js` | 3/3 | 43/43 |
| `sync-groups-sparse.test.js` | 3/3 | 27/27 |
| `sync-gate.test.js` | 15/15 | 126/126 |
| `sync-private.test.js` | 4/4 | 16/16 |
| `session-groups.test.js` | 25/25 | 249/249 |
| `groups-e2e.test.js` | 2/2 | 94/94 |
| `private-e2e.test.js` | 2/2 | 85/85 |

`npm test` e `npm run demo` não rodaram nesta rodada (ficam para a CI da integração).

Decisões desta rodada e o que ficou sem teste próprio:

- No navegador, os núcleos de grupo ficam guardados à parte dos diários, então apagar o núcleo de grupo de um toco nunca toca a réplica do diário de mesma chave; não há guarda `heldElsewhere` ali. Um teste com a chave de um diário de ligação listada também como toco não chegou a montar o caso no navegador (o escritor saiu com `diary-unavailable`), e ficou de fora.
- No navegador, a revisão do registro julga um toco em repouso como toco (sem ler o bloco 0 dele), e uma entrada pendente (sem núcleo aberto) fica para a próxima partida, que apaga o toco de um diário bloqueado.
- Nenhum caminho do navegador guarda um bloco além do 0 de um toco a partir da listagem de outra chave (os diários das dicas são lidos por `lendCore`); a mudança A1 ali só acompanha o nó core.

## Decisões tomadas aqui

- Todas as recusas de cabeçalho entram neste PR (escolha do mantenedor): os casos a até e, nos dois nós.
- Custo limitado pelos tetos que já existem: provar a entrada de um toco custa o mesmo que provar a de qualquer escritor (bloco 0 do diário e o bloco de entrada, do que o nó tem ou pela quarentena), sem leitura da caminhada e sem outra leitura de diário. O registro tem teto de 256.
- Só um bloco 0 verificado chega à regra: ele é assinado pela chave do escritor e buscado contra a árvore assinada, e a entrada é um bloco assinado do próprio diário. Um par só consegue fazer um escritor parecer descartado para um diário que de fato ligou uma chave cujo bloco 0 não nomeia esse diário; um escritor cujo cabeçalho nomeia G e D nunca é descartado para (D, W), e um toco que nomeia outro par cede à listagem desse par.
- Um `timeout` continua `timeout`: uma listagem sob um diário que ninguém serve espera o prazo do portão e é cobrada como timeout (`MAX_TIMEOUT_HINTS`), no lugar da recusa imediata de antes (`wrong-diary` ou `header-invalid`). É o mesmo custo de uma listagem de aparência honesta sob um diário inalcançável. Os testes antigos que listavam lixo sob um diário aleatório passaram a listar sob um diário servido cuja entrada não nomeia o escritor, para manter o que provam (a cobrança e o corte do semeador): `packages/core/test/sync-groups.test.js` (teste 2), `sync-groups-4.test.js` (testes 8 e 9), `sync-groups-5.test.js` (teste 5) e `packages/web-member/test/sync-groups-2.test.js` (testes 1 e 3).
- No nó core, um núcleo guardado só vira toco quando `header-stubs.json` o nomeia: um núcleo guardado por outro motivo deixa a tabela como antes (I4), e um núcleo guardado continua tomando o diário do próprio cabeçalho (MG10, MG13).
- A revisão da partida erra para o lado de manter: `groupCerts` pode ainda ter diários antigos quando ela roda (`pruneGroupCerts` roda depois, em `loadDiskSlots`), e uma chave ali só sai do registro, sem apagar.
- O toco do caso (a) não é registrado: o cabeçalho nomeia o próprio par, então a partida o julga pelo diário que o cabeçalho nomeia, como qualquer escritor guardado.
- A capacidade só é anunciada. Nenhum semeador a lê; o próximo PR faz o semeador listar tocos só para quem anuncia o bit.
- O bit é 16: a `main` deu o 8 a `CAP_PEER_PROOF` (#738) antes do merge, e membro e semeador usam o mesmo espaço de bits no canal, então cada capacidade tem o seu.
- O serviço de conta monta `heads` só com os núcleos que já lê, sem registro de tocos. O semeador local só lista escritores que passaram pelo veredito dele, então os casos b a e não chegam por ele. O caso (a), e um escritor cujo cabeçalho nomeia um diário que o serviço aceita, já entram inteiros em `writers`, e a dobra decide o par do outro diário pelo bloco 0 dessa cópia. Sobra o escritor listado sob um diário que o serviço recusa e o semeador ainda aceita, que é o caso coberto.
- Asserções antigas que mudaram para a nova regra: em `packages/core/test/group.test.js`, um escritor e um CW com só um bloco 0 inválido não são mais esperados (`incomplete` passa a `false`); em `packages/core/test/sync-private.test.js`, o teste 7 (o escritor recusado pelo `member` não era testado de novo quando o diário o liberava) virou "a writer refused for its member is held as a stub, block 0 alone, once its diary's join is proven"; em `packages/core/test/sync-communities.test.js`, o teste 6 (um escritor com `member` sob uma comunidade era recusado) passou a esperar o toco.

## Riscos residuais e pontos em aberto

- Hoje só o caso (a) chega de um semeador: o semeador recusa b a e na admissão. Esses casos valem quando outro par os lista, e passam a valer de ponta a ponta com o próximo PR do semeador.
- O registro cheio tem teste com o teto em 1 (`maxHeaderStubs`, rodada de revisão 1), não com 256 tocos, que exigiria 256 tocos num teste de rede.
- No navegador, a listagem do par do cabeçalho vista enquanto o toco passava pelo portão (`renoteHeadStub`) não tem teste próprio; no nó core o caso tem teste (MG6).
- No navegador, um escritor que passa pelo portão antes de o tipo da raiz ser conhecido não é julgado pelo `member` e baixa inteiro; a dobra o rejeita do mesmo jeito. Já era assim antes desta branch.
- Lixo listado sob um diário que nenhum par serve agora espera o prazo do portão (15 s) antes de ser cobrado como timeout.
- No serviço de conta, o bloco 0 só vem de um escritor que o semeador local ainda lista e que o serviço lê. Um escritor listado sob um diário que o serviço bloqueia não é aberto (sai com o diário), e um que o semeador deixou de listar, depois de adotar o bloqueio ou a revogação, não é lido. A entrada de outro diário para ele continua deixando a dobra parcial ali, como a de qualquer escritor que nenhum semeador lista (sem mudança).
- Uma caixa que não bate num escritor com corte maior que 0 continua esperada, como antes (fora do escopo).
- `heldCatalogue` não mudou.
- A política de cobrança de tocos listados por semeadores que anunciam o bit fica para o próximo PR.
