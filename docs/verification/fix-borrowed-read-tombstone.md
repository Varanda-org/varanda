# Leitura emprestada e lápide que chega no meio (parte da #353)

## O que mudou

`packages/web-member/lib/node-store.js`: `readAll`, `readVisible` e `readRaw` guardam o `core.length` do começo de cada passada (e o passam a `presentState` numa visão fixa). Ao fim, se o core cresceu e algum bloco guardado em [comprimento da passada, `core.length`) é uma lápide válida (lida com `{ wait: false }`, bloco ausente não conta), a passada é refeita, no máximo 2 vezes a mais, e devolve a última. A sincronização só limpa um alvo depois de ter a lápide, e uma lápide abaixo da fotografia a passada já lê. Crescimento só com publicações, ou sem crescimento, custa uma passada só. O trecho mais novo de `readVisible` continua julgado só pela fotografia da própria passada. O caminho exclusivo não muda na prática.

## Testes

`packages/web-member/test/read-tombstone-race.test.js`, com cores falsos (`length`, `has`, `get`, `closing`) e blocos codificados como o armazenamento:

- `readAll: a tombstone that arrives mid-walk does not hide the posts after its target`
- `readRaw: the same race settles`
- `readVisible: a mid-backfill replica keeps its newest run when a tombstone arrives mid-walk`
- `a core that grows mid-read with no cut is read once`
- `a core that grows by plain posts around a hole is read once`
- `a core that keeps growing with tombstones is re-read at most twice more`

## Falha sem a correção

Com o `node-store.js` da `origin/main` (f40cf6f6) e o teste novo: `tests = 2/6 pass`, `asserts = 7/16 pass`. Falham os testes 1, 2, 3 e 6; os dois de "uma passada só" passam também sem a correção, e garantem que ela não custa leitura extra. Com a correção: `tests = 6/6 pass`, `asserts = 16/16 pass`.

## Comandos rodados

- `npm ci --ignore-scripts`
- `npx standard packages/web-member/lib/node-store.js packages/web-member/test/read-tombstone-race.test.js`
- `node packages/web-member/test/read-tombstone-race.test.js`, e os arquivos `read-while-sync`, `delete` e `node-storage` (mesma pasta), cada um sozinho: verdes.
- `npm run lint` e `npm run demo` (`DEMO OK`), no Node 24.
- `npm test -- --affected=origin/main`, no Node 24: 21 de 772 arquivos estouraram o tempo com a máquina carregada por suítes de outras branches (arquivos de rede de `packages/core` e de `packages/web-member`). Cada um passou rodando sozinho (`VARANDA_TEST_CONCURRENCY=1 node <arquivo>`), 21 de 21.

## Não rodado

Node 20 só na CI. Sem conferência em aparelho: a corrida é de tempo e foi reproduzida só com cores falsos.
