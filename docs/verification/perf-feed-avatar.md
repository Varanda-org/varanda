# Foto do autor em cada item do feed (branch perf/feed-avatar, parte da #353)

Decisão do dono (Rodrigo, 16/11/2026, "Foto no item do feed"): todo `FeedItem` devolvido por `feed.read` traz o `avatar` do autor, tirado do mesmo perfil válido mais novo de onde `buildFeed` já lê o `name`. A Rua começa a carregar as fotos com a primeira leitura, sem esperar o `profile.read` em lote (espera de 1 s e fila de partida do nó). É o mesmo dado que `profile.read` já devolve, então os Termos não mudam.

## O que mudou

- `packages/core/lib/feed.js`: cada item (publicação e republicação) traz `avatar`, uma cópia do descritor do perfil mais novo, ou `null` quando esse perfil é simples ou não há perfil. Uma republicação segue o nome: traz a foto de quem republica. Um perfil mais novo e simples dá `null`, nunca a foto antiga. `buildFeed` é usado por `feed.read` (nó do navegador, nó de núcleo e `varanda-serve`) e por `page.feed`, então todos ganham o campo; `peek.read` já tinha `avatar` e segue com o dele (janela buscada).
- `packages/rpc/lib/limits.js`: com o avatar mais largo (235 bytes mais a chave) em cada item, 26 itens no pior caso passam de `MAX_MESSAGE`: 267.682 bytes. `FEED_LIMIT_DEFAULT` e `FEED_LIMIT_MAX` passam de 26 para 25 (25 itens: 258.174 bytes; 26: 267.682, acima de 262.144). `PEEK_LIMIT_*` ficam em 26, agora como constantes próprias (247.858 bytes, não mudou). Pior caso de `page.feed` com 25 itens: 237.773 bytes. Com caracteres de 4 bytes, 26 itens: 211.522 bytes.
- `docs/rpc.md` (tabela de limites, seção 2, 5.13, 5.22, `page.feed`, mapa de limites) e `docs/protocol.md` ("FeedItem") atualizados. Um nó antigo omite `avatar`: o app lê a chave ausente como "não sei", nunca como "sem foto".
- `apps/app/src/feedSeeds.js` (novo, puro): o que um item ensina ao cache de nomes. Só passa `avatar` quando o item tem a chave própria, e `avatar: null` ao lado de `name: null` não diz nada (o diário pode estar baixando e o perfil ainda não chegou). `ARua.js` usa `feedSeeds` nos dois pontos que ensinavam nomes a partir de itens.
- `ARua.js`: a A Rua principal semeia nome e foto; a de uma Página (`page.feed`) semeia só o nome (`feedSeeds(items, { avatar: false })`), porque `page.feed` empresta o perfil do início do diário quando a ponta não tem perfil, e a foto pode ser antiga. O `docs/rpc.md` 5.13 registra a exceção.
- `feedSnapshot.js`: já aceitava `avatar` num item. Os limites de leitura (`PARSE_ROWS`, 26) ficam no valor antigo para que um instantâneo salvo antes ainda seja lido; ao salvar, continua o máximo de `FEED_LIMIT_DEFAULT` (25) linhas.
- `apps/app/src/vitrine/request.js`: o `feed.read` de demonstração segue o nó e traz em cada item o `avatar` do perfil de demonstração do autor (hoje `null` em todos). `apps/app/test/vitrine.test.js` confere a chave e a paginação com ela.

## Testes

