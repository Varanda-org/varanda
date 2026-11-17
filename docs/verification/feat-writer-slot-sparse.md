# Escritores cortados guardados e lidos esparsos (branch feat/writer-slot-sparse)

Parte da #350, item 8a, passo 8a-3, sobre `feat/writer-slot-walk`. Decisão do dono (não reaberta aqui): o semeador guarda, dentro da cota normal, as saídas e os blocos de chave de um escritor cortado e um toco de cada escritor liberado.

## O que mudou

Dobra (`packages/core/lib/group.js`):

- `bindCores`: um escritor conta até o primeiro seq que nenhuma cópia tem e, depois desse buraco, só as saídas (`group-leave`) e os blocos de chave (`group-key`), e só quando o buraco está no corte ou depois dele (`max(corte, 1)`). Uma cópia esparsa de um escritor cortado dobra como a inteira; uma cópia parcial, cortada ou não, dobra como o prefixo de sempre.
- Cada cópia traz `signed` (o comprimento que o escritor assinou). Um bloco de chave cujo `auth` cita um escritor de comunidade (CW) cortado vale quando `auth.seq` não passa desse comprimento (`heldSeq = max(lastSeq, held, signed - 1)`), então um CW aparado no corte lê o histórico que a cópia inteira lê.

Leitores:

- Nó core: `readHeldBlocks` em `packages/core/lib/store.js` (o prefixo contíguo e, depois do primeiro buraco, só as saídas e os blocos de chave guardados, até `MAX_LOG_BLOCKS`); `readCoreParts` em `member.js` lê os escritores assim e passa `signed: core.length`. As raízes continuam lidas como prefixo.
- Nó do navegador: `readHeldBlocks` em `packages/web-member/lib/node-store.js`; em `member-ops.js`, `writerCoreState` para os escritores, o carimbo da memória da dobra (`groupStamp = replicaStamp`) conta os blocos guardados depois do comprimento contíguo, `signed` em `foldGroup` e `foldCommunity`, e `foldCommunity` passa a receber as marcas de corte dos diários.
- Serviço de contas: `apps/cli/lib/account/pages-groups.js` lê os escritores listados com `readHeldBlocks` e passa `signed`.

Semeador (`packages/core/lib/seeder.js`):

- Escritor cortado (`groupWalkCut` sobre a caminhada): o download para no corte; os blocos depois dele, até `MAX_LOG_BLOCKS`, são buscados de 256 em 256 (`CUT_CHUNK`), lidos só pelo tipo e limpos, menos saídas e blocos de chave (`_cutGroupCore`). O Hypercore guarda os nós da árvore que as provas dos blocos mantidos pedem.
- Liberado (corte 0): toco com o bloco 0, as saídas e os blocos de chave.
- A ligação em `admitted.json` guarda `cut`, `clearedFrom` e `clearedTo`, gravada antes de limpar cada pedaço; o próximo serviço relê essa faixa e limpa o que sobrou de uma queda no meio.
- Cota: na admissão e na partida, só os blocos abaixo do corte; com o núcleo inteiro acima da cota, os blocos abaixo do corte mais os mantidos depois dele, e os bytes deles. Passou: sai com `quota` e a entrada fica recusada, como na admissão (senão cada varredura buscaria de novo).
- Corte menor aplica na hora (também com o núcleo ainda abrindo); maior ou nenhum, só depois que a varredura alcançou o diário, e então o que a limpeza tirou é buscado de novo. Um corte restaurado na partida não limpa nada novo antes de a varredura confirmá-lo.
- Uma entrada recusada antes (`quota`, `header-invalid`) é tentada de novo uma vez a cada corte menor.
- Escritor sem caixa num grupo privado: `header-invalid` enquanto contado, toco depois de liberado (`groupVerdict(..., released)`, na admissão, na partida, no portão e na reverificação de caixa). Se a liberação some, é julgado de novo e sai.

Documentos: `docs/protocol.md` (bit `CAP_WRITER_CUTS`, entrada de `buildGroup` e `buildCommunity` com `signed`, "Slot walk" e "Writers named by a node" sobre o sem caixa, regra do `auth.seq` em "Diary cuts on own writers" e em "Community distributors", parágrafo novo "Sparse copies", "Cut writers" do semeador reescrito). `docs/rpc.md` não muda: nenhum método nem resultado mudou.

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

O teste de ponta a ponta: A cria a comunidade e dois grupos; B escreve nos dois, congela o escritor de G1 no comprimento (dois posts e a saída depois do corte) e libera o de G2 (um post e a saída). Depois que o semeador guarda os dois esparsos, R, novo, sincroniza só com ele: guarda W1 abaixo do corte mais a saída e W2 como toco, e a comunidade e os dois grupos (info, membros e leitura) dobram igual a quando R recebe as cópias inteiras de B.

