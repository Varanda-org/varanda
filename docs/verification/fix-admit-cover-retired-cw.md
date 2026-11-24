# Admissão de um CW coberto depois de aposentado

Branch `fix/admit-cover-retired-cw`. Decisão do mantenedor em 2026-11-24 (#350: o que um aparelho coberto escreveu antes da saída continua visível, como o de um aparelho listado).

## O que muda

Numa comunidade com aprovação, um admit cobre os CWs novos da pessoa que ele não lista (autoAdmit). Ao aposentar, esse CW saía de `admittedCws`: a cobertura do admit só era calculada para CWs não aposentados, e as publicações dos escritores de grupo ligados a ele, mesmo as anteriores à saída, ficavam ocultas. Um CW listado, ou coberto por uma concessão de admin (`hist`, 2026-11-23), mantinha a admissão. Agora o admit também guarda a cobertura da geração do CW (`autoCover(admits, histGenOf, 'hist')`), e a dobra de C lê essa cobertura para um CW aposentado (`withHist`). Autoridade e vida continuam anuladas para o CW aposentado.

## O que foi rodado

Cada arquivo sozinho, com `node <arquivo>` a partir da raiz:

- `packages/core/test/community-admit-retired.test.js` (novo): 1/1 teste, 26 asserções. Com o `group.js` da `main`, falha em 6 asserções (20/26): o CW coberto sai de `admittedCws` e a publicação anterior à saída some, nas duas saídas (pelo próprio CW e pelo outro aparelho).
- Os 107 arquivos de teste que importam `lib/group.js` (núcleo, nó do navegador e CLI), o novo incluído, quatro de cada vez: todos passam, 1998 testes. Entre eles `group.test.js` 166/166, `community-fold.test.js` 131/131, `community-cw-create.test.js` 9/9, `group-admin-cover.test.js` 13/13, `community-member.test.js` 27/27 e `community-member-leave*.test.js` (5 arquivos) 47/47.
- `npm run lint`: sem erros. `npm run demo`: DEMO OK.

## Fora daqui

A suíte inteira roda na CI do GitHub. Nada foi conferido em aparelho: a mudança está só na dobra.
