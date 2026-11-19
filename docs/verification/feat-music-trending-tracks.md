# Músicas em alta no seletor de música (branch feat/music-trending-tracks)

Primeiro PR de uma pilha de quatro. O pedido: "Quando vai fazer post na hora de colocar música já podia ter algumas recomendadas". Este PR mostra a lista em alta da semana no Audius quando a busca está vazia. Os próximos acrescentam playlists em alta, chips de gênero e recentes no aparelho.

## O que mudou

- [x] Serviço de conta, provider (`apps/cli/lib/account/audius-provider.js`): tipo `trendingTracks`, `GET /v1/tracks/trending` com `time=week` fixo e a página de `paging()`. Quem chama não escolhe período, gênero nem texto: chaves a mais nos parâmetros são ignoradas.
- [x] Serviço de conta, rota (`apps/cli/lib/account/audius-routes.js`): `POST /account/audius/trending` com bearer e corpo exatamente `{}`, resposta `{ items, next: null }` com até `PAGE_SIZE` (12) faixas, capa e gênero/ano como na busca (`?covers=1`, `?info=1`).
  - Uma só lista para todos os membros, só na memória, sem chave de membro: reaproveitada por até `CACHE_TTL_MS` (10 min); pedidos simultâneos esperam a mesma chamada ao Audius, paga por quem a começou.
  - Depois de uma falha que chegou ao Audius (status de erro, resposta que não é JSON, prazo, rede, forma inválida), nenhum pedido novo por `TRENDING_RETRY_MS` (1 min): a rota responde 503 `indisponivel` e devolve o uso. Recusas antes do contato (`limite`, `lotado`, orçamento) não começam essa espera.
  - Um 4xx do Audius também responde 503 e devolve o uso: o pedido é do serviço, não da pessoa.
  - Limite próprio de `TRENDINGS_PER_DAY` (200) aberturas por conta por dia, separado das 200 buscas. Pede `TRENDING_ASK` (24) ao Audius porque `fromTrack` descarta faixas bloqueadas ou fora da lista.
  - O único registro é `{ event: 'audius', reason: 'em-alta' }`.
- [x] App, cliente (`apps/app/src/account.js`): `audiusTrending()` faz o POST com `{}`, lê a resposta com `parseMusicSearch` e recusa uma resposta com `next`. `feature-off` e `nao-encontrado` (serviço antigo) viram o texto de música indisponível.
- [x] App, seletor (`apps/app/src/ui/MusicPicker.js`, textos em `apps/app/src/music.js`): com a busca vazia na aba de faixas, mostra "Em alta no Audius" e a lista, ou "Nenhuma sugestão agora" se ela vier vazia. Uma falha mostra o erro e "Tentar de novo"; o serviço desligado ou antigo deixa o seletor quieto. A busca não abre mais o teclado sozinha. Uma troca de sessão descarta a lista e pede de novo. Estado num reducer próprio (`musicSuggestStep`) em que toda ação parte de `{ ...state }`, para o gênero do PR 3 sobreviver.
- [x] Termos e Política na versão 94 (`packages/core/lib/terms.js`, `apps/app/src/legal.js`, páginas do site geradas com `node apps/site/scripts/render-legal.js`, linhas LGPD de `docs/design.md`): a lista da semana, não personalizada; o limite próprio de 200; o que o Audius recebe (período, posição, tamanho, nome do app e chave do operador); os 10 min de reaproveitamento, 1 min de espera depois de falha e a lista apagada ao reiniciar.
- [x] `docs/protocol.md` (rota, limites, erros do provider, o que chega ao Audius, registro `em-alta`) e `docs/app.md` (seletor de post e de momento).

## Conferência ao vivo (18/11/2026, 15:01 UTC)

`GET https://api.audius.co/v1/tracks/trending?time=week&limit=24&offset=0&app_name=probe`, o mesmo pedido do serviço, sem chave: 200 em 646 ms, 24 faixas; o `fromTrack` do serviço aceitou 23 (sem repetidas), então a resposta enche as 12 da página. Gêneros na lista dessa hora: 11 Electronic, o resto eletrônico também (Techno, Trance, Dubstep, Drum & Bass, Trap e outros). Script em `liveprobe-p1.js` fora do repositório; nenhum teste usa a rede.

## Testes automáticos

Rodados localmente no Node 24, sobre `origin/main@16b61a19` e de novo depois de juntar `origin/main@5fcf3d30`: `npm run lint`, `node apps/site/scripts/render-legal.js --check`, `npm run demo` (DEMO OK) e cada arquivo de teste que importa um módulo alterado, sozinho (64 arquivos, todos passando). Os principais:

