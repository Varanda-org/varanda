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

`sync-groups.test.js`, `sync-groups-7.test.js`, `sync-groups-sparse.test.js`, `sync-private.test.js` e o teste ponta a ponta usam o semeador real e rodam depois que o lado do semeador fica pronto.

Remoção da correção do nó core (cada mutação desfeita depois, `shasum` de `sync.js` igual antes e depois), só com o teste novo e o da entrada não provada:

| Mutação | Resultado |
|---|---|
| sem o terceiro argumento de `fail` no caminho guardado | teste novo falha (semeador cortado) |
| sem `r.local !== true` na cobrança | teste novo falha (semeador cortado) |
| as duas | teste novo falha |
| cobrança nunca aplicada (sonda) | passa: o teste da entrada não provada corta o semeador por outras cobranças, então não fixa essa linha |

## Pontos em aberto (padrões do responsável)

- Uma entrada desligada (`on: false`) mantém o toco: sair do grupo nunca apaga um núcleo, e os leitores ainda esperam um escritor que saiu.
- "G sai" quer dizer G bloqueado. Uma raiz apagada por outro motivo deixa os escritores servidos, e os tocos seguem a mesma regra.
- Escritores `v: 1` de grupos antigos dividem o limite de 256, sem guarda extra.
- `stub-full` só é julgado de novo numa nova entrada (outro seq) ou na partida seguinte.
- O nó core deixa de cobrar a listagem de um núcleo guardado sem provar a entrada: no máximo um portão por (grupo, chave) por execução, sobre chaves que o nó já guarda, sem busca.

## Ordem de implantação (#224)

Qualquer ordem funciona. O semeador lista tocos só para quem manda a capacidade e não anuncia nada novo, então aplicativos sem ela recebem as páginas de hoje, e aplicativos com ela diante de um semeador antigo se comportam como hoje. Recomendado: os aplicativos (PR do leitor, com a correção do nó core) antes ou junto, depois o semeador; o ganho começa quando os dois estão no ar. Para voltar o semeador a uma versão antiga, que ignora `headerStubs` e deixaria os núcleos dos tocos em `store/` sem lista, inicie antes a versão nova uma vez com `maxHeaderStubs: 0` (a partida apaga todas as linhas), ou aceite essa sobra.
