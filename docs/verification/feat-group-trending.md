# feat/group-trending

Rota `GET /index/group-browse/trending` no `apps/cli/lib/seed-ws.js` e a regra documentada em `docs/protocol.md` ("Index routes" e o item "Not implemented" da busca) e em `docs/design.md`.

## Testes (`apps/cli/test/seed-ws.test.js`)

- Rotas com stub: `/index/group-browse/trending` responde 200 com uma linha cujo `active` é 3, e o conjunto de chaves da linha é exato; a ordem chega ao semeador como `trending`.
- Caminhos malformados: `/index/group-browse/active`, `/index/group-browse/Trending` e `/index/group-browse/trending/x` continuam 404 e não chegam ao semeador.
- Semeador real: `/index/group-browse/trending` responde 200 com `groups` em lista.

## Falha sem a correção

Com a regex de volta a `(members|recent)`, o teste de rotas falha em `/index/group-browse/trending` (404 "não encontrado" em vez de JSON). Restaurada a regex, passa.

## Comandos

```sh
node apps/cli/test/seed-ws.test.js      # 109/109 testes, 2650/2650 asserções
node apps/cli/test/caddyfile.test.js    # 24/24 testes, 323/323 asserções
npx standard apps/cli/lib/seed-ws.js apps/cli/test/seed-ws.test.js   # limpo
npm run demo                            # DEMO OK
grep -n 'hidden weight' docs/protocol.md   # nenhuma linha
```