| Arquivo | Testes | Asserções |
|---|---|---|
| `apps/cli/test/audius-routes.test.js` | 97 | 3232 |
| `apps/cli/test/audius-provider.test.js` | 16 | 340 |
| `apps/cli/test/audius-server.test.js` | 11 | 83 |
| `apps/app/test/musicPicker.test.js` | 71 | 696 |
| `apps/app/test/musicClient.test.js` | 56 | 601 |
| `apps/app/test/music.test.js` | 30 | 788 |
| `apps/app/test/legal.test.js` | 67 | 2001 |
| `apps/site/test/legal.test.js` | 7 | 115 |
| `packages/core/test/terms.test.js` | 8 | 126 |

Os outros são os testes do serviço de conta, das Páginas e do núcleo que leem a versão dos Termos ou o cliente de conta. A suíte inteira roda na CI do PR, nos Node 20 e 24.

Novos casos da rota: lista reaproveitada por até 10 minutos, uma só chamada para pedidos simultâneos, quem espera uma chamada que falhou recebe 503 com o uso de volta (nunca 429), espera de 1 minuto só depois de contato com o Audius, 4xx do Audius como 503, limite próprio de 200 separado das buscas, corpo diferente de `{}` recusado antes do limite, registro só com `em-alta`, e a capa lida da linha atual da faixa. Do seletor: sugestões só com a busca vazia na aba de faixas, troca de sessão descarta a lista, resposta atrasada descartada, `feature-off`/`nao-encontrado` quietos e as outras falhas com "Tentar de novo". O teste antigo do foco automático agora espera `autoFocus` desligado.

## Revisão

A revisão apontou e esta branch corrigiu:

- **Capa de uma faixa que uma busca posterior trocou.** A lista em alta guardada lia a marca de capa da linha antiga da faixa, e a rota da capa lê a linha atual. Agora a resposta lê a linha atual de cada faixa, como a resposta de playlist em cache. O teste `a trending hit reads each cover flag from the track row a later search replaced` falha sem a correção.
- **Termos 94 diziam "ao abrir a escolha de música".** A lista só aparece com o campo de busca vazio na aba de faixas; o texto dos Termos, da Privacidade e da base legal diz isso agora. A frase de retenção passou a dizer que o serviço conta, na memória, quantas vezes cada conta abriu a lista no dia (o limite de 200).
- **`docs/app.md` prometia silêncio para `feature-off` em qualquer etapa.** Só a resposta `feature-off` ou `nao-encontrado` da própria rota da lista deixa o seletor quieto; uma falha ao abrir a sessão de música aparece como as outras. Sem mudança de código: o seletor só aparece com a música disponível (`audiusPolicy`), então o caso pede o recurso desligado entre a leitura da política e a primeira sessão.

Conferido sem mudança: a chamada ao Audius só começa uma vez para pedidos simultâneos (`trendingLoad` é atribuído antes do primeiro `await` e limpo no `finally` da própria chamada); as recusas antes do contato não começam a espera de 1 minuto; uma resposta atrasada do seletor é descartada pela geração e pelo `AbortController`. A auditoria de segurança não achou nada.

## Aparelhos

Não conferido em aparelho neste PR. Roteiro para a pessoa, primeiro no Android e no iOS, depois na web e no PWA, com uma conta de preview e `VARANDA_AUDIUS` ligado no serviço:

- [ ] Publicar, Música: sem digitar, aparece "Em alta no Audius" com até 12 faixas e capas; o teclado não abre sozinho.
- [ ] Tocar numa sugestão abre o editor do trecho como numa faixa buscada; voltar mostra a lista de novo.
- [ ] Digitar mostra a busca; apagar o texto volta às sugestões sem pedido novo (a mesma lista).
- [ ] Aba de playlists: sem sugestões neste PR.
- [ ] Momento com música: o mesmo seletor mostra as sugestões.
- [ ] Serviço sem a rota (versão anterior): o seletor fica como antes, sem aviso.
- [ ] Sem rede: o aviso de erro e "Tentar de novo".

## Fora do alcance desta branch

- Playlists em alta (PR `feat/music-trending-playlists`), chips de gênero (PR `feat/music-trending-genres`), recentes e gênero favorito (PR `feat/music-recents-genre`).
- Termos 94 seguem a revisão jurídica pendente das versões anteriores.
