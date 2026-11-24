# Limite de um CW pelo conjunto de saída mais antigo

Branch `fix/cw-bound-earliest-set`, empilhada sobre `fix/cw-create-forged-leave`. Decisão do mantenedor em 2026-11-24: o limite de um CW vem do conjunto de saída mais antigo que o limita, para creates e reparos.

## O que muda

O limite de um CW de quem criou a comunidade (`repairBound`, que os creates e os reparos dividem) era o menor entre todas as saídas confirmadas. Uma saída confirmada posterior que não listasse um CW já limitado o lia em 0: quem saía listando o corte de z3, voltava e saía de novo de um CW novo, listando só os escritores vivos, perdia os grupos criados em z3 e os reparos feitos de um CW da geração 1. Agora cada CW guarda o limite do conjunto mais antigo que o limita (`boundSet`), o menor dentro desse conjunto, como a raiz (`createCut`, ciclo 25). Um conjunto posterior nunca baixa nem sobe esse limite.

## O que foi rodado

Cada arquivo sozinho, com `node <arquivo>` a partir da raiz:

- `packages/core/test/community-cw-bound.test.js` (novo): 3/3 testes, 13 asserções. Com o `group.js` de `fix/cw-create-forged-leave`, falham os 3 (10/13 asserções): o create abaixo do primeiro limite vira órfão na segunda saída, sem listar z3 ou listando z3 mais baixo, e o nome reparado volta ao da raiz na terceira saída.
- Os 108 arquivos de teste que importam `lib/group.js` (núcleo, nó do navegador e CLI), o novo incluído, quatro de cada vez: todos passam, 2003 testes. Entre eles `group.test.js` 166/166, `community-fold.test.js` 131/131, `community-cw-create.test.js` 9/9, `community-cw-forged-leave.test.js` 3/3, `group-admin-cover.test.js` 13/13, `community-member.test.js` 27/27 e `community-member-leave*.test.js` (5 arquivos) 47/47.
- `npm run lint`: sem erros. `npm run demo`: DEMO OK.

## Fora daqui

A suíte inteira roda na CI do GitHub. Nada foi conferido em aparelho: a mudança está só na dobra.
