# Tocos de cabeçalho no semeador (branch fix/seeder-header-stubs)

Parte da #350, depois do #768 (o PR do leitor, `fix/writer-header-refusals`, já na `main`). Sem mudança de RPC nem de Termos; `docs/protocol.md` descreve a regra.

## O que mudou

Semeador (`packages/core/lib/seeder.js`):

- Um escritor K que o diário D liga ao grupo G, cujo bloco 0 nunca pode contar para (G, D) (não decodifica, não é cabeçalho de escritor válido, é `v: 1`, nomeia outro grupo ou outro diário), deixa de ser recusado: vira um toco, uma linha (G, K) em `admitted.json` (`headerStubs`) e só o bloco 0 de K em `store/`, salvo quando K já está guardado em outro papel. Nunca uma raiz, nunca um bloco 0 que é certificado de membro ou cabeçalho de mídia, nunca um bloco acima de `MAX_BLOCK_BYTES`. Uma caixa que não bate continua recusa.
- Limites: 8 linhas por diário e 256 no total (opção `maxHeaderStubs`). Além deles a entrada é recusada com `stub-full`, sem tirar ninguém.
- A linha sai quando a varredura de D não lista mais K para G, quando D sai (`drop`), quando D, G ou K é bloqueado, ou quando K bifurca; o bloco é apagado antes de a linha sair, se nenhuma outra linha ou papel precisa dele. Quando a ligação do próprio K é admitida, K vira escritor comum e a linha fica.
- O canal de grupos lista os tocos (`{ key, diary, length: 1, seq }`) só para quem anuncia `CAP_HEADER_STUBS`; os outros recebem as páginas de antes. `/index/group` não muda.
- Eventos: `group-header-stub`, `group-header-stub-dropped`.

Nó core (`packages/core/lib/sync.js`):

- A listagem de um núcleo que este nó já guarda em outro papel (raiz de outro grupo, diário seguido, escritor de outro grupo), sob um par para o qual o cabeçalho nunca conta, é pulada na execução e não é mais cobrada do semeador (`fail(..., local)` no caminho guardado e `r.local !== true` na cobrança de `onGroupGate`). Antes, um semeador que listasse 32 tocos desse tipo era cortado.

Protocolo (`docs/protocol.md`): `store/` e `admitted.json` (seção 1); `CAP_HEADER_STUBS` (seção 5); `seed drop`; `headerStubs` no arquivo do semeador, o passo (3) de "Writer W", o novo item "Header stubs", a resposta `writers` (seção 10); em "Bad hints", a regra (4) e a frase do navegador (o navegador não cobra nenhum semeador); a última frase de "Header stubs" do membro.

## Testes

Nó core, cada arquivo sozinho (`VARANDA_TEST_CONCURRENCY=1 node <arquivo>`), Node 24.22.1:

- `packages/core/test/sync-groups-8.test.js`, teste novo "cores already stored here in another role ...": 33 núcleos guardados pelo membro (11 raízes de outros grupos, 11 diários seguidos, 11 escritores de outros grupos), cada um ligado a G pelo diário listado; cada um sai com `group-skipped` e o veredito do cabeçalho, continua guardado, não vira toco, e o semeador não é cortado. O teste que já existia, com a entrada não provada, continua cortando o semeador.
- `packages/core/test/seeder-header-stubs-e2e.test.js` (novo): semeador real e `runSync`; o autor de Kb nunca fica ao alcance do leitor. O leitor recebe o toco, guarda só o bloco 0, anota Kb com o diário que o ligou, não recusa a listagem, não corta o semeador, e a leitura do grupo não fica incompleta.
- `packages/core/test/helpers/sync-groups.js`: `recorded` e `heldCopy` vieram de `sync-groups-8.test.js`; o `require` do semeador fica dentro de `startSeeder`, para que os testes que só usam o semeador falso não o carreguem.

Arquivos do membro que não carregam o semeador, cada um sozinho, com a correção:

