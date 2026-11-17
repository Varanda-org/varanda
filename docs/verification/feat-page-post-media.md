# Publicações da Página com vídeo e prévia (branch feat/page-post-media)

## O que mudou

- `apps/cli/lib/account/pages-routes.js`: `post`, `reply` e `quote` aceitam `media` (fotos, ou o par capa JPEG e `video/mp4`) e `preview` (cartão de link), nunca os dois (`pedido-invalido`). A imagem da prévia é um item da própria Página. `url`, `title` e `desc` passam pela lista de termos (`termo-recusado`). O envio `POST /account/pages/media` aceita `video/mp4` com `ms` (só nesse tipo), conferido com `videoBounds` estrito, e recusa um vídeo cujos metadados ainda não foram removidos (`stripVideoMetadata(bytes)` tem de ser igual aos bytes). O item guardado conserva `ms`. Apagar a publicação e encerrar a página cobrem `preview.image`.
- `apps/cli/lib/account/pages-writer.js`: `validItem`, a carga e `sameItem` aceitam o item de vídeo com `ms`, então um reinício não pausa a página.
- `apps/app/src/pages.js`, `pagePost.js` e `videoCompose.js`: a Página publica, responde e cita com o mesmo par de vídeo e a mesma prévia que uma pessoa.
- `apps/app/src/screens/Publicar.js`, `musicDraft.js`: como Página, a tela Publicar anexa vídeo, prévia de link e música. Um título ou artista de música com termo bloqueado mostra o aviso antes de enviar. Momento, enquete, evento, publicar na web e a fila offline continuam só para a pessoa (próximos PRs).
- `apps/app/src/legal.js`: Termos e Política versão 79, com novo aceite. As publicações da página aceitam um vídeo curto, e o diário da página inclui vídeos e imagens de prévias de links.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node apps/cli/test/pages-media.test.js
node apps/cli/test/account-pages.test.js
node apps/cli/test/pages-writer.test.js
node apps/app/test/pagePost.test.js
node apps/app/test/pages.test.js
node apps/app/test/videoCompose.test.js
node apps/app/test/legal.test.js
```

Casos fixados: um vídeo sem `ms` é recusado com `midia-invalida` e não grava registro nem item; um `video/mp4` com `ms` válido é guardado com `ms`; bytes de imagem com MIME de vídeo continuam recusados; mídia e prévia juntas são `pedido-invalido`.

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA.

- [ ] Como Página, publicar um vídeo. Pendente.
- [ ] Publicar com prévia de link. Pendente.
- [ ] Publicar como Página com uma música (cartão de música). Pendente.
- [ ] Responder e citar com vídeo. Pendente.
- [ ] O seguidor vê igual ao post de uma pessoa. Pendente.
- [ ] Apagar a publicação apaga a imagem da prévia. Pendente.
- [ ] Reiniciar o serviço não pausa a página. Pendente.

## Não verificado / limites conhecidos

- Não conferido em aparelho.
- Apagar um item de mídia que publicações ainda vivas continuam mostrando não foi conferido.
