# Playlists em alta no seletor de música (branch feat/music-trending-playlists)

Segundo PR de uma pilha de quatro, sobre `feat/music-trending-tracks`. O primeiro mostra as faixas em alta com a busca vazia; este faz o mesmo na aba Playlists. Os próximos acrescentam chips de gênero e recentes no aparelho.

## O que mudou

- [x] Serviço de conta, provider (`apps/cli/lib/account/audius-provider.js`): tipo `trendingPlaylists`, `GET /v1/playlists/trending` com `time=week` fixo e a página de `paging()`. Quem chama não escolhe período, gênero, tipo nem texto: chaves a mais nos parâmetros são ignoradas.
- [x] Serviço de conta, rota (`apps/cli/lib/account/audius-routes.js`): `POST /account/audius/trending` aceita `{}` ou `{ kind }`, com `kind` igual a `track` ou `playlist`; `{}` é `{ kind: "track" }` e responde como no PR 1. Outro valor ou outra chave é 400 `pedido-invalido` antes de qualquer contagem.
  - Uma lista por tipo, guardada na memória e nunca por membro, cada uma com as regras do PR 1: reaproveitada por até 10 min, uma só chamada ao Audius para pedidos simultâneos do mesmo tipo, e 1 min sem pedido novo depois de uma falha que chegou ao Audius, só para aquela lista.
  - Um só contador, `TRENDINGS_PER_DAY` (200), para os dois tipos, separado das buscas.
  - Playlists: até 12 itens `{ id, title, artist, count, url }`, com capa como na busca, nunca faixas, gênero nem ano (também com `?info=1`). O serviço pede 24 ao Audius e não pede as faixas de cada playlist; abrir uma delas pede as faixas como antes.
  - A capa de cada item vem da linha atual do item no cache, como no PR 1.
  - Uma lista vale até 10 min e nunca mais que as linhas do cache que lista: uma playlist já guardada com as faixas mantém a própria validade, e a lista termina junto com ela.
  - O registro continua `{ event: 'audius', reason: 'em-alta' }`, sem o tipo.
- [x] App, cliente (`apps/app/src/music.js`, `apps/app/src/account.js`): `trendingBody(kind)` monta `{}` para faixas e `{ kind: 'playlist' }` para playlists; outro tipo recusa com `pedido-invalido` sem abrir a sessão. Um 400 do serviço vira `pedido-invalido`.
- [x] App, seletor (`apps/app/src/ui/MusicPicker.js`): um estado de sugestões por aba (`useMusicSuggest`). A aba Playlists pede a lista na primeira vez que aparece com o campo vazio; trocar de aba, digitar e limpar reaproveitam a lista. Na aba Playlists, `pedido-invalido` (um serviço do nível do PR 1) deixa a aba sem sugestões e sem aviso. O seletor de momentos continua só com faixas.
- [x] Termos e Política na versão 95 (`packages/core/lib/terms.js`, `apps/app/src/legal.js`, páginas do site geradas com `node apps/site/scripts/render-legal.js`, linhas LGPD de `docs/design.md`): a lista de playlists da semana, não personalizada, o mesmo limite de 200 para as duas listas, as mesmas regras de memória e de espera, e as capas das playlists.
- [x] `docs/protocol.md` (corpo, as duas listas, limite único, espera por lista, o que chega ao Audius) e `docs/app.md` (seletor de post e de momento).

## Conferência ao vivo (18/11/2026, 15:39 UTC)

`GET https://api.audius.co/v1/playlists/trending?time=week&limit=24&offset=0&app_name=probe`, o mesmo pedido do serviço, sem chave: 200 em 807 ms, 24 playlists; o `fromPlaylist` do serviço aceitou 23 (sem repetidas), então a resposta enche as 12 da página. Cada playlist aceita tinha entre 14 e 23 faixas. Script em `liveprobe-p2.js` fora do repositório; nenhum teste usa a rede.

## Testes automáticos