| Arquivo | Testes | Asserções |
|---|---|---|
| `admission-caps.test.js` | 11/11 | 50/50 |
| `sync-groups-2.test.js` | 27/27 | 96/96 |
| `sync-groups-3.test.js` | 26/26 | 143/143 |
| `sync-groups-4.test.js` | 14/14 | 73/73 |
| `sync-groups-5.test.js` | 8/8 | 19/19 |
| `sync-groups-6.test.js` | 1/1 | 5/5 |
| `sync-groups-8.test.js` | 40/40 | 271/271 |
| `sync-slots.test.js` | 8/8 | 27/27 |

Arquivos que usam o semeador real, cada um sozinho, com o lado do semeador pronto: todos passaram.

| Arquivo | Testes |
|---|---|
| `seeder-header-stubs-e2e.test.js` | 1/1 |
| `sync-groups.test.js` | 16/16 |
| `sync-groups-7.test.js` | 1/1 |
| `sync-groups-sparse.test.js` | 2/2 |
| `sync-private.test.js` | 9/9 |

Semeador: `packages/core/test/seeder-groups-header-stubs.test.js` (novo) cobre a lista só para quem tem o bit, os limites (`maxHeaderStubs` e 8 por diário), a saída da linha (entrada movida, diário removido, grupo bloqueado), a ligação do próprio K, a linha só de lista, a partida sem o autor e o `seed drop`, e as recusas por tamanho e por certificado de membro. Cada uma das 15 verificações de remoção do semeador (tirar o toco, a checagem do bit, a leitura do núcleo guardado, a regra do mesmo grupo, os dois limites, a saída, o `drop`, o bloqueio, a partida, o `seed drop`, a linha só de lista, o tamanho, o certificado e a tomada do toco) faz esse arquivo falhar.

Remoção da correção do nó core (cada mutação desfeita depois, `shasum` de `sync.js` igual antes e depois), só com o teste novo e o da entrada não provada:

| Mutação | Resultado |
|---|---|
| sem o terceiro argumento de `fail` no caminho guardado | teste novo falha (semeador cortado) |
| sem `r.local !== true` na cobrança | teste novo falha (semeador cortado) |
| as duas | teste novo falha |
| cobrança nunca aplicada (sonda) | passa: o teste da entrada não provada corta o semeador por outras cobranças, então não fixa essa linha |

## Rodada de revisão 1

Mudanças em `packages/core/lib/seeder.js`:

- As linhas de `headerStubs` são lidas no início da partida, junto com `groups`, antes do passo 3a. Antes, uma partida que removia um diário, uma mídia ou um núcleo de grupo nos passos 3a a 3c gravava `admitted.json` sem as linhas, e os núcleos dos tocos ficavam em `store/` sem lista. `_stubRolePurged` não faz nada até o passo 3d, que julga essas linhas.
- Uma entrada movida para outro grupo mantém o núcleo: enquanto a nova entrada de K não tem linha, não foi recusada e K não está ligado, a linha antiga fica nessa passagem, a admissão lê o bloco 0 do núcleo guardado sem buscar, e a nova linha tira as outras linhas do mesmo diário para K.
- `maxHeaderStubs` fica limitado a 8192, as linhas que `admitted.json` guarda.
- A saída de uma linha lê a admissão em andamento de K na hora, como `_dropGroup`, e só a espera quando não há outra saída antes dela. Antes, duas saídas do mesmo núcleo e uma admissão nova dele podiam esperar uma pela outra para sempre, e `close()` não terminava.
- Um bloco 0 diferente do buscado (`fork`) fica recusado para aquele seq da entrada, e uma admissão que falha (`admission-failed`) espera como um tempo esgotado. Antes, cada reconciliação buscava, gravava e apagava o mesmo núcleo de novo.
- Uma entrada de D só conta como respondida pela linha do próprio D que não está saindo.
- Um toco só se esconde atrás de um item de escritor do mesmo grupo que os membros já veem, e isso só vale no intervalo antes de `_takeFromStub`. Depois dele, o bloco 0 guardado (`_stubBlockHeld`) esconde o toco até a checagem do cabeçalho, e nesse intervalo K fica sem item (as páginas do grupo ficam incompletas).
- A partida registra um toco bifurcado como `fork`, não `no-header`.
- O comentário do cabeçalho diz que um diário ou núcleo de mídia já servido aqui e ligado como escritor vira linha só de lista, e um que não está aqui é recusado.

