# feat/post-share-cover

## App: capa da prévia ao publicar na web

### O que mudou

- `apps/app/src/postShare.js`: `readShared` devolve `cover` (falso quando um nó antigo não manda), `addCover` faz um só `post.cover` (5.168), e `sendCover` prepara a capa (`shareCover.js` `buildCover`), envia a mídia uma vez e grava uma vez. Qualquer recusa, inclusive `'método desconhecido'` de um nó antigo, vira "sem capa".
- `apps/app/src/postShareCompose.js`: `shareNew` aceita a capa e só a tenta depois que o `post.share` respondeu `on`; o resultado é sempre o do compartilhamento. `heldStill` escolhe os bytes que o rascunho ainda tem da primeira foto ou da capa do vídeo.
- `apps/app/src/pageShare.js` e `apps/app/src/pages.js`: ação `post-cover` (`{ seq, image }`), `coveredState` (`covered` ausente = desconhecido, sem botão), `coverAsPage`, `pagesPostCover`, `pagesUploadEncoded`.
- `apps/app/src/screens/Publicar.js`: com a caixa marcada e o nó hospedado (`node.hosted`), a pessoa e a Página enviam a capa depois do compartilhamento, também na segunda tentativa manual de uma Página e no compartilhamento tardio depois de um envio incerto.
- `apps/app/src/ui/PostShareSheet.js`: botão "Adicionar uma capa à prévia" para publicação já na web, sem capa, que precisa de capa. Só o toque escreve; depois da tentativa o botão sai até a folha abrir de novo.
- `apps/app/src/vitrine/request.js`: `post.cover` e `cover` em `post.shared`.

### Testes

```sh
node apps/app/test/postShare.test.js
node apps/app/test/postShareCompose.test.js
node apps/app/test/pageShare.test.js
node apps/app/test/shareCover.test.js
node apps/app/test/vitrine.test.js
node apps/app/test/pages.test.js
node apps/app/test/platformGate.test.js
```

## Registro, nós e serviço de conta

### O que mudou

- `packages/core/lib/records.js`: registro `post-cover` `{ type, seq, image, at }`, só JPEG (até 1200 px, 8 blocos, 262144 bytes), `foldCover` / `newestCover` e `shownMedia` contando a capa como um avatar.
- `packages/core/lib/seeder.js`: o semeador dobra as capas, conta a mídia delas (inclusive na recontagem forçada) e `postPublic` devolve `{ cover, coverSeq }`, conferidos de novo depois de cada espera.
- `packages/web-member/lib/member-ops.js` e `session.js`: `post.cover` (5.168), `cover` em `post.shared`; tirar da web e apagar a publicação apagam as capas, as mais antigas primeiro, com as lápides da própria publicação sempre num só append; um apagamento parcial conta e envia o que escreveu.
- `packages/core/lib/member.js`: `post.delete` do nó do core apaga as capas no espaço que sobra no append (até 8 registros), as mais antigas primeiro; uma repetição termina as que sobraram.
- `apps/cli/lib/account/pages-routes.js` e `pages-writer.js`: ação `'post-cover'`, `covered` no `status`, e `'post-unshare'`, `'delete'` e `close` apagam as capas.
- `packages/rpc`: `post.cover` em `methods.js`, limites da capa em `limits.js`.

### Testes

```sh
node packages/core/test/records.test.js
node packages/core/test/post-share.test.js
node packages/core/test/deletion.test.js
node packages/core/test/member.test.js
node packages/core/test/page-proof.test.js
node packages/core/test/session-post-share.test.js
node packages/core/test/seeder-post-public.test.js
node packages/core/test/seeder-post-page.test.js
node packages/rpc/test/methods.test.js
node packages/web-member/test/post-share.test.js
node packages/web-member/test/delete.test.js
node apps/cli/test/pages-share.test.js
```

## Semeador: `/capa` e `og:image`

### O que mudou

- `apps/cli/lib/seed-ws.js`: rota `/p/<diário>/<seq>/capa`. Serve só a capa viva de uma publicação compartilhada, depois de conferir o descritor, o tipo `image/jpeg` e o quadro (`stillImageSize` igual aos lados do descritor), e confere de novo o compartilhamento e a capa depois da leitura. Toda falta responde o mesmo 404.
- `apps/cli/lib/post-page.js`: `og:image` aponta para `/capa` quando há capa, antes da primeira foto que não é AVIF e do cartão da marca.

### Testes

```sh
node apps/cli/test/post-page.test.js
node apps/cli/test/seeder-post-http.test.js
```

### Conferência num semeador (a fazer, depois da implantação)

- [ ] Semeador com `VARANDA_POSTS_ORIGIN`: compartilhar uma publicação só com fotos AVIF a partir de um app que grava `post-cover`. `curl -sI https://<origem>/p/<D>/<seq>/capa` responde 200, `image/jpeg`, `Content-Length` exato e `no-store`. A página, buscada com o User-Agent de um mensageiro, mostra `og:image` em `/capa`, `image/jpeg` e os lados da capa.
- [ ] Colar o link no WhatsApp: a prévia mostra a capa.
- [ ] Tirar da web (ou apagar a publicação): `/capa` responde 404 `não encontrado`, e a página responde 302.
- [ ] Uma publicação compartilhada sem capa continua com a primeira foto que não é AVIF, ou com `/og/convite.png`.
- [ ] Um semeador de antes desta mudança responde 404 em `/capa`, e a página mostra a imagem de antes.

## Ordem de implantação

1. Semeador (serve `/capa` e lê `post-cover`).
2. Serviço de conta (ação `post-cover`, `covered` no `status`).
3. App.

Um app novo com um serviço antigo recebe `pedido-invalido` na ação `post-cover` e trata como sem capa; um serviço antigo não manda `covered`, e a folha não mostra o botão.

## Conferência em aparelho (a fazer)

Primeiro no build de debug do Android e no simulador iOS, depois na web.

- [ ] Sonda de AVIF: `encodeThumbnail(<amostra AVIF de packages/rpc/test/helpers/avif-samples.js>, 'image/avif', { side: 1200, maxBytes: 204800 })` no build de debug do Android. Resultado (null ou JPEG): _não rodado_.
- [ ] A mesma sonda no simulador iOS. Resultado: _não rodado_.
- [ ] A mesma sonda num navegador de computador. Resultado: _não rodado_.
- [ ] Android: publicar uma foto com "Publicar também na web", buscar `/p/<chave>/<seq>` com o User-Agent de um mensageiro (por exemplo `WhatsApp/2.23.20.0`): `og:image` aponta para `/capa`, e `/capa` responde JPEG com menos de 262144 bytes.
- [ ] iOS simulador: o mesmo.
- [ ] Web: o mesmo.
- [ ] Publicação antiga já na web, sem capa: a folha "Página pública na web" mostra "Adicionar uma capa à prévia"; o toque grava a capa, e a página passa a apontar para `/capa`.
- [ ] Num aparelho que não decodifica o AVIF guardado: o toque não escreve nada e mostra "Não foi possível preparar a capa neste aparelho.".
- [ ] Sem rede no toque (ou com a foto guardada sem chegar em 30 segundos): nada é escrito, aparece "Não foi possível baixar a foto. Tente de novo." e o botão continua na folha.
- [ ] O mesmo fluxo agindo como uma Página (ação `post-cover`).
- [ ] "Tirar da web": `/capa` passa a responder 404.

## O que não rodou

- Nenhuma conferência em aparelho, simulador ou navegador nesta etapa (emuladores e builds nativos ficam com a orquestração).
- `npm test`, `npm run demo` e o lint do repositório inteiro.
