# Gêneros nas faixas em alta do seletor de música (branch feat/music-trending-genres)

Terceiro PR de uma pilha de quatro, sobre `feat/music-trending-playlists`. Os dois primeiros mostram as faixas e as playlists em alta com a busca vazia; este acrescenta chips de gênero na aba Faixas. O próximo acrescenta recentes no aparelho e o gênero mais usado.

## O que mudou

- [x] Lista de gêneros (`packages/rpc/lib/music-genres.js`, exportada em `packages/rpc/index.js`, descrita em `docs/rpc.md`): `MUSIC_GENRES`, 24 nomes exatos como o Audius os escreve, congelada, e `isMusicGenre`, que compara a string exata (sem caixa, sem espaço a mais, sem texto composto). Ficam fora Devotional, Kids, Podcasts, Audiobooks, Spoken Word e Comedy.
- [x] Serviço de conta, provider (`apps/cli/lib/account/audius-provider.js`): `trendingTracks` leva `genre` só quando `isMusicGenre` aceita; outro valor faz o pedido nulo. `trendingPlaylists` com qualquer gênero também é nulo.
- [x] Serviço de conta, rota (`apps/cli/lib/account/audius-routes.js`): `POST /account/audius/trending` aceita `{}`, `{ kind }`, `{ genre }` e `{ kind: "track", genre }`. Um gênero fora da lista, vazio, `null`, que não é texto, ou junto de `kind: "playlist"` é 400 `pedido-invalido` antes de qualquer contagem, chamada ao Audius ou entrada na memória.
  - Uma lista por gênero, com a chave `track:<gênero>`, igual para todos e nunca por membro, cada uma com as regras dos PRs 1 e 2 (reaproveitada por até 10 min, uma só chamada para pedidos simultâneos, 1 min de espera só para a lista que falhou).
  - No máximo 26 listas na memória (as duas gerais mais os 24 gêneros), de no máximo 12 linhas cada, sem descarte; `MAX_TRENDING_LISTS` e um teste fixam o número.
  - Custo no Audius enquanto as listas dão certo: cerca de 144 renovações por dia por lista de faixas (a de playlists pode renovar antes) e 3744 para as 26 com a validade cheia (31% de `PROVIDER_PER_DAY`, 12000), uma estimativa, não um teto. Cada contato continua cobrado de quem pediu, no limite diário de chamadas e no orçamento por membro.
  - Um só contador, `TRENDINGS_PER_DAY` (200), para as listas gerais e todos os gêneros. O registro continua `{ event: 'audius', reason: 'em-alta' }`, sem o gênero, e `stats()` não mudou.
  - Uma faixa da lista de um gênero nunca é descartada pelo próprio texto de gênero, que o Audius pode dar composto ou diferente.
- [x] App, cliente (`apps/app/src/music.js`, `apps/app/src/account.js`): `MUSIC_GENRE_ALL_TEXT` ("Todos"), `MUSIC_GENRE_LABELS` em pt-BR, `musicGenreChips(order)` e `trendingBody(kind, genre)`, que põe o gênero só no corpo do POST e recusa um gênero fora da lista ou junto de playlists sem abrir a sessão.
- [x] App, seletor (`apps/app/src/ui/MusicPicker.js`): chips de gênero (`FilterChips`) acima da lista na aba Faixas do seletor de post e de momento, com o campo vazio. Cada troca de chip faz um pedido e descarta a resposta atrasada da seleção anterior; tocar no chip já selecionado não pede de novo. Digitar esconde os chips; limpar o campo traz de volta a seleção e a lista. Um `pedido-invalido` num pedido com gênero (um serviço do nível do PR 2) esconde os chips e pede a lista geral uma vez.
- [x] Termos e Política na versão 96 (`packages/core/lib/terms.js`, `apps/app/src/legal.js`, páginas do site geradas com `node apps/site/scripts/render-legal.js`, linhas LGPD de `docs/design.md`): o gênero tocado vai ao serviço com o nome em inglês e com a sessão; o serviço não grava qual gênero cada conta pediu; a lista de cada gênero fica só na memória e é igual para todos; o limite de 200 soma todas as listas; o gênero pode sair do Brasil como o texto da busca.
- [x] `docs/protocol.md` (formas do corpo, a lista por referência, uma lista por gênero, o limite de 26, o custo, o que chega ao Audius) e `docs/app.md` (chips no seletor de post e de momento, serviço antigo).

## Conferência ao vivo (18/11/2026, 17:17 UTC)

`GET https://api.audius.co/v1/tracks/trending?time=week&limit=24&offset=0&genre=<nome>&app_name=probe`, o mesmo pedido do serviço, sem chave, um gênero por vez:

| Gênero | Status | Tempo | Devolvidas | Aceitas por `fromTrack` | Com esse gênero exato |
|---|---|---|---|---|---|
| Jazz | 200 | 576 ms | 24 | 24 | 24 |
| Drum & Bass | 200 | 520 ms | 24 | 24 | 24 |
| Hip-Hop/Rap | 200 | 517 ms | 24 | 23 | 23 |
| Electronic | 200 | 477 ms | 24 | 24 | 24 |

Antes do plano, os 24 nomes da lista foram conferidos um a um (18/11/2026): todos responderam 200 com faixas daquele gênero exato. O Audius filtra pela string exata e aceita qualquer texto (`pop` e `Hip-Hop` dão 0 faixas), por isso a lista fixa é a única barreira. Script em `liveprobe-p3.js` fora do repositório; nenhum teste usa a rede.

## Testes automáticos

