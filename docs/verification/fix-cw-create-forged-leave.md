# Saída não confirmada não anula create em outro CW

Branch `fix/cw-create-forged-leave`. Decisão do mantenedor em 2026-11-24: uma saída não confirmada não anula create em outro escritor, como já não anula reparo.

## O que muda

Uma saída de quem criou a comunidade, sem confirmação no diário, aposenta os CWs da geração dela. O `cwCreate` descartava todo create num CW aposentado sem limite confirmado, então uma saída forjada num CW roubado transformava em órfãos os grupos criados nos outros aparelhos da pessoa, e o corte no diário do CW roubado não desfazia isso. Agora a aposentadoria não entra no `cwCreate`: um create conta, a menos que uma saída no próprio CW esteja abaixo dele, que uma saída confirmada o limite, ou que o portão esteja fechado sem limite confirmado para o CW. O CW aposentado continua sem autoridade, e o corte no diário continua sendo o remédio para os creates do CW roubado.

## O que foi rodado

Cada arquivo sozinho, com `node <arquivo>` a partir da raiz:

- `packages/core/test/community-cw-forged-leave.test.js` (novo): 3/3 testes, 17 asserções. Com o `group.js` da `main`, passa 1/3 testes (10/17 asserções): o grupo criado no CW honesto vira órfão com a saída forjada, sozinha ou listando esse CW em 0.
- `packages/core/test/community-cw-create.test.js`: o teste 7 afirmava a regra antiga (o CW aposentado sem limite confirmado não acrescenta nada) e foi invertido. 9/9.
- Os 107 arquivos de teste que importam `lib/group.js` (núcleo, nó do navegador e CLI), o novo incluído, quatro de cada vez: todos passam, 2000 testes. Entre eles `group.test.js` 166/166, `community-fold.test.js` 131/131, `group-admin-cover.test.js` 13/13, `community-member.test.js` 27/27 e `community-member-leave*.test.js` (5 arquivos) 47/47.
- `npm run lint`: sem erros. `npm run demo`: DEMO OK.

## Fora daqui

A suíte inteira roda na CI do GitHub. Nada foi conferido em aparelho: a mudança está só na dobra.
