# Tocos de cabeçalho no semeador (branch fix/seeder-header-stubs)

Parte da #350, sobre `fix/writer-header-refusals` (o PR do leitor) a partir de `03d7744d`. Sem mudança de RPC nem de Termos; `docs/protocol.md` descreve a regra.

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
| `sync-groups-8.test.js` | 34/34 | 246/246 |
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
- Um toco só se esconde atrás de um item de escritor do mesmo grupo que os membros já veem.
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

## Pontos em aberto (padrões do responsável)

- Uma entrada desligada (`on: false`) mantém o toco: sair do grupo nunca apaga um núcleo, e os leitores ainda esperam um escritor que saiu.
- "G sai" quer dizer G bloqueado. Uma raiz apagada por outro motivo deixa os escritores servidos, e os tocos seguem a mesma regra.
- Escritores `v: 1` de grupos antigos dividem o limite de 256, sem guarda extra.
- `stub-full` só é julgado de novo numa nova entrada (outro seq) ou na partida seguinte.
- O nó core deixa de cobrar a listagem de um núcleo guardado sem provar a entrada: no máximo um portão por (grupo, chave) por execução, sobre chaves que o nó já guarda, sem busca.

## Ordem de implantação (#224)

Qualquer ordem funciona. O semeador lista tocos só para quem manda a capacidade e não anuncia nada novo, então aplicativos sem ela recebem as páginas de hoje, e aplicativos com ela diante de um semeador antigo se comportam como hoje. Recomendado: os aplicativos (PR do leitor, com a correção do nó core) antes ou junto, depois o semeador; o ganho começa quando os dois estão no ar. Para voltar o semeador a uma versão antiga, que ignora `headerStubs` e deixaria os núcleos dos tocos em `store/` sem lista, aceite essa sobra: a opção `maxHeaderStubs` só existe no construtor, sem flag nem variável de ambiente, então o operador não tem como apagar as linhas antes.

## Riscos residuais

- Um semeador pode listar, a cada atualização, todo núcleo que o membro guarda sob cada grupo que ele pagina, sem nunca ser cortado: o membro abre cada um localmente e o pula, sem buscar nem guardar nada. O custo fica limitado a cada atualização (núcleos guardados vezes grupos paginados).
- Quando a nova entrada de uma chave movida é recusada ou vira escritor comum, a linha antiga só sai na reconciliação seguinte do diário.
- Na passagem em que a entrada se move, a linha antiga ainda conta nas 8 do diário.
