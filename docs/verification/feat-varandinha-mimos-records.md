# Varandinha, Barraquinha de mimos e Enfeites: registros (PR feat/varandinha-mimos-records)

Este PR acrescenta as regras puras da Fase 2 em `packages/rpc/lib/garden.js` (Enfeites, Barraquinha e Prateleira: constantes, `isDecor`, `isGiftItem`, `stallDay`, `offerListable`, `applyGive`, `giveAllowed`, `takeAllowed`, `foldDecor`, `foldPending`, `foldShelf`), os três tipos de registro `garden-decor`, `garden-gift` e `garden-take` com os construtores e os conjuntos de chaves em `packages/core/lib/records.js`, os testes em `packages/rpc/test/garden.test.js`, `packages/core/test/garden.test.js` e `packages/core/test/records.test.js`, o texto da Fase 2 na seção 2 de `docs/protocol.md` (três formatos, um exemplo JSON de cada) e a menção na seção 12 de `docs/rpc.md`. Não há rota, método nem tela novos, e nada que a pessoa usuária ou o operador perceba: sem entrada no changelog.

## Conferido

- `garden`, `garden-state` e `garden-help` não ganharam chave: um `garden-state`, um `garden` e um `garden-help` com uma chave a mais continuam `malformed` (teste "phase 1 garden records still refuse any extra key").
- Um leitor da Fase 1 (cópia de `TYPES` antes deste PR, com `garden`, `garden-state` e `garden-help`) pula os três tipos novos como `malformed` e continua lendo um `garden-state` da Fase 1 no mesmo diário (teste "garden phase 2 records: Phase 1 readers skip all three as malformed"). O caso antigo de leitor de antes da Varandinha ficou igual.
- Cada ramo `malformed` e `date-invalid` dos três tipos, a forma antes da data, uma lista de cinco enfeites, ordem trocada, id repetido, `seq` inválido (0, negativo, fracionário, texto, `NaN`, `Infinity`, acima de `MAX_SAFE_INTEGER`) e o `TypeError` de cada construtor.
- Ordem dos mimos para aceitar (`foldPending`): quem a dona segue (`followed`) vem antes de qualquer outra pessoa, e dentro de cada grupo vêm primeiro as linhas com data até agora, a mais nova primeiro, e depois as com data à frente, a mais próxima primeiro. Doze presentes de contas que a dona não segue, datados no último milissegundo do sábado, não tiram da lista o presente de alguém que ela segue, nem doze presentes datados à frente tiram um com a data real. Um `followed` ilegível (proxy revogado, proxy de `Set`, array, texto, objeto com `has`) vale como vazio e não lança. Sem a correção, os casos falham (3 asserções), conferido removendo-a e rodando de novo.
- A Prateleira (`foldShelf`) lê no máximo `GARDEN_TAKE_ROWS` (54) aceites: 54 linhas contam, 55 não contam nada (falha sem a correção).
- `GARDEN_DECOR_KEYS`, `GARDEN_GIFT_KEYS` e `GARDEN_TAKE_KEYS` são iguais a `DECOR_KEYS`, `GIFT_KEYS` e `TAKE_KEYS` de `garden.js` (teste).
- Conferido à mão que cada constante e função citada no texto da Fase 2 da seção 2 existe com o mesmo nome e valor em `garden.js` e `records.js`. Os três exemplos JSON novos passam `validateRecord` na seq 1, com `<hex64>` trocado por um hex64 minúsculo (rodado com `node -e` a partir de `packages/core`: `garden-decor null`, `garden-gift null`, `garden-take null`). O exemplo de presente e o de aceite caem num sábado (2026-01-03).

## Comandos rodados pelo executor (só os arquivos deste trecho)

Node 24.22.1, depois de `npm ci`:

- `npx standard packages/core/lib/records.js packages/core/test/records.test.js packages/core/test/garden.test.js`
  resultado: passou, sem saída.
- `npm test -w packages/core -- test/records.test.js test/garden.test.js`
  resultado: passou. `garden.test.js`: 18/18 testes, 302/302 asserções. `records.test.js`: 71/71 testes, 1906/1906 asserções.

## Landing CI

Node 24.22.1, sobre `origin/main` 7d47bbc4:

- `npm ci --ignore-scripts`: passou.
- `npm run lint`: passou.
- `npm test -- --affected=origin/main`: 879 arquivos, 877 passaram; `apps/site` pulado (não afetado). Dois arquivos que este PR não toca nem exercita esgotaram o tempo sob carga e passaram sozinhos: `packages/core/test/private-member-3.test.js` ("fake bans from an unadmitted writer never inflate a rotation" timed out after 30000 ms; sozinho, 37/37 asserções) e `apps/cli/test/update.test.js` (tempo esgotado; sozinho, 1952/1952 asserções).
- `npm run demo`: terminou com "DEMO OK".
