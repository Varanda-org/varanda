# Varandinha, índice do semeador (PR feat/varandinha-index)

Este PR acrescenta ao semeador o índice da Varandinha: as leituras `garden()` e `gardenStreet()` e a chave `garden` de `profileExtra()` no índice de engajamento (`packages/core/lib/engagement-index.js`), os tipos `garden`, `garden-state` e `garden-help` em `INDEX_TYPES`, os métodos `Seeder#indexGarden` e `Seeder#indexGardenStreet` e a chave `garden` de `Seeder#indexProfile` (`packages/core/lib/seeder.js`), as rotas `GET|HEAD /index/garden/<dono>` e `/index/garden/<dono>/rua[/<chave>]` com os validadores `gardenBody` e `gardenStreetBody` e a chave `garden` em `profileBody` (`apps/cli/lib/seed-ws.js`), a subseção "Seeder Varandinha index" na seção 5 de `docs/protocol.md`, os dois itens de rota na seção 7 e a chave `garden` no texto do índice de perfil e no item da rota de perfil.

## Rotas e validadores (`apps/cli/lib/seed-ws.js`)

Rodado no Node 24.22.1, sobre a14de943 (a ponta de feat/varandinha-records, o PR de baixo da pilha), com as mudanças deste PR ainda fora de commit:

- `npx standard apps/cli/lib/seed-ws.js apps/cli/test/seed-ws.test.js`
  resultado: passou.
- `npm test -w apps/cli -- test/seed-ws.test.js` (e `node apps/cli/test/seed-ws.test.js`, o mesmo arquivo sozinho)
  resultado: passou, 106/106 testes e 2430/2430 asserções, 1 arquivo, 0 falha.

O que os testes novos de `apps/cli/test/seed-ws.test.js` cobrem:

- `/index/garden/<dono>` e `/index/garden/<dono>/rua[/<chave>]`: o texto exato das duas regex exportadas, a resposta 200 com cabeçalhos JSON, HEAD com o mesmo `Content-Length` e corpo vazio, o cursor que chega ao semeador como veio, dono desconhecido 404 nas duas rotas, caminhos malformados 404 (`/index/garden`, chave curta, longa ou maiúscula, `?x=1`), cauda inválida depois do dono 400 `pedido inválido` com `no-store` (`/`, `/x`, `/rua/`, `/Rua`, `/ruas`, cursor maiúsculo, curto, longo, com barra no fim, com segmento a mais, cursor de recados, uma chave sem `rua`), nenhum caminho malformado chega ao semeador, Host errado 421, e POST, PUT, DELETE e PATCH 405 com `Allow: GET, HEAD`.
- Resposta fora do formato exato é 404 `não encontrado`, nunca um 200 aparado: chave a mais ou a menos, chave a mais numa linha, ajuda sem `followSeq` ou com `followSeq` nulo, ajuda do próprio dono, linha repetida, seq 0 ou em texto, autor maiúsculo, linha em array, 25 ajudas, 25 `given`, `given` repetido, 0 ou fracionário, `on` 0 ou booleano, `state` em texto ou fora do inteiro seguro, bandeiras não booleanas; na rua, chave `rows` no lugar de `items`, chave a mais no item, item sem `state`, `on` nulo, `state` 0, chave repetida ou maiúscula, 21 itens, `items` nulo, `next` em formato de cursor de recados ou numérico. Um throw do semeador é 404 sem eco.
- O pior caso de cada rota (24 ajudas e 24 `given` com seqs no máximo inteiro seguro; 20 itens) cabe em `INDEX_MAX_BODY`, e a resposta de dono pendente passa. As duas rotas gastam o mesmo balde `/index` (a terceira chamada a outra rota recebe 503 com `Retry-After: 1`).
- `/index/profile/<autor>`: as asserções de formato exato agora incluem `garden` (padrão `null`, pior caso no máximo inteiro seguro), e `garden` 0, fracionário, em texto, negativo ou booleano é 404.

