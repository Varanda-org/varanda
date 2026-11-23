# feat/standalone-group-nodes

Grupos sem comunidade (grupos avulsos) no contrato RPC. O formato no protocolo é o do PR `feat/standalone-group-protocol` (`docs/protocol.md` seção 10, "Standalone groups").

## O que mudou no contrato

- `packages/rpc/lib/methods.js`: `group.create` passa a ter `community` opcional (ausente = grupo avulso; `null` explícito continua inválido). `group.join` ganha `standalone` opcional (booleano), recusado junto com `community` (`'parâmetro inválido: standalone'`). Método novo, só de leitura, `group.standalone` (`offset`, `limit`, como `group.list`).
- `docs/rpc.md`: 5.36, 5.37, 5.39, 5.41, 5.42, 5.48, 5.49, 5.61, 5.71, 5.82, 5.171 e 5.174 explicam o grupo sem comunidade; seção nova 5.176 `group.standalone`, também na lista de leituras da sessão do navegador.

## Testes

- `packages/rpc/test/methods.test.js`: `group.standalone` na lista fixa de métodos; `group.create` sem `community` passa; `group.join standalone flag` e `group.standalone` (parâmetros e padrões).
- `packages/rpc/test/sizes.test.js`: `group.standalone: GROUP_LIMIT_MAX rows with maximal names and images fit` (26 linhas no pior caso: 69760 bytes, abaixo de `MAX_MESSAGE`).

## Comandos

```sh
npx standard packages/rpc/lib/methods.js packages/rpc/test/methods.test.js packages/rpc/test/sizes.test.js
node packages/rpc/test/methods.test.js
node packages/rpc/test/sizes.test.js
```

## Nós, Páginas, CLI e ponta a ponta

- Documentos: `docs/rpc.md` 5.36, 5.37, 5.39, 5.41, 5.42, 5.48, 5.49, 5.59 (linhas do catálogo e `general`), 5.61, 5.62 (`general`), 5.71, 5.82, 5.171, 5.174 e 5.176; `docs/protocol.md` seção 10, "Standalone groups": a regra do catálogo nos nós ("Catalogues give no authority") e o item "CLI", além da cópia da ajuda.
- Nó do core: `packages/core/test/group-member-standalone.test.js`, `session-groups.test.js`, `community-member.test.js`.
- Nó do navegador: `packages/web-member/test/group-standalone-ops.test.js`, `community-ops.test.js`, `session-groups.test.js`, `device-upkeep-ops.test.js`, e o teste ponta a ponta entre os dois nós `standalone-e2e.test.js`.
- Páginas: `apps/cli/test/pages-groups.test.js` e `account-pages-groups.test.js`. As asserções de recusa de entrada (T11) fixam um comportamento que a base já tinha; só as de leitura, tópicos e saída são guardas novas.
- CLI: `apps/cli/test/cli.test.js` (ajuda e `--standalone`), `group-commands.test.js` (criar sem `--community`, `join --standalone`, recusa de `--standalone` com `--community` e fora de `group join`, `comunidade: nenhuma`) e `readme-help.test.js`. Mutação: sem a recusa de `--standalone` fora de `join`, `group-commands.test.js` falha (3/4 testes, 108/116 asserções).

Cada arquivo rodado sozinho com `node <arquivo>`:

| Arquivo | Testes | Asserções |
|---|---|---|
| apps/cli/test/group-commands.test.js | 4 | 116 |
| apps/cli/test/cli.test.js | 11 | 1428 |
| apps/cli/test/readme-help.test.js | 1 | 2 |
| apps/cli/test/pages-groups.test.js | 9 | 201 |
| apps/cli/test/account-pages-groups.test.js | 1 | 64 |
| packages/rpc/test/methods.test.js | 180 | 8433 |
| packages/rpc/test/sizes.test.js | 43 | 433 |
| packages/core/test/group-member-standalone.test.js | 14 | 133 |
| packages/core/test/community-member-leave-5.test.js | 10 | 86 |
| packages/core/test/session-groups.test.js | 20 | 719 |
| packages/core/test/community-member.test.js | 27 | 287 |
| packages/web-member/test/group-standalone-ops.test.js | 19 | 138 |
| packages/web-member/test/group-memo.test.js | 12 | 65 |
| packages/web-member/test/community-ops.test.js | 80 | 628 |
| packages/web-member/test/session-groups.test.js | 26 | 257 |
| packages/web-member/test/device-upkeep-ops.test.js | 31 | 214 |
| packages/web-member/test/standalone-e2e.test.js | 2 | 79 |

Todos passaram, os dos nós já com as correções da revisão (Geral ou grupo de catálogo cujo root guardado não nomeia a comunidade, linha pendente de um escritor que nomeia outro membro, ordem das recusas do navegador) e com a correção de segurança abaixo.

Correção de segurança (auditoria): um escritor pendente próprio cujo cabeçalho nomeia outro membro (uma dica `standalone` ou `community` que a raiz contradiz, ou um catálogo que nomeia como Geral o grupo de outra comunidade), e que o fold não conta, deixava o aparelho preso em `limite do grupo atingido` quando a pessoa já era membro por outro aparelho. Agora `group.join` encerra esse escritor (saída e corte) e escreve um novo que nomeia o membro certo, nos dois nós. Testes de dois aparelhos em `group-member-standalone.test.js` e `group-standalone-ops.test.js`; sem a regra nova, os dois falham com `limite do grupo atingido`. O escritor trocado é cortado no comprimento que o aparelho guarda (`retiredWriterCut`), nunca em 0, então as publicações que ele tinha continuam valendo; um teste por nó fixa o corte em 2 para um escritor com uma publicação, e falha com o corte antigo. `group-memo.test.js` confirma que um segundo `community.list` no navegador não decodifica nenhum bloco (a checagem da raiz guardada usa o fold memorizado). `community-member-leave-5.test.js` passa a esperar que o catálogo não liste um grupo cuja raiz guardada nomeia outra comunidade.

```sh
npx standard apps/cli/lib/cli.js apps/cli/lib/commands/group.js apps/cli/test/cli.test.js apps/cli/test/group-commands.test.js
node apps/cli/test/group-commands.test.js
node apps/cli/test/cli.test.js
node apps/cli/test/readme-help.test.js
node packages/core/test/group-member-standalone.test.js
node packages/web-member/test/standalone-e2e.test.js
```