Rodados localmente no Node 24, sobre `feat/music-trending-playlists` (`000ed57e`) e de novo depois de juntar a pilha com `origin/main@5fcf3d30`: `npm run lint`, `node apps/site/scripts/render-legal.js --check`, `npm run demo` (DEMO OK) e cada arquivo de teste que importa um módulo alterado, sozinho (91 arquivos, todos passando). Os principais:

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/cli/test/audius-routes.test.js` | 118 | 3734 |
| `apps/cli/test/audius-provider.test.js` | 18 | 402 |
| `apps/cli/test/audius-server.test.js` | 11 | 83 |
| `apps/app/test/musicPicker.test.js` | 79 | 830 |
| `apps/app/test/musicClient.test.js` | 62 | 623 |
| `apps/app/test/music.test.js` | 32 | 836 |
| `apps/app/test/legal.test.js` | 69 | 2030 |
| `apps/site/test/legal.test.js` | 7 | 115 |
| `packages/core/test/terms.test.js` | 8 | 126 |
| `packages/rpc/test/music-genres.test.js` | 7 | 196 |

Os outros são os testes do serviço de conta, das Páginas, do núcleo e de `@varanda/rpc` que leem a versão dos Termos, o cliente de conta ou o pacote. A suíte inteira roda na CI do PR, nos Node 20 e 24.

Novos casos: da lista (nomes exatos e na ordem, congelada, comparação exata, nomes de fora que continuam fora); do provider (`genre` só com um nome da lista, codificado uma vez; playlists sem gênero); da rota (gênero fora da lista, junto de `kind: "playlist"` ou com chave a mais é recusado antes de qualquer contador, chamada ao Audius ou lista; uma lista por gênero para todos os membros, separada das outras e da geral; a espera depois de falha só na lista que falhou; nenhum gênero nem membro em linha de log ou em `stats()`, num acerto, numa falta, numa falha e num pedido que chega junto; no máximo `MAX_TRENDING_LISTS` listas; o limite de 200 somado entre gêneros e tipos, com o 201º pedido em 429 sem chamada ao Audius; a capa de uma faixa da lista de um gênero); do cliente (`musicGenreChips`, `trendingBody`, o gênero só no corpo, nenhuma sessão aberta para um pedido inválido, o 400 de um serviço antigo); do seletor (um pedido por troca de chip, a resposta atrasada descartada, o chip selecionado mantido na busca e na troca de aba, o serviço antigo que esconde os chips e pede a lista geral uma vez, e o toque no chip já selecionado, que não para a prévia nem pede lista).

## Revisão

A revisão apontou e esta branch corrigiu:

- **Toque no chip já selecionado parava a prévia.** O seletor parava a prévia antes de olhar o chip, e o chip já selecionado (Todos, no começo) também chama a troca: a prévia que tocava parava e o tíquete guardado se perdia, então a próxima prévia pedia outro. Agora o toque no chip selecionado não faz nada. O teste `reselecting a track chip preserves playback and its ticket` falha sem a correção.
- **Textos que prometiam mais do que o código.** Os Termos e a Política na versão 96 e `docs/design.md` diziam que todo pedido de lista conta no limite diário; um pedido que falha não conta, e o texto agora diz isso. `docs/design.md` dizia que a lista de cada gênero fica na memória por até 10 minutos; ela vale por até 10 minutos, mas só sai da memória quando é pedida de novo ou o serviço reinicia. `docs/protocol.md` apresentava 144 renovações por dia por lista como teto; é uma estimativa, e a lista de playlists pode renovar antes.

Conferido sem mudança: um gênero só vira chave de lista depois de passar pela lista fixa, antes de qualquer contador; o tipo, e não a chave da lista, escolhe o pedido ao Audius e a leitura do cache; nenhum log nem `stats()` leva o gênero ou o membro. A auditoria de segurança não achou nada que bloqueie.

## Aparelhos

Não conferido em aparelho neste PR. Roteiro para a pessoa, primeiro no Android e no iOS, depois na web e no PWA, com uma conta de preview e `VARANDA_AUDIUS` ligado no serviço:

- [ ] Publicar, Música, aba Faixas: sem digitar, aparecem os chips com **Todos** selecionado e "Em alta no Audius" com a lista geral.
- [ ] Tocar em Jazz: a lista troca para faixas de jazz; tocar em Jazz de novo não muda nada; tocar em Todos volta à geral.
- [ ] Os chips rolam na horizontal e cabem na tela estreita sem cortar o texto.
- [ ] Digitar esconde os chips; apagar o texto traz de volta o chip selecionado e a lista dele.
- [ ] Aba Playlists: sem chips.
- [ ] Momento com música: os chips aparecem como no post.
- [ ] Serviço do nível do PR 2: os chips somem depois do primeiro toque num gênero e a lista geral aparece.
- [ ] Sem rede: o aviso de erro e "Tentar de novo" com um gênero selecionado.

## Limites

- Cada toque num gênero diferente é um pedido e conta no limite diário de 200 listas, salvo quando falha.
- O nome do gênero é o do Audius. Funk, por exemplo, é o funk do Audius, não o funk brasileiro.
- A lista de cada gênero é compartilhada por até 10 minutos, então quem pede um gênero pouco depois de outra pessoa recebe a resposta mais rápido. O serviço não sabe dizer quem pediu antes. A lista geral já funcionava assim.

## Fora do alcance desta branch

- Recentes no aparelho, ordem dos chips pelo uso e gênero mais usado pedido ao abrir (PR `feat/music-recents-genre`).
- Termos 96 seguem a revisão jurídica pendente das versões anteriores.