Conferido que os testes falham sem a correção: com a checagem de chaves exatas da linha de ajuda e a recusa de ajuda do próprio dono tiradas de `gardenBody`, o arquivo falhou em "garden: an extra help key -> 404" e "garden: a help from the owner -> 404" (105/106 testes, 2426/2430 asserções); com as checagens de volta, passou de novo.

Conferido à mão que as rotas, as regex e as chaves JSON descritas na seção 7 de `docs/protocol.md` são as do código, e que não há travessão (U+2014) nas linhas novas.

## Índice e métodos do semeador (`engagement-index.js`, `seeder.js`, `notices.js`)

Rodado no Node 24.22.1, na mesma base, depois das correções da revisão e da auditoria:

- `npx standard packages/core/lib/engagement-index.js packages/core/lib/seeder.js packages/core/lib/notices.js packages/core/test/garden-index.test.js apps/cli/test/seeder-index.test.js`
  resultado: passou.
- `npm test -w packages/core -- test/garden-index.test.js test/profile-extra-index.test.js test/engagement.test.js test/scraps-index.test.js test/notices.test.js`
  resultado: passou, 5 arquivos, 0 falha; `garden-index.test.js` 36/36 testes e 6639/6639 asserções, `profile-extra-index.test.js` 14/14, `engagement.test.js` 24/24, `scraps-index.test.js` 13/13, `notices.test.js` 31/31.
- `npm test -w apps/cli -- test/seeder-index.test.js test/seed-ws.test.js`
  resultado: passou, 2 arquivos, 0 falha; `seeder-index.test.js` 53/53 testes e 9052/9052 asserções, `seed-ws.test.js` 106/106.

O que os testes de `packages/core/test/garden-index.test.js` e `apps/cli/test/seeder-index.test.js` cobrem, além do que já estava acima:

- Varanda desligada ou nunca aberta: nenhuma rega, nenhum `given` e `state` nulo, sem chamar `visible` nem `followSeq`.
- Tetos por par (4), por escritor (64) e por dono (512 escritores): com o relógio do semeador, um escritor cujas linhas já não podem ser listadas dá lugar ao novo; uma linha que nunca será listada não ocupa lugar; uma rega recusada que ainda poderia ser listada marca a varanda como cheia, e a resposta diz `complete: false` até a janela dela passar. Uma rega que troca outra do mesmo escritor não é recusada pelo orçamento.
- Ordem: regas datadas depois do relógio do semeador ficam por último, e no máximo 4 regas por vaso, com cada escritor antes do segundo dia de outro, de modo que regas num vaso vazio ou num só vaso não tiram da lista as regas honestas de outro.
- Seguidores pendentes, cortados ou no teto deixam a resposta da varanda com `complete: false`; seguidos pendentes deixam a rua com `complete: false`.
- Rua: uma chave seguida que o índice de seguidos esconde nunca aparece nos itens nem no cursor `next`, também onde o orçamento de 2000 chaves acaba.

Conferido que cada teste de regressão falha sem a correção (revertendo a correção numa cópia temporária e rodando de novo), exceto dois que fixam um comportamento que já valia: a escolha de uma linha por escritor e dia entre vasos, e o fim da rua quando só restam chaves escondidas.

## CI completa

Rodado no Node 24.22.1, sobre 30d2f89e (feat/varandinha-records com a `main` f25dc48b mesclada), com as mudanças deste PR por cima:

- `npm ci --ignore-scripts`
  resultado: passou.
- `npm run lint`
  resultado: passou.
- `npm test -- --affected=origin/main`
  resultado: 812 arquivos de teste, 811 passaram e 1 falhou por tempo esgotado: `apps/cli/test/update.test.js` parou no teste "update.sh: up to date with an intervention, a floor that cannot be written does not blame the health gate", com os 64 testes anteriores passando. Rodado sozinho (`node apps/cli/test/update.test.js`), passou, 73/73 testes e 1901/1901 asserções. O arquivo não toca nada deste PR; a mesma falha por tempo apareceu na CI do PR de baixo e também passou sozinha.
- `npm run demo`
  resultado: DEMO OK.

Não rodado: o Node 20 da CI (só o Node 24 local), aparelhos e navegador (este PR não tem tela).
