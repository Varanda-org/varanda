# Histórico de grupo mantido quando o diário o apaga (PR `fix/group-records-ignore-deletes`)

Data: 2026-11-16. Árvore conferida: esta branch depois do merge da `main` com o #702.

Decisão: busca uma vez nos diários com registros de grupo.

## O que muda

Regra de leitura: quem lê um grupo ignora o apagamento de `group-join`, `group-confirm` e `group-cut`, então o histórico de participação fica como foi escrito (`docs/protocol.md`, "Deletion"). Um `delete` cujo alvo é um bloco guardado e válido de um desses três tipos não tem efeito: não entra no conjunto apagado e o bloco nunca é limpo do disco, como já acontecia com os registros `page-*`. Uma saída continua valendo depois que o diário apaga a entrada que ela fechou, uma confirmação apagada não muda nada e um corte apagado continua cortando. Os outros tipos de registro se apagam como antes.

Busca uma vez: num diário ligado a grupos, um alvo de `delete` que a réplica não guarda fica no download até ser lido uma vez num par que ainda o tem. Se for `group-join`, `group-confirm` ou `group-cut`, fica e entra na leitura do grupo; se for outra coisa, é limpo em seguida. Um diário é ligado a grupos quando guarda um desses registros (uma entrada `off` também conta) ou quando um grupo ou comunidade que o nó guarda o cita; no semeador, quando ele guarda um desses registros ou um grupo que ele semeia o cita. O download se refaz quando isso só fica claro depois. Os outros diários pessoais continuam sem buscar blocos apagados.

"Uma vez":

- no nó (seguidor do núcleo), entre execuções: um alvo lido que não é desses três tipos, e todo bloco que uma limpeza remove, ficam no conjunto lembrado do núcleo (`varanda/page-read`, até 4096 seqs), e a execução seguinte não os busca de novo;
- no navegador e no semeador, uma vez por execução: eles não carregam esse conjunto para decidir o download, então uma execução seguinte pode buscar o mesmo alvo mais uma vez.

Cortes: só contam os blocos lidos (decisão da manutenção). Um bloco apagado que a réplica nunca leu não abre buraco no histórico de cortes do diário (`groupCutHistory`): não põe o diário em `cutUnknown`, então não segura a rotação periódica, e não muda a regra da raiz do criador. A busca uma vez traz todo bloco apagado que algum par ainda guarda, e um `group-cut` apagado e lido continua cortando. Assim, duas réplicas que guardam os mesmos blocos chegam aos mesmos cortes. Um buraco na sequência lida continua contando como antes.

Semeador: as ligações dos núcleos de grupo contam quantas citam cada diário, então `_groupNames`, perguntado para cada diário que o semeador prepara, é uma consulta e não uma volta por todos os núcleos de grupo.

