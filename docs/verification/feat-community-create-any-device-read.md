# Grupos criados em qualquer aparelho de quem criou a comunidade (leitor e semeadores)

Branch `feat/community-create-any-device-read`. Este PR traz o leitor (a regra do fold), as dicas do semeador e o catálogo da sincronização; o app que escreve um `group-create` fora da raiz sai no PR seguinte.

## Ordem de implantação

Semeadores e leitores (este PR) antes do app do PR seguinte. Um leitor antigo responde `root-only` a um `group-create` num CW e trata o grupo como órfão até atualizar.

## O que foi rodado

Cada arquivo sozinho, com `node <arquivo>` a partir da raiz:

- `packages/core/test/community-cw-create.test.js`: 9/9 testes, 85 asserções. Com o `group.js` do PR anterior, 1/9 testes passam (69/83 asserções, antes das 2 asserções novas). O teste 8 ganhou uma segunda saída confirmada em cwZ3: com a regra de geração trocada por `return true` (`group.js`, `cwCreate`), ele falha (84/85).
- `packages/core/test/group-notice-cw-create.test.js` (novo): 2/2 testes, 9 asserções. Com o `foreignCharter` anterior em `group-notice.js`, o primeiro teste falha em 2 asserções (7/9): a dica dava como membro quem a dobra não admitia. Com o filtro descartando também o create de quem criou, o segundo falha.
- `packages/core/test/group.test.js`: 166/166 testes.
- `packages/core/test/community-fold.test.js`: 131/131 testes, 1214 asserções.
- `packages/core/test/group-index-cw-create.test.js` (novo): 13/13 testes, 178 asserções. Com `group-index.js` e `seeder.js` da versão anterior, 0/8 testes passavam; com só o `seeder.js` anterior, os 3 testes do semeador falhavam. Depois da revisão: sem a leitura do `group-leave` no `_scanCharter` do semeador, o teste do semeador com a saída num CW falha (154/159); sem a checagem das saídas (`creatorLeaves`) em `catalogueOf`, os 2 testes da saída falham (151/159); sem a regra do teto, o teste do teto falha (156/159). Na segunda revisão: sem a saída na raiz em `foldRoot`, os 2 testes da saída na raiz falham (172/178); sem o `group-leave` no filtro do `_scanRoot`, o do semeador falha (176/178); sem a leitura das saídas que o corte guarda, ou sem acordar a leitura quando o corte as guarda (`_charterPastKept`), o teste da saída além do corte falha (175/178).
- `packages/core/test/sync-cw-create.test.js` (novo): 4/4 testes, 15 asserções, sobre `catalogueBlock` e `catalogueHint` de `lib/sync.js`. Com a dica só da raiz (o comportamento anterior), 3/4 falham (12/15); sem a checagem do diário do portão, 1 falha (12/15); sem `validateGroupRecord`, 1 falha (13/15); sem o filtro do diário de quem criou, 1 falha (14/15).
- `packages/web-member/test/community-sync-cw-create.test.js` (novo): 3/3 testes, 6 asserções, sobre `catalogueHint` de `lib/sync.js`. Com a dica só da raiz, os 3 falham (2/6); sem o corte do diário, 1 falha (5/6).
- `packages/core/test/group-index.test.js` 19/19, `group-index-charter.test.js` 15/15, `group-index-browse.test.js` 21/21, `group-index-discover.test.js` 6/6.
- `packages/core/test/seeder-groups-charter.test.js` 19/19, `seeder-communities.test.js` 10/10, `seeder-groups.test.js` 70/70, `seeder-groups-3.test.js` 6/6, `seeder-groups-cuts.test.js` 20/20, `seeder-groups-gone.test.js` 25/25, `seeder-groups-header-stubs.test.js` 25/25, `seeder-groups-waits.test.js` 12/12, `seeder-group-browse.test.js` 10/10, `seeder-group-trending.test.js` 9/9, `seeder-discover.test.js` 3/3.
- `packages/core/test/sync-groups.test.js` 16/16, `sync-groups-2.test.js` 31/31, `sync-groups-3.test.js` 26/26, `sync-groups-4.test.js` 14/14, `sync-groups-5.test.js` 8/8, `sync-groups-6.test.js` 1/1, `sync-groups-7.test.js` 1/1, `sync-groups-8.test.js` 20/20, `sync-groups-9.test.js` 20/20, `sync-groups-sparse.test.js` 2/2.
- `packages/web-member/test/community-sync.test.js` 5/5, `community-devices.test.js` 10/10, `community-ops.test.js` 80/80, `sync-groups.test.js` 16/16, `sync-groups-2.test.js` 29/29, `sync-diary-roots.test.js` 10/10, `sync-standalone.test.js` 6/6, `sync-early-abort.test.js` 10/10.
- `npx standard` nos arquivos alterados: sem erros.
- Pouso local: `npm run lint`, os arquivos de teste que a pilha alcança (104 do núcleo, 105 do nó do navegador, 48 da CLI, 21 do app, 2 do rpc) e `npm run demo` (DEMO OK). Na nova rodada do núcleo, depois da segunda revisão, `seeder-standalone.test.js` falhou uma vez (teste 2, uma corrida que já falha na `main`); sozinho, passou 3 de 3 vezes.

## Dicas do catálogo

A dica do semeador lista menos que a dobra, nunca mais: lista só os creates da raiz depois de um `group-leave` válido lido na raiz ou num CW de quem criou a comunidade (que aposenta a geração desse CW na dobra; num CW, também além do corte do diário, entre as saídas que o corte guarda, depois que o semeador as lê), mesmo depois de reiniciar a leitura desse CW, de reler a raiz ou de o semeador largar esse CW, e também quando raiz e CWs somam mais de 32 grupos distintos. As dicas da sincronização (núcleo e navegador) não leem `group-leave`: até a dobra de C, podem paginar uma raiz que a dobra deixa de fora, e o corte de um CW alheio não se conhece ali (o núcleo aplica o corte só nos próprios CWs; o navegador, em todo CW de quem criou, quando tem o diário).

## Limite conhecido

Uma saída forjada num CW roubado de quem criou a comunidade aposenta os CWs da geração 0: os grupos criados neles só contam abaixo de um limite confirmado. Os criados na raiz continuam. Cortar o CW roubado não desfaz isso (o corte guarda toda saída), e a saída confirmada que limita esses CWs é uma saída de quem criou, que também encerra os poderes da raiz.

O limite dos creates de um CW é o menor entre todas as saídas confirmadas de quem criou: se a pessoa sai (confirmada, listando o corte do CW z3), volta e sai de novo (confirmada) por um CW novo sem listar z3, os grupos criados em z3 viram órfãos.

## Fora daqui

A suíte inteira roda na CI do GitHub. Nada foi conferido em aparelho: o app que escreve sai no PR seguinte.
