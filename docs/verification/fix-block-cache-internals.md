# fix/block-cache-internals: o cache de blocos falha fechado

Parte do #353 (item do PR #404).

## O que mudou

`evictOnClear` (`packages/web-member/lib/node-store.js`) dependia de internos privados do Hypercore 10.38.2 (`core.core`, `state.clear`, `state.bitfield.get`, a lista de sessões e `core.cache`). Se algum faltasse ou mudasse de forma (numa atualização do Hypercore), o núcleo ficava com o cache de blocos ligado e sem evicção, e um bloco apagado podia voltar da memória.

Agora `holdsEvictionContract` confere a forma dos internos antes de embrulhar (isso pega internos ausentes; mudança de comportamento é coberta pelo teste de versão). Se algo falta, `disableBlockCache` põe `cache = null` na raiz e em cada sessão já aberta. Uma `session()` sem opção `cache` herda o `null` da raiz (`index.js` do Hypercore: `s.cache = opts.cache === true || !opts.cache ? this.cache : opts.cache`). `session({ cache: true })` criaria um cache novo (index.js:324); o node-store não faz isso. O caminho normal não mudou. `evictOnClear` passou a ser exportada para os testes.

## Testes (`packages/web-member/test/delete-purge.test.js`)

- `a core whose Hypercore internals are missing loses its block cache, sessions included`: sem `core.core`, sem `state.clear`, sem `bitfield.get`, lista de sessões inválida e cache sem `delete`; raiz, sessões abertas e sessão posterior ficam sem cache.
- `a real store core keeps its block cache and a wrapped clear`.
- `tripwire: the Hypercore web-member resolves is the version whose internals evictOnClear wraps`: falha se a versão resolvida não for 10.38.2.

## Falha sem a correção

Com o `node-store.js` original (só exportando `evictOnClear`), o primeiro teste falha: `no per-files state: the root has no cache` (o valor atual é o objeto de cache, o esperado é `null`), e o mesmo para os demais casos. Com a correção, 36/36 testes e 246/246 asserções passam.

## Comandos

```sh
npm ci --ignore-scripts
npx standard packages/web-member/lib/node-store.js packages/web-member/test/delete-purge.test.js
node packages/web-member/test/delete-purge.test.js
npm run lint
npm test -- --affected=origin/main
npm run demo
```

No Node 24, lint e demo (`DEMO OK`) passaram. No `npm test`, 17 de 771 arquivos estouraram o tempo com a máquina carregada por suítes de outras branches (arquivos de rede de `packages/core`, que esta branch não alcança, e de `packages/web-member`). Cada um passou rodando sozinho (`VARANDA_TEST_CONCURRENCY=1 node <arquivo>`), 17 de 17.

## Não rodado

Node 20 só na CI. Sem entrada de changelog: não há mudança visível.