Membro: `packages/core/test/sync-groups-8.test.js` ganhou um teste que fixa a cobrança de uma listagem não guardada de escritor de outro grupo (`wrong-group`), com a entrada não provada.

Protocolo: o `seed drop` também tira as linhas cuja chave ou grupo é a chave removida; as outras saídas de uma linha (núcleo apagado no outro papel, com a entrada tentada de novo; na partida, pelo limite, sem bloco 0, bifurcado ou com outro veredito; entrada movida); o limite de 8192; a regra de diário e mídia.

Testes novos em `seeder-groups-header-stubs.test.js`: partida com um diário bloqueado e um toco de outro diário; entrada movida com o autor fora do ar (também a regra de `_groupDiaryWaiting`); duas saídas e uma admissão do mesmo núcleo; recusa por bloco 0 diferente e por admissão que falha, sem nova busca a cada reconciliação; o limite de `maxHeaderStubs`.

Remoção de cada correção (desfeita depois; `shasum` de `seeder.js` e de `sync-groups-8.test.js` igual antes e depois), rodando só `seeder-groups-header-stubs.test.js`:

| Mutação | Resultado |
|---|---|
| sem a leitura das linhas no início | falha |
| sem a espera da entrada movida (`_stubMoving`) | falha (tempo esgotado em "Kb sob G2") |
| sem tirar as linhas antigas na nova linha | falha (tempo esgotado em "Kb sob G2") |
| saída que lê a admissão depois da saída anterior | falha (o teste não termina) |
| `fork` sem recusa memorizada | falha |
| `admission-failed` sem espera | falha |
| `_groupDiaryWaiting` com a linha de qualquer diário | falha |
| `maxHeaderStubs` sem limite | falha |

No membro, tirar a cobrança de `wrong-group` no descarte da listagem faz o teste novo falhar (só ele, numa cópia temporária). A regra de esconder o toco atrás de um escritor visível e o registro `fork` na partida não têm teste próprio.

## Rodada de revisão 2