Rodados localmente no Node 24, sobre `feat/music-trending-tracks` (`2c463f17`, que parte de `origin/main@16b61a19`) e de novo depois de juntar a branch de baixo com `origin/main@5fcf3d30`: `npm run lint`, `node apps/site/scripts/render-legal.js --check`, `npm run demo` (DEMO OK) e cada arquivo de teste que importa um módulo alterado, sozinho (64 arquivos, todos passando). Os principais:

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/cli/test/audius-routes.test.js` | 109 | 3497 |
| `apps/cli/test/audius-provider.test.js` | 16 | 352 |
| `apps/cli/test/audius-server.test.js` | 11 | 83 |
| `apps/app/test/musicPicker.test.js` | 74 | 739 |
| `apps/app/test/musicClient.test.js` | 60 | 615 |
| `apps/app/test/music.test.js` | 31 | 793 |
| `apps/app/test/legal.test.js` | 68 | 2012 |
| `apps/site/test/legal.test.js` | 7 | 115 |
| `packages/core/test/terms.test.js` | 8 | 126 |

Os outros são os testes do serviço de conta, das Páginas e do núcleo que leem a versão dos Termos ou o cliente de conta. A suíte inteira roda na CI do PR, nos Node 20 e 24.

Novos casos da rota: `{ kind }` aceito só com `track` ou `playlist` e recusado antes do limite, as duas listas guardadas à parte, uma só chamada por tipo para pedidos simultâneos, a espera de 1 minuto só na lista que falhou, o limite único de 200 para os dois tipos, playlists sem faixas, gênero nem ano, a capa da playlist lida da linha atual e a lista que termina com a linha da playlist que ela atualizou. Um teste do PR 1 recusava `{ "kind": "track" }`; agora esse corpo vale como `{}`, e o teste recusa `{ "kind": "album" }`. Do seletor: a aba Playlists pede a lista só quando aparece com o campo vazio, troca de aba e busca apagada reaproveitam as duas listas, e um serviço do nível do PR 1 deixa a aba quieta.

## Revisão

A revisão apontou e esta branch corrigiu:

- **Capa de uma playlist cuja linha com faixas expirou antes da lista.** Quando a playlist já estava no cache com as faixas, a lista em alta atualizava essa linha sem renovar a validade dela e guardava outra cópia por 10 minutos. Depois que a linha expirava, a resposta lia a marca de capa da cópia, e a rota da capa pedia a playlist de novo ao Audius. Agora uma lista vale no máximo até a validade das linhas que lista, e termina junto com a linha da playlist que atualizou. O teste `a playlist list lives no longer than a full playlist row it updated in place` falha sem a correção.

Conferido sem mudança: a espera de 1 minuto só é gravada numa falha que chegou ao Audius e nunca troca uma lista válida; nenhuma linha que pode lançar erro roda antes de a chamada da lista ser registrada para quem chega junto; o seletor descarta resposta atrasada pela geração. A auditoria de segurança não achou nada.

## Aparelhos

Não conferido em aparelho neste PR. Roteiro para a pessoa, primeiro no Android e no iOS, depois na web e no PWA, com uma conta de preview e `VARANDA_AUDIUS` ligado no serviço:

- [ ] Publicar, Música, aba Playlists: sem digitar, aparece "Em alta no Audius" com até 12 playlists, com o número de faixas.
- [ ] Tocar numa playlist sugerida abre o editor como numa playlist buscada.
- [ ] Voltar para Faixas e de novo para Playlists: as duas listas voltam sem pedido novo.
- [ ] Digitar e apagar o texto na aba Playlists: a lista volta sem pedido novo.
- [ ] Momento com música: só faixas, sem aba Playlists.
- [ ] Serviço do nível do PR 1: a aba Playlists fica vazia, sem aviso, e a busca funciona.
- [ ] Sem rede: o aviso de erro e "Tentar de novo" na aba Playlists.

## Limites

- Se a abertura da sessão de música responder `pedido-invalido`, a aba Playlists também fica sem aviso, porque o app não distingue esse caso da resposta de um serviço antigo.

## Fora do alcance desta branch

- Chips de gênero (PR `feat/music-trending-genres`), recentes e gênero favorito (PR `feat/music-recents-genre`).
- Termos 95 seguem a revisão jurídica pendente das versões anteriores.
