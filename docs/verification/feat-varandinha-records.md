# Varandinha, registros (PR feat/varandinha-records)

Este PR acrescenta as regras puras de `packages/rpc/lib/garden.js` (exportadas como `garden` por `@varanda/rpc`), os três tipos de registro `garden`, `garden-state` e `garden-help` com os construtores em `packages/core/lib/records.js`, os testes `packages/rpc/test/garden.test.js` e `packages/core/test/garden.test.js`, o caso de leitor antigo em `packages/core/test/records.test.js`, o texto na seção 2 de `docs/protocol.md` e a menção na seção 12 de `docs/rpc.md`. Não há rota, método nem tela novos.

Conferido à mão que cada constante, chave e função citada na seção 2 existe com o mesmo valor em garden.js e records.js. Os três exemplos JSON passam `validateRecord` na seq 1: rodado, com `<hex64>` de `garden-help` trocado por um hex64 minúsculo.

Rodado no Node 24.22.1, depois de `npm ci --ignore-scripts`, sobre a `main` em 34a4e34f:

- `npm run lint`
  resultado: passou.
- `npm test -- --affected=origin/main`
  resultado: 800 arquivos, 798 passaram e 2 falharam por tempo, os dois fora deste PR. Detalhes, e os arquivos deste PR:
  - `apps/cli/test/update.test.js` estourou o tempo na rodada paralela; sozinho (`node apps/cli/test/update.test.js`) passou, 73/73 testes e 1901/1901 asserções.
  - `packages/core/test/private-member-3.test.js`: o teste "private: fake bans from an unadmitted writer never inflate a rotation" estourou os 30 s, na rodada paralela e duas vezes sozinho. Numa cópia limpa da mesma `main` (34a4e34f, sem este PR) falha igual, com o mesmo tempo esgotado. O teste grava 5000 banimentos de grupo e sincroniza; nenhum passa pelos tipos novos. A CI da `main` no GitHub passa com ele.
  - `packages/rpc/test/garden.test.js`: 39/39 testes, 370/370 asserções. `packages/core/test/garden.test.js`: 12/12. `packages/core/test/records.test.js`: 70/70.
- `npm run demo`
  resultado: passou, terminou com "DEMO OK".
