# fix/group-cap-stale-joins

Correção no limite de escritores por (grupo, diário) do nó do core (`MAX_GROUP_HELD_PER_DIARY` = 32). O caso 8 de `packages/core/test/sync-groups-2.test.js` ("a writer stored in an earlier run gives its slot to an earlier proven join listed later") falhou 3 vezes no GitHub CI em 2026-11-24, na pilha #895 a #900 (duas no #895, em `core 1/2 (20)`, sem mudança no core, e uma no #900, em `core 2/2 (24)`), sempre nas asserções 4 ("the latest joiner gives way") e 6 ("the latest joiner is purged"), com a 7 (32 guardados) passando: saía outro escritor no lugar do último a entrar.

## Causa

Erro do `sync.js`, não do teste. Com (grupo, diário) cheio, o portão de quem entrou antes lê as entradas do diário de ligação (`refineJoinSeqs`), espera os blocos que ainda faltam abaixo do comprimento (`awaitJoins`) e só lia as entradas de novo se essa espera tivesse trazido algum bloco. A primeira leitura para no primeiro bloco que falta (`presentLength`). Quando esse bloco chega entre a primeira leitura e a espera, buscado por outro portão (no caso 8, o do próprio último a entrar, que lê a sua entrada), a espera não encontra nada faltando e devolve `false`. O portão decidia então com a lista curta: o último a entrar, guardado no disco (`held`), ficava sem número de entrada provado e era pulado, e saía o penúltimo. Com o cache de entradas trocado por outro portão (cada portão de um diário não seguido lê a sua própria sessão do núcleo), a espera recomeçava do bloco 0 e também não via nada faltando.

Achado com atrasos temporários de 15 ms nas leituras locais do diário (só para a investigação, fora do PR): o registro do portão do mais antigo mostrou a decisão com 32 das 33 entradas, o último sem número e o penúltimo despejado, enquanto o diário já tinha os 34 blocos.

## O que mudou

- `packages/core/lib/sync.js`: com a vaga cheia, o portão sempre lê as entradas de novo depois de `awaitJoins`, que não devolve mais nada. A leitura é incremental (continua de onde o cache parou), então o custo extra é uma checagem de comprimento quando nada chegou. Só acontece com a vaga cheia, como antes.
- `docs/protocol.md` não muda: ele já diz que o portão que encontra (grupo, diário) cheio lê as entradas até o comprimento do diário antes de comparar. A correção faz o código cumprir isso.

## Teste novo (`packages/core/test/sync-groups-2.test.js`)

`a gate about to evict reads the joins another gate fetched after its first read`: os 32 escritores mais recentes ficam guardados antes da execução, com uma réplica do diário de ligação sem só a última entrada, e a execução lista o mais antigo e o último. Um `openHook` segura a busca do diário pelo portão do último até a leitura das entradas do mais antigo começar; o `joinsHook` segura essa leitura no último bloco presente até o portão do último ter buscado a sua entrada, e segura o último, ainda abrindo, até o mais antigo ser decidido. Confere que a ordem aconteceu, que o mais antigo é admitido, que o último cede e é apagado, que o penúltimo continua guardado e que ficam 32.

Sem a correção, o teste falha nas 3 execuções, nas asserções 4, 5 e 6 (o último não cede, o penúltimo sai, o último continua guardado), com a contagem em 32: o mesmo padrão do CI. Com a correção, passa.

## Estresse (Node 24, 12 núcleos, 4 deles ocupados por laços de CPU)

Os atrasos e a réplica curta abaixo foram postos só para medir, fora do PR.

| Cenário | Sem a correção | Com a correção |
|---|---|---|
| Caso 8 sozinho, 12 processos em paralelo | 0 falhas em 72 | não repetido |
| Arquivo inteiro, 10 em paralelo | 0 testes falhos em 310 | 0 em 960 (30 execuções do arquivo) |
| Caso 8 com atrasos aleatórios de até 15 ms nas leituras locais do diário | 1 falha em 216 | 0 em 144 |
| Caso 8 com os blocos 32 e 33 do diário apagados antes da segunda execução e até 400 ms entre a primeira leitura e a espera | 1 falha em 72 (asserções 4 e 6, como no CI) | 0 em 144 |
| Teste novo | 3 falhas em 3 | passa |

Sem forçar, a falha não aparece localmente: ela depende de a segunda execução começar com a réplica do diário sem as últimas entradas (1 vez em 72 no registro) e de a entrada chegar entre a leitura e a espera. O teste novo monta essa ordem com ganchos, então falha sempre sem a correção.

## Comandos

```sh
npx standard packages/core/lib/sync.js packages/core/test/sync-groups-2.test.js
node packages/core/test/sync-groups-2.test.js
```

A suíte inteira roda no GitHub CI (Node 20 e 24).