`apps/cli/lib/account/pages-groups.js` não tem teste próprio da leitura esparsa: usa o mesmo `readHeldBlocks` e a mesma dobra testados acima, e hoje o `fetch` dele marca o grupo como `incomplete` com uma cópia esparsa (ponto (b) abaixo), então a diferença ainda não aparece para quem usa.

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

## Decisões tomadas aqui

- A regra do buraco mora na dobra (`bindCores`), não só nos leitores: assim o nó core, o nó do navegador e o serviço de contas dobram igual mesmo com cópias diferentes do mesmo escritor, e um bloco depois de um buraco abaixo do corte nunca conta.
- Os escritores são lidos com `readHeldBlocks`; as raízes continuam com o prefixo (nunca são cortadas por um diário).
- No nó do navegador, `foldCommunity` passa a receber as marcas de corte: sem elas, um CW cortado guardado esparso dobrava diferente da cópia inteira.
- O semeador grava `cut`, `clearedFrom` e `clearedTo` antes de limpar; uma recontagem a cada serviço limpa o que uma queda deixou. A faixa lida fica numa peça só: um corte menor lê para baixo a partir de `clearedFrom` antes de seguir para cima.
- Um corte restaurado do `admitted.json` serve na hora, mas não limpa nada novo antes de a varredura do diário confirmá-lo (`cutConfirmed`). Corte menor aplica na hora (a varredura só acrescenta marcas, então nunca fica acima do corte do diário); corte maior ou ausente só depois de a varredura alcançar o diário (`scanCaughtUp`).
- Uma entrada recusada é tentada de novo uma vez a cada corte menor que a caminhada dá ao escritor: um corte faz caber na cota quem não cabia, e a liberação faz o sem caixa valer como toco. O custo é no máximo uma busca do bloco 0 por registro de corte.
- Um escritor que sai por causa do que guarda fica com a entrada recusada (`groupRefused`), como uma recusa na admissão; sem isso ele seria admitido, buscado e derrubado a cada varredura.
- A cota do que fica guardado usa `_overQuota` (núcleo inteiro) como atalho: só conta blocos e bytes quando o núcleo inteiro já passa da cota. Os bytes abaixo do corte são lidos um a um só nesse caso.
- O fragmento de changelog de `feat/writer-slot-walk` (que diz que o semeador guarda o escritor inteiro) não foi mexido: é de outro PR; o deste PR diz o comportamento novo.

## Riscos residuais e pontos em aberto

- (a) Meta de `sync --once` (nó core e nó do navegador): `groupUnmet` quer `max(anunciado, core.length)` blocos contíguos de cada escritor alheio, e o dono de um escritor cortado espera o semeador listar o comprimento inteiro (`pushed`). Com o semeador esparso, nenhum dos dois chega lá, e um `--once` num grupo com escritor cortado só termina pelo tempo limite. Padrão recomendado: dar o escritor por completo quando o contíguo alcança o anunciado e todo bloco que um par conectado anuncia (bitfield) abaixo do comprimento assinado está guardado; para o próprio escritor, comparar com o corte do diário. Não feito aqui: está fora do escopo do brief e mexe nas duas sincronizações.
- (b) Serviço de contas: `fetch` em `pages-groups.js` dá uma cópia por completa só com o contíguo no comprimento, então um grupo com escritor cortado esparso fica `incomplete` e entrar, postar ou selar pela Página responde `indisponivel`. Padrão recomendado: completa quando todo bloco que o semeador anuncia está guardado.
- (c) As dobras de catálogo (comunidade no índice) não recebem marcas; leem o prefixo, o que continua seguro. Sem mudança.
- (d) As cotas do lado do leitor usam o comprimento assinado (já era assim).
- (e) Banda do semeador: os blocos depois do corte, até `MAX_LOG_BLOCKS`, são baixados só para ler o tipo. Os pedaços de 256 limitam o que fica guardado além do mantido, não o que trafega.
- (f) Item 4 do lado do leitor: as sincronizações (core e navegador) ainda recusam com `header-invalid` o cabeçalho sem caixa num grupo privado antes de guardá-lo, então um leitor que nunca o teve continua com a dobra `incomplete`, embora o semeador agora mantenha o bloco 0. Padrão recomendado: guardar só o bloco 0 de um escritor sem caixa de grupo privado quando a caminhada do diário dele o libera, e deixar a dobra rejeitá-lo pelo cabeçalho. É uma mudança grande nas duas sincronizações; não feita aqui.
- O teste de ponta a ponta não confere o resultado `ok` do `sync --once` do leitor, por causa de (a).