A branch recebeu a `main` com o orçamento de armazenamento (#33). Os núcleos dos tocos ficam fora do orçamento, limitados pela contagem (`maxHeaderStubs` vezes o bloco 0, cerca de 256 x 16,5 KiB no padrão); com o orçamento cheio, uma chave desconhecida é recusada com `storage-full` antes de ser julgada como toco. Uma saída pelo orçamento passa por `_drop` / `_dropGroup`: as linhas do diário saem, e um papel apagado leva as linhas que dependiam dele, com a entrada tentada de novo.

Mudanças em `packages/core/lib/seeder.js`:

- Uma entrada movida não perde o toco nos limites: `_stubRoom(diary, key, group)` não conta as linhas vivas de D para K sob outro grupo, nem nas 8 do diário nem no total. Antes, com D em 8 linhas ou o semeador em `maxHeaderStubs`, a nova entrada era `stub-full` e a linha antiga saía com o núcleo.
- A linha antiga de uma entrada movida só fica enquanto a admissão da nova entrada de K está em andamento ou D espera uma vaga de admissão. A checagem roda depois do laço das entradas, para ver esse estado. Uma nova entrada recusada sem espera (grupo bloqueado, lista de bloqueio pendente, limites do diário) ou que espera por outro motivo tira a linha na mesma passagem, e K é buscado de novo quando a entrada for tentada outra vez. Enquanto fica, a linha não é listada (a entrada viva de D nomeia outro grupo), e o fim da admissão julga a linha de novo.
- Uma raiz apagada pelo criador (bloqueado ou revogado, em `goneRoots`), qualquer raiz com a admissão de raízes fechada, ou uma raiz cujo criador sumiu não volta como toco de outro grupo: a entrada é recusada (`blocked`, `revoked-issuer`, `denials-full`) e espera como uma raiz sumida; um toco guardado dessa raiz sai na adoção da lista de bloqueio e na partida. A verificação `key === group` de `_admitGroup` ficou como estava, porque também se aplica a escritores comuns.
- `_stubBlock` confere `core.fork` depois da leitura: um núcleo que bifurcou durante a leitura não dá bloco 0, e a admissão espera como um tempo esgotado.

Testes novos em `seeder-groups-header-stubs.test.js`: entrada movida com os dois limites cheios e o autor fora do ar (também a linha antiga fora da lista enquanto a admissão está em andamento); linha antiga que sai quando a nova entrada termina sem bloco 0 e quando ela é recusada por grupo bloqueado; raiz apagada pelo criador que não volta como toco, e toco guardado de uma raiz cujo criador foi bloqueado; núcleo bifurcado durante a leitura (teste de unidade); saída pelo orçamento (`_dropOwner`, a mesma chamada de `_storagePass`) de um diário com toco guardado e de um papel em que uma linha só de lista se apoiava. A guarda `_stubsRestored` ficou sem teste próprio: exige uma linha só de lista cujo papel é apagado nos passos 3a a 3c da partida.

Remoção de cada correção (desfeita depois; `shasum` de `seeder.js` igual antes e depois), rodando só `seeder-groups-header-stubs.test.js`:

| Mutação | Resultado |
|---|---|
| total de `_stubRoom` conta a linha movida | falha (tempo esgotado em "K sob G2") |
| limite do diário conta a linha movida | falha (tempo esgotado em "K sob G2") |
| linha movida fica sempre (sem a checagem de admissão em andamento) | falha (tempo esgotado em "Kb fora") |
| sem a checagem depois do laço das entradas | falha (tempo esgotado em "Kb fora") |
| linha movida listada sob o grupo antigo | falha (teste 14) |
| sem a reconciliação no fim da admissão | falha (tempo esgotado em "Kb fora") |
| toco aceito para raiz apagada | falha (teste 16) |
| sem a saída de tocos de raiz na adoção da lista | falha (tempo esgotado em "R2 removido") |
| `_stubBlock` sem conferir `fork` | falha (teste 17) |
| `_purge` sem `_stubRolePurged` | falha (teste 16, tempo esgotado antes do 18) |
| leitura das linhas de volta em `_restoreHeaderStubs`, como antes da rodada 1 | falha só o teste 9 |

A checagem de raiz em `_restoreHeaderStubs` não tem teste próprio.

Depois da junção com a `main` e desta rodada, cada arquivo sozinho (`VARANDA_TEST_CONCURRENCY=1 node <arquivo>`), Node 24.22.1, todos passaram. A contagem de `sync-groups-8.test.js` na tabela do membro acima é desta execução (a `main` trouxe testes novos).

| Arquivo | Testes | Asserções |
|---|---|---|
| `seeder-groups-header-stubs.test.js` | 18/18 | 126/126 |
| `seeder-groups.test.js` | 44/44 | 271/271 |
| `seeder-header-stubs-e2e.test.js` | 1/1 | 9/9 |
| `seeder-storage-budget.test.js` | 14/14 | 160/160 |
| `sync-groups-8.test.js` | 40/40 | 271/271 |
| `seeder-groups-gone.test.js` | 25/25 | 153/153 |
| `seeder-groups-waits.test.js` | 12/12 | 61/61 |
| `seeder-groups-cuts.test.js` | 20/20 | 361/361 |

## Rodada de revisão 3

A branch recebeu a `main` de novo (#768, junção limpa). Mudanças em `packages/core/lib/seeder.js`:

- O fim de uma admissão de K não começa mais admissões: `_settleStubRows(key)` só tira linhas. Antes ele reconciliava o diário, e uma admissão que falhava na gravação de `admitted.json` (sem espera, sem recusa, sem linha) começava de novo na hora, em laço, até uma gravação dar certo. Agora essa saída `admission-failed` também espera como um tempo esgotado, como já fazia a falha de um toco.
- O fim de qualquer admissão de K julga as linhas de K de todos os diários, não só do diário da admissão: a linha de D guardada enquanto a admissão de outro diário estava em andamento sai assim que ela termina, sem esperar a próxima reconciliação de D.
- A saída dos tocos guardados de uma raiz cujo criador sumiu (`_dropGoneRootStubs`) roda no fim de `_dropUnsupportedRoots`, e não só na adoção da lista. Um criador cujo emissor foi revogado na adoção só sai depois, quando a nova lista o julga de novo; o toco agora sai nesse momento.
- `_listHeaderStub` usa `_stubRoom(diary, key, group)`, e `_stubRoom` deixa de fora as linhas de D para K sob outro grupo mesmo já saindo. Antes uma linha só de lista movida com o limite cheio perdia a lista (`stub-full`) enquanto a linha antiga ainda saía.

Testes novos em `seeder-groups-header-stubs.test.js` (19 a 22): entrada movida cuja gravação falha (o gancho `admitHook` na etapa `persist`), que espera antes de tentar de novo e se move quando a gravação volta; toco guardado de uma raiz cujo criador tem o emissor revogado e sai depois da adoção; linha só de lista movida com `maxHeaderStubs: 1` enquanto uma saída anterior de K ainda roda; linha de D guardada durante a admissão de K por outro diário, com as passagens de D paradas, que sai quando essa admissão termina.

Remoção de cada correção (desfeita depois; `shasum` de `seeder.js` igual antes e depois), rodando só `seeder-groups-header-stubs.test.js`:

| Mutação | Resultado |
|---|---|
| fim da admissão reconcilia o próprio diário e `admission-failed` sem espera (rodada 2) | falha (teste 19, e tempo esgotado em "linha antiga fora" do 22) |
| só o fim da admissão volta a reconciliar o próprio diário | falha só no teste 22 (tempo esgotado em "linha antiga fora") |
| só `admission-failed` sem espera | falha (tempo esgotado em "K movido para G2") |
| saída dos tocos de raiz só na adoção, como na rodada 2 | falha (tempo esgotado em "R2 removido") |
| `_listHeaderStub` com `_stubRoom(diary)` | falha (tempo esgotado em "Kd sob G3") |
| `_stubRoom` conta a linha movida que já sai | falha (tempo esgotado em "Kd sob G3") |
| fim da admissão julga só as linhas do próprio diário | falha (tempo esgotado em "linha antiga fora") |

Ficam sem teste próprio: o ramo de restauração da checagem de raiz em `_restoreHeaderStubs` (LOW3) e a guarda `_stubsRestored`.

Depois desta rodada, cada arquivo sozinho (`VARANDA_TEST_CONCURRENCY=1 node <arquivo>`), Node 24.22.1, todos passaram:

| Arquivo | Testes | Asserções |
|---|---|---|
| `seeder-groups-header-stubs.test.js` | 22/22 | 142/142 |
| `seeder-groups.test.js` | 44/44 | 271/271 |
| `seeder-header-stubs-e2e.test.js` | 1/1 | 9/9 |
| `seeder-storage-budget.test.js` | 14/14 | 160/160 |
| `seeder-groups-gone.test.js` | 25/25 | 153/153 |
| `seeder-groups-waits.test.js` | 12/12 | 61/61 |

## Rodada de revisão 4

Mudanças em `packages/core/lib/seeder.js`:

- `_stubJoin`: uma entrada movida que uma linha só de lista responderia, lida antes de a varredura de D alcançar o fim do diário, espera a varredura enquanto D ainda tem uma linha de K sob outro grupo. Antes, um diário entregue bloco a bloco listava K sob um grupo depois do outro, e as linhas antigas ficavam fora dos dois limites. Agora a passagem que alcança o fim tira a linha antiga e só então lista a nova.
- `_stubRoom`: só uma linha movida de K fica fora dos limites (`Math.min(moved, 1)`); as outras contam para o diário. Um diário fica com no máximo 9 linhas e o semeador com no máximo `maxHeaderStubs + 1`.
- Fim de `_admitGroup`: quando a entrada viva de K do próprio diário nomeia outro grupo que não o da admissão (a entrada mudou de novo enquanto K estava em andamento, e a passagem a pulou), o diário é reconciliado uma vez, antes de `_settleStubRows`, e a nova entrada lê o K guardado sem buscar. Não entra em laço: a saída por gravação falha tem o mesmo grupo.

Testes novos em `seeder-groups-header-stubs.test.js` (23 a 25): entrada de Kd (guardado em outro papel) movida por 10 grupos com a varredura de D atrás do comprimento em cada passagem (as passagens de D veem `scanned` abaixo do comprimento, como um diário que chega bloco a bloco), com uma linha de Kd por vez e só a do último grupo listada depois; linha só de lista movida duas vezes com `maxHeaderStubs: 1` enquanto uma saída anterior de Kd ainda roda, que recusa a segunda mudança com `stub-full` em vez de passar de 2 linhas; entrada movida de G1 para G2, com a admissão presa, e de G2 para G3 nesse meio tempo, respondida sob G3 pelo núcleo guardado, sem nova busca e com o autor fora do ar.

Remoção de cada correção (desfeita depois; `shasum` de `seeder.js` igual antes e depois), rodando só `seeder-groups-header-stubs.test.js`:

| Mutação | Resultado |
|---|---|
| `_stubJoin` lista a entrada movida antes de a varredura alcançar o fim | falha no teste 23 (9 linhas de Kd, e tempo esgotado em "Kd sob o último grupo") |
| `_stubRoom` deixa de fora todas as linhas movidas | falha no teste 24 (3 linhas, sem `stub-full`) |
| fim da admissão sem reconciliar a entrada movida de novo | falha no teste 25 (tempo esgotado em "K sob G3") |
| fim da admissão reconcilia o próprio diário, como na rodada 2 | falha só no teste 22 (tempo esgotado em "linha antiga fora") |

Depois desta rodada, cada arquivo sozinho (`VARANDA_TEST_CONCURRENCY=1 node <arquivo>`), Node 24.22.1, todos passaram:

| Arquivo | Testes | Asserções |
|---|---|---|
| `seeder-groups-header-stubs.test.js` | 25/25 | 166/166 |
| `seeder-groups.test.js` | 44/44 | 271/271 |
| `seeder-header-stubs-e2e.test.js` | 1/1 | 9/9 |
| `seeder-storage-budget.test.js` | 14/14 | 160/160 |
| `seeder-groups-gone.test.js` | 25/25 | 153/153 |
| `seeder-groups-waits.test.js` | 12/12 | 61/61 |

Revisão da rodada 4: sem P1 nem P2. Três ajustes P3 entraram depois dela: a reconciliação do fim da admissão não vale para a admissão de uma raiz (`key !== group`, pois `groupLive` é indexado pelo escritor); o texto da asserção do teste 24 diz que a segunda mudança é recusada com `stub-full`; e o limite da espera pela varredura está em "Pontos em aberto". O estado do teste 24 (uma saída anterior de Kd ainda em andamento numa passagem seguinte) é montado à mão: o código só o mantém por um instante, e `Math.min(moved, 1)` fica como limite de defesa.

A saída só de remoção no fim da admissão continua sem teste próprio: um teste como o 19 com a espera ignorada (`_groupBackingOff` sempre falso) passou também com a reconciliação da rodada 2 de volta (1 gravação), então não foi mantido. O teste 19 ainda passa com no máximo 2 gravações.

## CI do GitHub

- Primeira rodada (`5901fd19`): os jobs `cli` caíram com `this._headerStubs is not iterable`. `apps/cli/test/seeder-topic.test.js` e `apps/cli/test/seeder-index.test.js` montam o semeador à mão (`Object.create(Seeder.prototype)`) e chamam `_drop`, que agora passa por `_dropHeaderStubsOf`. Corrigido em `99b53032`: os dois montadores ganham `_headerStubs` e `_stubCores`. Sozinhos: `seeder-topic` 10/10 e `seeder-index` 55/55.
- Segunda rodada (`c9c91f3e`): `sync-groups-8.test.js` passou do tempo por arquivo (180 s) no Node 24, com os 38 primeiros testes somando 179 s. Os testes 21 a 40 foram, com os mesmos nomes e os auxiliares que usam, para `packages/core/test/sync-groups-9.test.js`. Na CI, as duas metades somam cerca de 95 s e 90 s.
- Contagem, cada arquivo sozinho: antes, `sync-groups-8` 40/40 testes e 271/271 asserções; depois, `sync-groups-8` 20/20 e 185/185, `sync-groups-9` 20/20 e 86/86. Na primeira rodada local depois da divisão, com a máquina sob carga (média 18), os testes 14 e 16 de `sync-groups-8` falharam uma vez e passaram na rodada seguinte.
- Na mesma rodada da CI, `sync-groups-2` teste 8 ("a writer stored in an earlier run gives its slot to an earlier proven join listed later") falhou uma vez no Node 20. A mudança em `sync.js` só deixa de cobrar a recusa de cabeçalho de um núcleo guardado em outro papel e não muda qual escritor dá a vaga. Sozinho, o arquivo passou três vezes (27/27, 96/96).

## Pontos em aberto (padrões do responsável)

- Uma entrada desligada (`on: false`) mantém o toco: sair do grupo nunca apaga um núcleo, e os leitores ainda esperam um escritor que saiu.
- "G sai" quer dizer G bloqueado. Uma raiz apagada por outro motivo deixa os escritores servidos, e os tocos seguem a mesma regra.
- Escritores `v: 1` de grupos antigos dividem o limite de 256, sem guarda extra.
- `stub-full` só é julgado de novo numa nova entrada (outro seq) ou na partida seguinte.
- Enquanto a varredura de D não alcança o fim do diário (um bloco que nenhum par serve), uma entrada movida que uma linha só de lista responderia fica sem resposta, e a linha antiga continua listada sob o grupo antigo.
- O nó core deixa de cobrar a listagem de um núcleo guardado sem provar a entrada: no máximo um portão por (grupo, chave) por execução, sobre chaves que o nó já guarda, sem busca.

## Ordem de implantação (#224)

Qualquer ordem funciona. O semeador lista tocos só para quem manda a capacidade e não anuncia nada novo, então aplicativos sem ela recebem as páginas de hoje, e aplicativos com ela diante de um semeador antigo se comportam como hoje. Recomendado: os aplicativos (PR do leitor, com a correção do nó core) antes ou junto, depois o semeador; o ganho começa quando os dois estão no ar. Para voltar o semeador a uma versão antiga, que ignora `headerStubs` e deixaria os núcleos dos tocos em `store/` sem lista, aceite essa sobra: a opção `maxHeaderStubs` só existe no construtor, sem flag nem variável de ambiente, então o operador não tem como apagar as linhas antes.

## Riscos residuais

- Um semeador pode listar, a cada atualização, todo núcleo que o membro guarda sob cada grupo que ele pagina, sem nunca ser cortado: o membro abre cada um localmente e o pula, sem buscar nem guardar nada. O custo fica limitado a cada atualização (núcleos guardados vezes grupos paginados).
- Quando a nova entrada de uma chave movida é recusada sem espera, ou espera por outro motivo que não uma vaga de admissão, a linha antiga sai na mesma passagem e o núcleo é apagado; quando a entrada for tentada de novo, K é buscado outra vez (com o autor fora do ar, a entrada fica esperando).
- Para a nova entrada de K, só uma linha movida de K (guardada para a mudança ou já saindo) fica fora dos limites; as outras contam. Enquanto essas saídas demoram (uma limpeza lenta), um diário guarda no máximo uma linha além do seu limite (9) e o semeador no máximo uma além de `maxHeaderStubs`; passando disso a entrada é recusada com `stub-full`. Cada saída espera a anterior da mesma chave.
- Uma entrada movida cuja gravação de `admitted.json` falha perde a linha antiga e, com ela, o núcleo guardado: quando a espera acaba, K é buscado de novo.
