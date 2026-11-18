# Varandinha, Barraquinha e Enfeites no app (branch feat/varandinha-mimos-model)

## O que foi conferido

Só testes direcionados, rodados a partir da raiz do worktree, no Node 24. Cada arquivo roda com `npm test -w apps/app -- test/<arquivo>`.

### Onda 7 (modelo e telas)

| Comando | Resultado |
|---|---|
| `npm test -w apps/app -- test/gardenScene.test.js` | 15/15 testes, 2368/2368 asserções |
| `npm test -w apps/app -- test/varandinhaView.test.js` | 12/12 testes, 487/487 asserções |
| `npm test -w apps/app -- test/help.test.js` | 15/15 testes, 576/576 asserções |
| `npm test -w apps/app -- test/gardenDecor.test.js` | 4/4 testes, 264/264 asserções |
| `npm test -w apps/app -- test/gardenStall.test.js` | 12/12 testes, 96/96 asserções |
| `npm test -w apps/app -- test/indexClient.test.js` | 75/75 testes, 1533/1533 asserções |

### Onda 8 (Vitrine)

| Comando | Resultado |
|---|---|
| `npm test -w apps/app -- test/vitrine.test.js test/vitrineIndex.test.js` | vitrine: 55/55 testes, 4418/4418 asserções; vitrineIndex: 26/26 testes, 1850/1850 asserções |
| `npx standard apps/app/src/vitrine/fixtures.js apps/app/src/vitrine/indexResponder.js apps/app/src/vitrine/request.js apps/app/test/vitrine.test.js apps/app/test/vitrineIndex.test.js` | sem erros |

O que os testes da onda 8 cobrem:

- `garden.decor`, `garden.stall`, `garden.give`, `garden.take` e `garden.drop` respondem com as chaves documentadas em `docs/rpc.md` (5.162 a 5.166).
- A rota `/index/garden/<chave>/mimos` passa por `validGardenStall` e, montada com `assembleStall` no relógio da demo, dá uma linha na Prateleira e um mimo pendente.
- Aceitar o mimo pendente o leva para a Prateleira; desfazer esse aceite o devolve aos pendentes.
- Num sábado, `garden.give` esvazia o vaso maduro e lista o mimo em `gave`; `garden.drop` do mimo o tira de `gave`.
- No relógio da demo (uma quinta-feira), `garden.give` responde `'a barraquinha só abre aos sábados'` e não escreve nada, inclusive na varredura dos métodos citados pelo app.
- `garden.set` desligado também apaga os registros `garden-decor`, `garden-gift` e `garden-take`.

## O que não rodou

- `npm run lint`, `npm run demo` e a suíte inteira não rodaram aqui: a CI do PR roda a suíte, e o lint e a demo ficam para o fechamento.
- Nenhuma conferência em aparelho (Android, iOS ou web).