Passeio de vagas (#350, depois do merge da `main` com o #713): um `group-join` ou `group-cut` apagado entra no passeio como um vivo, na dobra, no `walkHasRoom` do nó e do navegador e na varredura do semeador. Na varredura, um bloco apagado que o semeador não tinha é um buraco; quando a busca uma vez o traz (`_pageArrived`), ele entra na sua posição entre os registros de entrada e corte daquele grupo (`groupEvents`, em ordem de seq), e o passeio do grupo é refeito desde o primeiro registro. Assim o passeio fica igual ao de uma varredura que já tivesse o bloco.

Crescimento dos núcleos de grupo: ao terminar a execução, o nó avisa o crescimento que um núcleo de grupo ativo baixou e ainda não tinha avisado (`flushGroupGrowth`), então um bloco que chega no fim não fica sem o evento de crescimento. Um comprimento já avisado não é avisado de novo quando o ouvinte de crescimento dispara depois para os mesmos blocos.

Limites que ficam (também em `docs/protocol.md`, "Deletion"):

- uma réplica que conhece o `delete` mas não acha nenhum par com o alvo trata o registro como ausente até lê-lo;
- um bloco que nós ou semeadores antigos já limparam não volta; se ninguém o guardou, o registro fica ausente de vez;
- ordem de implantação: o semeador primeiro, porque um semeador com a regra antiga limpa esses blocos e não os serve mais;
- um `group-cut` apagado que nenhum par serve mais fica ausente de vez, como qualquer registro desses três tipos que ninguém guardou.

Onde:

- `packages/core/lib/deletion.js`: `isKeptType` (os `page-*` e os três tipos de grupo) na varredura, em `foldTargets`, `heldKind`, `presentState` e `clearable`; `pageTargets` e `downloadExceptPages` com `groupBound`, `setGroupBound` e `remember`; `clearSeqs` lembra o que limpa, então a execução seguinte não busca de volta um bloco limpo.
- `packages/core/lib/group.js`: o comentário de `groupCutHistory` diz que um bloco apagado nunca lido não é buraco; a função não muda.
- `packages/core/lib/sync.js`: `followRange` com `groupBound` e `remember`; o diário de um grupo já começa ligado, e um seguido passa a ser quando chega um registro de grupo ou um grupo guardado o cita. Uma entrada apagada que o nó não guarda é esperada até o prazo do portão; o escritor só sai da execução (`withdrawn`, sem limpar blocos) se a entrada continuar faltando. `flushGroupGrowth` no fim da execução.
- `packages/core/lib/seeder.js`: diários ligados a grupos buscam uma vez o alvo que não guardam; um `group-join` que chega abaixo do cursor da varredura entra nas ligações do diário.
- `packages/web-member/lib/sync.js`: `trackPresent` com `groupBound` e `setGroupBound`; a leitura de cada bloco que chega passa por `arrivedKind` (o `heldKind` do núcleo); as entradas apagadas do próprio diário que o aparelho não tinha são lidas quando saem do conjunto apagado, então a raiz de uma entrada apagada é adotada.

## Como verificar

```sh
node packages/core/test/deletion.test.js
node packages/core/test/group.test.js
node packages/core/test/group-private.test.js
node packages/core/test/community-fold.test.js
node packages/core/test/seeder-delete.test.js
node packages/core/test/sync-groups-3.test.js
node packages/web-member/test/sync-diary-roots.test.js
node packages/web-member/test/sync-groups-2.test.js
node packages/web-member/test/delete-purge.test.js
npm run lint
```

## Testes novos ou alterados, e o que falha sem a correção

Regra de leitura (sem a correção: os arquivos de `lib` da `main` copiados por cima e depois restaurados, medido na primeira versão desta branch, antes dos merges da `main`):

- `packages/core/test/deletion.test.js`: `deletedSeqs and applyDeletes: a delete of a present group-join, group-confirm or group-cut has no effect` e `clearDeleted never clears a group-join, group-confirm or group-cut block, and presentState reads them back` falham; `foldTargets over the heldKind of each block agrees with deletedSeqs and presentState` para o arquivo (`heldKind is not a function`).
- `packages/core/test/group.test.js`: `a group leave still counts when its diary deletes the join it closed afterwards` e `a group leave still counts when its diary deletes the off join of the leave` falham.
- `packages/core/test/community-fold.test.js`: `a community leave still counts when its diary deletes the join it closed afterwards`, `a deleted group-confirm changes nothing: the creator leave still bounds the root`, `a creator leave still counts after its diary deletes the join it closed` e `a deleted group-cut still cuts: the mark keeps the G root cut after the creator returns` falham.
- `packages/core/test/group-private.test.js`: `a leave still counts for key recipients after its diary deletes the join it closed` falha (confere `entitled` da dobra, que o nó e o navegador leem para escolher quem recebe a chave).
- `packages/core/test/seeder-delete.test.js`: `a deleted group-join that arrives after the scan is folded into the diary bindings` e `a held group-join a tombstone targets never enters the deleted bookkeeping` falham; `a deleted group-join the seeder learns before holding it is fetched once a peer has it, and folded` para o arquivo por tempo esgotado.
- `packages/core/test/sync-groups-3.test.js`: `a writer whose join its author deleted stays bound and downloaded without stalling the run, and the join block is kept` (substitui o teste que esperava a retirada), `a writer whose deleted join arrives after its tombstone still ends up bound, and the join block is kept`, `a join whose tombstone the binding diary learns while the gate runs keeps its writer bound` e `a binding diary keeps the group-confirm, group-cut and off join blocks its author deleted, and clears the deleted post` falham, e o arquivo para no seguinte.

Busca uma vez (sem ela: só a regra de leitura, na primeira versão, com os arquivos de `lib` dessa etapa copiados por cima e depois restaurados):

- `deletion.test.js`: `downloadExceptPages: once the diary is group-bound each deleted target is fetched once, the group record kept and the post cleared` para o arquivo (`guard.setGroupBound is not a function`).
- `seeder-delete.test.js`: o teste do semeador que busca a entrada apagada falha.
- `sync-groups-3.test.js`: `a followed diary that holds a group record fetches an unheld deleted post once and clears it` falha.
- `packages/web-member/test/sync-diary-roots.test.js`: `a second device fetches a deleted join of the own diary it lacked and adopts the root it binds` falha.
- `sync-groups-3.test.js`: `a group diary fetches an unheld deleted off join once and keeps it, so the leave still counts` e `a group diary fetches an unheld deleted post once, clears it and does not fetch it again in the run` passam também sem a busca uma vez: o diário do grupo ainda está vazio quando o download dele começa, então a primeira faixa é linear e traz os alvos antes de os `delete` serem conhecidos. `a followed diary with no group record never fetches an unheld deleted post` confere que um diário pessoal comum continua sem buscar.

Diário de grupo já guardado com escritor ativo (mutações nesta branch antes do merge da `main` com o #702, cada uma desfeita depois):

- `sync-groups-3.test.js`: `a stored group diary whose writer is active fetches an unheld deleted off join and keeps it, and fetches an unheld deleted post once and clears it`. Com `groupBound: false` no `followRange` do diário de grupo, o arquivo para nesse teste (tempo esgotado esperando a entrega dos dois blocos). Com `clearable` recusando qualquer bloco lido, falham esse teste (`the deleted post is cleared`) e os testes 12, 17, 19, 21 e 24 do arquivo. Com `clearable` aceitando os três tipos de grupo, tudo passa: a dobra já ignora o `delete` de um bloco guardado desses tipos, e a recusa em `clearable` é uma segunda camada.
- `sync-groups-3.test.js`: `a listing whose join seq names a deleted post of a plain followed diary leaves that post cleared` passa sem mudança de código; fica como cobertura.

Só contam os blocos lidos (na árvore final; "código anterior" são os arquivos de `lib` do commit anterior desta branch, com o conjunto de não lidos, copiados por cima e depois restaurados):

- `packages/core/test/private-rekey.test.js`: `core: a deleted post of a member diary this node never read does not hold back a due rotation`. Com o código anterior, falha (`the due group rotates`): o diário entrava em `cutUnknown` e a rotação devolvia `cut-unknown`.
- `packages/core/test/group-member.test.js`: `a group fold on the core node reads no gap in the own diary for a deleted post cleared with nothing remembered` (o próprio diário no nó, como no navegador). Com o código anterior, falha (`the own cut history has no gap`).
- `packages/core/test/community-member-leave-5.test.js`: `a deleted post of the creator diary that one replica read and another never did leaves both with the same G root`. Duas réplicas guardam o mesmo diário do criador, uma leu o post apagado e a outra nunca o teve. Com o código anterior, falha (`B reaches the same root cut`).
- `packages/core/test/sync-groups-3.test.js`: `a stored group diary fetches an unheld deleted group-cut a peer still serves, keeps it, and the cut counts`. Com `groupBound: false` no `followRange` do diário de grupo, o arquivo para nesse teste (tempo esgotado). Ele não falha com o código anterior: a busca uma vez já existia, e o teste confere que ela continua.
- `packages/core/test/deletion.test.js`: `clears are remembered: a group-bound download never fetches a cleared block back, after a reopen` e `clears are remembered: clears of several blocks are all kept, none overwrites another`. Sem `clearSeqs` lembrar o que limpa, os dois falham; gravando o conjunto por cima em vez de juntar, falha o segundo.
- `packages/core/test/community-fold.test.js`: `groupCutHistory: a deleted block this replica never read is no gap: only blocks read count` documenta a regra pura e passa também com o código anterior, que só abria o buraco quando quem chamava passava o conjunto.

Crescimento no fim da execução:

- `sync-groups-3.test.js` (antes do merge da `main` com o #702): os testes de diário de grupo conferem agora o comprimento guardado do núcleo do escritor além do evento de crescimento. Sem `flushGroupGrowth`, em 12 execuções do arquivo (3 rodadas de 4 em paralelo), 2 falharam em `a group diary fetches an unheld deleted off join once and keeps it, so the leave still counts`, na asserção do evento (`the listed writer is downloaded`), com o comprimento guardado certo: o bloco tinha chegado e só o evento faltava.

Quem chama não vê buraco para um bloco apagado nunca lido (código anterior como acima):

- `packages/core/test/group-member.test.js`: `a group fold reads no gap in the cut history of a member diary for a deleted block this replica never read`. Com o código anterior, falha (`B's cut history has no gap`).
- `apps/cli/test/pages-groups.test.js`: `pages-groups: a group read reads no gap in the cut history of a member diary for a deleted block the page never read`. Com o código anterior, falha.
- `packages/web-member/test/group-ops.test.js`: `a group fold reads no gap in the cut history of a member diary for a deleted block this replica never read, with or without a memo`. Com o código anterior, falham o caso sem memo e o caso com memo.
- Os três testes também conferem que a dobra leu o histórico daquele diário com o `delete` na entrada, então param de passar se quem chama deixar de ler os cortes dele.

Semeador:

- `packages/core/test/seeder-groups.test.js`: `group bindings count the diaries they name: _groupNames is one lookup, never a walk over every group core`. Com o `_groupNames` anterior (a volta por todas as ligações), o teste falha (`walked every binding`).

Passeio de vagas com registro apagado (depois do merge da `main` com o #713, cada mutação desfeita depois):

- `packages/core/test/group.test.js`: `slot walk: a diary that deletes its own group-cut or group-join keeps the walk as written`. Oito entradas, um corte 0 libera um escritor, um corte 2 congela outro e um nono escritor ocupa a vaga liberada; depois o diário apaga os dois cortes e a entrada de um terceiro. Com `isKeptType` aceitando só os tipos `page-*`, falham `the deletes change nothing in the walk`, `the writer whose join was deleted keeps its slot` e `walkHasRoom answers as before`.
- `packages/core/test/seeder-delete.test.js`: `a deleted group-cut that arrives after the scan steps the slot walk at its seq`. Oito entradas (seq 1 a 8), um corte 0 do primeiro escritor (seq 9, apagado), a entrada de um nono (seq 10); o corte chega por último. Sem refazer o passeio para um registro que chega atrasado (cada registro dado ao passeio como se viesse em ordem), falham `the deleted cut released the first writer` e `the ninth takes the slot it freed`. Com `isKeptType` desligado ele passa: `_pageArrived` confere os tipos de histórico de grupo direto, então o que ele protege é o passeio refeito.

Crescimento avisado uma vez:

- `sync-groups-3.test.js`: os testes de diário de grupo conferem que nenhum comprimento de núcleo de grupo é avisado duas vezes (`no growth is reported twice`). A repetição depende do tempo (o fim da execução e o ouvinte de crescimento disputam o mesmo bloco), então não há teste que falhe sempre sem a correção. Com o aviso anterior (sem descartar um comprimento já avisado), em 12 execuções do arquivo (3 rodadas de 4 em paralelo), 1 falhou em `a writer whose deleted join arrives after its tombstone still ends up bound, and the join block is kept`, na asserção `no growth is reported twice`; as outras 11 passaram.

Ajuste de teste em `packages/web-member/test/delete-purge.test.js`: os quatro testes de falha de leitura do `delete` (`a tombstone whose first read fails is learned on a retry...`, `a tombstone whose reads keep failing stays out of the length...`, `a tombstone whose reads keep failing is retried slowly...`, `a step that throws after a failed tombstone read still retries it on a quiet link`) fazem `reader.get` falhar só quando a pilha passa pela leitura do rastreador. Essa leitura agora se chama `arrivedKind`, não `tombstoneTarget`, então a falha injetada não disparava e os quatro falhavam (32 de 36). A comparação passou a procurar `arrivedKind`. A garantia continua: uma leitura que falha devolve `undefined`, é repetida rápido e depois devagar, e nenhum comprimento cobre o bloco antes de ele ser lido. Conferido por mutação: com `arrivedKind` devolvendo `null` numa falha de leitura, os quatro voltam a falhar, inclusive `no length covered the tombstone before it was learned` e `the length still stops before the unread tombstone`.

Outros:

- `packages/web-member/test/sync-groups-2.test.js`: o teste `a peek never fetches a seq the binding diary knows deleted...` conta só as leituras que podem esperar um par; o diário do grupo, ligado a grupos, busca o post apagado uma vez e o lê de volta localmente.
- `packages/core/test/helpers/groups.js` (`diaryLog()`, um diário em memória com entrada, confirmação, corte e `delete`) e `packages/core/test/helpers/sync-groups.js`.

## Resultados na árvore final (cada arquivo rodado sozinho com `node <arquivo>`, Node 24.22.1)

- `packages/core/test/deletion.test.js`: 65 de 65 testes, 965 de 965 asserções.
- `packages/core/test/group.test.js`: 149 de 149, 998 de 998.
- `packages/core/test/group-private.test.js`: 122 de 122, 845 de 845.
- `packages/core/test/community-fold.test.js`: 115 de 115, 1047 de 1047.
- `packages/core/test/seeder-delete.test.js`: 33 de 33, 281 de 281.
- `packages/core/test/seeder-groups.test.js`: 43 de 43; `seeder-groups-3.test.js`: 6 de 6; `seeder-groups-waits.test.js`: 12 de 12.
- `packages/core/test/sync-groups.test.js`: 16 de 16; `-2`: 25 de 25; `-4`: 14 de 14; `-5`: 8 de 8; `-6`: 1 de 1.
- `packages/core/test/group-rekey.test.js`: 15 de 15; `private-rekey.test.js`: 9 de 9; `member.test.js`: 21 de 21; `store.test.js`: 54 de 54; `record-type-filter.test.js`: 5 de 5.
- `packages/core/test/community-member.test.js`: 25 de 25; `community-member-leave.test.js` e `-2` a `-5`: todos passam.
- `packages/core/test/group-member.test.js` e `-2` a `-6`: todos passam.
- `apps/cli/test/pages-groups.test.js`: 3 de 3, 152 de 152; `apps/cli/test/account-pages-groups.test.js`: 1 de 1, 49 de 49.
- `packages/web-member/test/delete-purge.test.js`: 36 de 36, 245 de 245.
- `packages/web-member/test/sync-diary-roots.test.js`: 9 de 9, 91 de 91.
- `packages/web-member/test/sync-groups.test.js`: 16 de 16; `sync-groups-2.test.js`: 26 de 26; `delete.test.js`: 9 de 9; `group-ops.test.js`: 57 de 57; `periodic-rekey.test.js`: 11 de 11; `page-groups-sync.test.js`: 3 de 3; `sync-no-groups.test.js`: 4 de 4; `sync-page-migrate.test.js`: 7 de 7; `groups-e2e.test.js`: 2 de 2.
- `packages/core/test/sync-groups-3.test.js`: 25 de 25, 133 de 133, rodado sozinho antes do merge da `main` com o #702. O laço de dez rodadas na árvore final fica registrado na descrição do PR.

Depois da revisão (contagem do semeador, crescimento avisado uma vez e testes de quem chama), rodados de novo:

- `packages/core/test/seeder-groups.test.js`: 44 de 44, 270 de 270; `seeder-groups-3.test.js`: 6 de 6; `seeder-groups-waits.test.js`: 12 de 12.
- `packages/core/test/sync-groups.test.js`: 16 de 16; `-2`: 25 de 25; `-4`: 14 de 14; `-5`: 8 de 8; `-6`: 1 de 1.
- `packages/web-member/test/sync-groups.test.js`: 16 de 16; `community-ops.test.js`: 71 de 71; `group-memo.test.js`: 9 de 9.

Depois da decisão de contar só os blocos lidos, cada arquivo sozinho:

- `packages/core/test/deletion.test.js`: 65 de 65, 963 de 963; `group.test.js`: 149 de 149, 998 de 998; `group-private.test.js`: 122 de 122, 845 de 845; `community-fold.test.js`: 115 de 115, 1045 de 1045.
- `packages/core/test/group-rekey.test.js`: 15 de 15, 115 de 115; `private-rekey.test.js`: 10 de 10, 50 de 50; `group-member.test.js`: 12 de 12, 140 de 140; `community-member-leave-5.test.js`: 10 de 10, 85 de 85.
- `packages/core/test/seeder-delete.test.js`: 33 de 33, 281 de 281; `sync-groups-3.test.js`: 26 de 26, 143 de 143.
- `apps/cli/test/pages-groups.test.js`: 4 de 4, 156 de 156.
- `packages/web-member/test/group-ops.test.js`: 58 de 58, 443 de 443; `periodic-rekey.test.js`: 11 de 11, 85 de 85; `delete-purge.test.js`: 36 de 36, 245 de 245; `sync-diary-roots.test.js`: 9 de 9, 91 de 91; `sync-groups-2.test.js`: 26 de 26, 130 de 130.

Depois do merge da `main` com o #713, cada arquivo sozinho:

- `packages/core/test/deletion.test.js`: 65 de 65, 963 de 963; `community-fold.test.js`: 121 de 121, 1111 de 1111; `group-member.test.js`: 15 de 15, 158 de 158; `group-private.test.js`: 127 de 127, 892 de 892; `group.test.js`: 156 de 156, 1306 de 1306.
- `packages/core/test/group-rekey.test.js`: 15 de 15, 115 de 115; `private-rekey.test.js`: 11 de 11, 53 de 53; `devices-member.test.js`: 9 de 9, 77 de 77.
- `packages/core/test/seeder-groups.test.js`: 44 de 44, 270 de 270; `seeder-groups-cuts.test.js`: 11 de 11, 282 de 282; `seeder-delete.test.js`: 34 de 34, 285 de 285; `sync-groups-3.test.js`: 26 de 26, 143 de 143.
- `packages/web-member/test/group-ops.test.js`: 58 de 58, 443 de 443; `private-ops.test.js`: 24 de 24, 231 de 231; `delete-purge.test.js`: 36 de 36, 245 de 245.
- `apps/cli/test/pages-groups.test.js`: 4 de 4, 157 de 157.

`sync-diary-roots.test.js`, teste 9: na rodada de CI falhou uma vez em `B holds R`, e sozinho 1 de 3 vezes (carga perto de 4). O teste parava a sincronização de B no `group-paged` de R, mas a página traz só a lista de escritores; o bloco da raiz baixa depois, pelo portão do grupo. Agora ele espera, com prazo de 40 s, também a cópia de R que a sincronização empresta (`lender`) ter o cabeçalho. Sozinho com `VARANDA_TEST_CONCURRENCY=1`, 5 de 5 rodadas: 9 de 9, 91 de 91 cada (carga entre 2,6 e 3,8).

`npm run lint` passa.

## Fora desta verificação

- `npm test` completo e `npm run demo` não foram rodados aqui.
- Nenhuma conferência em aparelho, simulador ou navegador real.
- O ramo de `markGroupBound` para o próprio diário no navegador não tem teste que falhe sem ele: no teste do navegador, o próprio diário já guarda registros de grupo e fica ligado por eles.
- Num diário pessoal comum seguido, a busca não foi limitada pela dica do índice: o teste `a listing whose join seq names a deleted post...` mostra que o post fica limpo sem isso.