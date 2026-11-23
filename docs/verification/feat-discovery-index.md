# Descoberta de grupos sem comunidade e de comunidades no índice

Este PR fica sobre `feat/standalone-group-protocol` e acrescenta ao índice do semeador as listas de descoberta de grupos sem comunidade e de comunidades, e quatro rotas HTTP novas em `/index/discover/*`. Um grupo cuja raiz nomeia uma comunidade (a Geral incluída) não aparece em nenhuma delas, diga o que disser um catálogo. As rotas antigas (`/index/group-search`, `/index/group-browse/<ordem>` e `/index/public-groups/<D>`) continuam com o mesmo caminho e a mesma resposta. A subseção "Standalone and community discovery" e as quatro rotas estão em "Index routes" de `docs/protocol.md`.

## Regra de lançamento

Implantar este PR e `feat/standalone-group-protocol` nos semeadores antes de publicar qualquer app que leia `/index/discover/*`. Um app novo diante de um semeador antigo recebe o 404 genérico nessas rotas e esconde as listas; nada quebra.

## Arquivos de teste

Cada arquivo roda sozinho com `node <arquivo>`.

| Tarefa | Arquivo | O que cobre |
|---|---|---|
| T6 | `packages/core/test/group-index-discover.test.js` | as listas do índice: nenhum grupo de comunidade, órfão ou privado em nenhuma lista; um catálogo que nomeia uma raiz sem comunidade não a esconde nem a anexa; uma comunidade renomeada é achada pelo nome novo; filtros, entrada por aprovação e regras de grupo privado; ordem, limites e cursor |
| T8 | `packages/core/test/seeder-discover.test.js` | as respostas do semeador numa DHT local: só grupos sem comunidade e comunidades, sem grupo de comunidade, grupo privado ou raiz não vinculada pelo criador; uma entrada forjada de catálogo na posição da Geral não esconde nem anexa a raiz sem comunidade; raízes guardadas de um criador que saiu daqui continuam listadas com ele e somem quando ele é bloqueado; uma raiz com varredura atrasada ou com lacuna fica fora de `trending` e da lista por pessoa com `complete: false`; bloqueio do grupo, da comunidade ou do criador tira a linha; enquanto o índice da pessoa está pendente, a lista por pessoa vem vazia com `complete: false` |
| T12 | `apps/cli/test/seed-ws.test.js` | as quatro rotas (testes `startSeedWs /index/discover/*`), descritos abaixo |

Testes novos em `apps/cli/test/seed-ws.test.js`:

- "each route answers its exact wire shape; the legacy bodies are unchanged": cada rota e cada ordem devolvem exatamente as chaves de `docs/protocol.md` (o `members` do semeador vira `writerCount` nas linhas de grupo), uma chave a mais na resposta do semeador nunca sai, o cursor chega ao semeador, HEAD manda só os cabeçalhos, e as respostas de `/index/group-browse/members`, `/index/public-groups/<D>` e `/index/group-search/jardim` continuam as mesmas.
- "malformed paths never reach the seeder": ordem desconhecida (inclusive `trending` em comunidades), segmento malformado, chave ou cursor malformado, barra a mais e query string são o 404 genérico sem chamar o semeador; Host estranho é 421 e outro método é 405.
- "a hidden answer, a stray cursor, a malformed row, a throw or a missing method never leak; worst-case bodies fit": `hidden: true` não manda linha nem cursor; um `next` que não é a chave da última linha (ou que vem sem linha) é 404; `groups` que não é lista, linha com chave, criador, nome, contagem, `created` (negativo ou não inteiro) ou `active` (negativo, fracionário ou texto) malformados, nome vazio ou com mais de 80 pontos de código em qualquer lista (um nome de 80 emojis, 160 unidades UTF-16, passa), `join` de comunidade fora de `open` e `approval` (inclusive `null`), linha repetida ou linha além do limite (20 grupos, 20 comunidades, 20 de cada lista da busca, 32 por pessoa) é 404; uma exceção é 404 sem eco; um semeador sem os métodos (semeador antigo) é 404; o pior caso de cada rota, com nomes de 80 substitutos isolados, fica dentro de `INDEX_MAX_BODY`.
- "the real Seeder lists the standalone group and the community, never the community's group": o `Seeder` de verdade, pelas rotas, lista o grupo sem comunidade e a comunidade, e não lista o grupo da comunidade nem na busca.

## Verificações executadas

| Comando | Resultado |
|---|---|
| `node apps/cli/test/seed-ws.test.js` | 119 testes e 3029 asserções passaram |
| `node packages/core/test/group-index-discover.test.js` | 5 testes e 82 asserções passaram |
| `node packages/core/test/seeder-discover.test.js` | 3 testes e 86 asserções passaram |
| `npx standard apps/cli/lib/seed-ws.js apps/cli/test/seed-ws.test.js` | Saiu com código 0 |
| `npx standard packages/core/lib/group-index.js packages/core/lib/seeder.js` | Saiu com código 0 |

Cada verificação de `apps/cli/lib/seed-ws.js` foi retirada uma de cada vez (checagem de linha repetida, reconstrução campo a campo, guarda de `hidden`, a ordem `trending` recusada em comunidades, limite de linhas, cursor recusado em vez de anulado, checagem do criador, data negativa, `active` sem checagem, `join` desconhecido virando `null`, nome checado só pelo tipo, nome contado em unidades UTF-16) e pelo menos um teste falhou em cada caso; com o código de volta, todos passaram.

## Verificações pendentes

- A suíte completa, `npm run lint` e `npm run demo` rodam na entrega e na CI do GitHub deste PR.
- Depois da implantação, num semeador, conferir `curl -s https://<semeador>/index/discover/groups/members` e `curl -s https://<semeador>/index/discover/communities/recent`: respostas JSON com as chaves acima, e `/index/discover/communities/trending` com 404.