- `packages/core/test/feed.test.js`: `every item carries the avatar of the newest valid profile, the one its name comes from` (foto do perfil mais novo, cópia por item, foto antiga trocada por uma nova, perfil simples mais novo dá `null`, sem perfil dá `null`, republicação, avatar inválido ignorado, um por autor); o teste do oráculo (`buildFeed returns the same bytes as the per-walker oracle`) agora inclui `avatar` e um perfil com foto; os testes de formato de item ganharam `avatar: null`.
- `packages/rpc/test/sizes.test.js`: `feed.read: FEED_LIMIT_MAX fits, one more does not`, `peek.read: PEEK_LIMIT_MAX fits`, `page.feed: maximal media lists fit the shared feed limit` e o teste de vídeo (limites de página) com o avatar mais largo em cada FeedItem. `packages/rpc/test/methods.test.js`: padrão 25.
- `apps/app/test/feedSnapshot.test.js`: `a snapshot saved with 26 rows (before feed items carried avatar) still parses`. `packages/web-member/test/e2e-media.test.js`: o teste do avatar agora confere que um `feed.read` real traz o `avatar` em cada item do autor.
- `apps/app/test/feedSeeds.test.js`: `avatar: false` e `PageARua never seeds an avatar`; item com avatar, item de nó antigo, `null` com e sem nome, pares por autor, passagem pelo `applySeed` do cache de nomes (nó antigo não apaga foto conhecida) e uso nos dois pontos de A Rua.

### Falha sem a correção

Com `packages/core/lib/feed.js` voltado ao original, `node packages/core/test/feed.test.js`: `tests = 34/41 pass`, falham os testes 26, 27, 30, 32, 36, 39 (oráculo) e 41 (`every item carries the avatar ...`). Restaurado: `41/41`.

## Comandos

```sh
node packages/core/test/feed.test.js
node packages/rpc/test/sizes.test.js
node packages/rpc/test/methods.test.js
node apps/app/test/feedSeeds.test.js
node apps/app/test/feedSnapshot.test.js
node packages/web-member/test/e2e-media.test.js
node apps/app/test/vitrine.test.js
node packages/web-member/test/page-feed.test.js
node packages/web-member/test/e2e-social.test.js
```

Na raiz, no Node 24: `npm run lint` e `npm run demo` (`DEMO OK`) passaram. No `npm test -- --affected=origin/main`, 44 de 797 arquivos estouraram o tempo com a máquina carregada por suítes de outras branches (arquivos de rede de `packages/core` e de `apps/cli`, que não leem o feed). Cada um passou rodando sozinho (`VARANDA_TEST_CONCURRENCY=1 node <arquivo>`); `group-member-3` e `private-member-3` precisaram de mais de uma tentativa e também estouraram o tempo numa worktree sem esta mudança, com o mesmo tempo de execução. Node 20 só na CI.

## Verificação em aparelho

Ordem: Android (build de debug), simulador iOS, depois web e PWA. Registrar aparelho, sistema e navegador.

Feito em 16/11/2026 com os dados de demonstração (`EXPO_PUBLIC_VARANDA_VITRINE=1`, Metro na porta 8106), que não têm fotos: confere que A Rua continua abrindo com nomes, iniciais, o cartão de evento e a enquete, sem erro, com `avatar` em cada item.

- Android, emulador API 36 (`varanda-api36-parity`), build de debug `app.varanda.debug`: A Rua abre na primeira partida e depois de fechar e abrir de novo (abertura, depois A Rua).
- iOS, simulador iPhone 17 Pro, iOS 26.2: A Rua abre igual.
- Web, navegador do app Claude (Chromium), `localhost:8106`: A Rua abre igual, sem erro no console ligado ao feed.

O que exige seguidos com foto fica no checklist da #224:

- [ ] A Rua com seguidos que têm foto: as fotos dos autores aparecem logo com a primeira leitura do feed, antes de qualquer `profile.read` em lote (conferir no registro de rede que as fotos vêm sem esperar a leitura de perfis). Android, iOS, web, PWA: pendente.
- [ ] Um autor que tirou a foto (perfil simples mais novo): a linha mostra as iniciais, não a foto antiga.
- [ ] Nó antigo sem `avatar` nos itens (ou um item de instantâneo antigo): as fotos já conhecidas continuam; não viram iniciais.
- [ ] Rolar até o fim de A Rua: a página de 25 itens carrega as seguintes sem pular nem repetir itens (cursor `before`).
- [ ] Páginas (`page.feed`): linhas de Páginas mostram a foto do autor como antes.
