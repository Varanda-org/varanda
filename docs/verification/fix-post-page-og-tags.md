# Prévia de link das publicações públicas (`/p/`)

Branch `fix/post-page-og-tags`. A página pública de uma publicação (`apps/cli/lib/post-page.js`) trazia só `og:type`, `og:title`, `og:description` e, quando havia uma foto que não fosse AVIF, `og:image` e `og:image:type`. Uma publicação só de texto, ou só com fotos AVIF, aparecia no WhatsApp como um link sem imagem.

## O que mudou

- O cabeçalho ganha `<meta name="description">`, `og:site_name` `Varanda` e `og:locale` `pt_BR` sempre, e, quando a origem das publicações é https, `og:url`, um único `og:image` com `og:image:type`, `og:image:alt` e, quando o tamanho é conhecido, `og:image:width` e `og:image:height`, e `twitter:card` `summary_large_image`.
- A imagem continua sendo a primeira foto que não é AVIF (`/p/<D>/<seq>/foto/<n>`), com o tamanho do descritor só quando largura e altura são inteiros de 1 a 16384. Sem essa foto, a imagem é o cartão da marca, `<origem>/og/convite.png` (PNG 1200 por 630, texto alternativo `Varanda`), o mesmo do cartão neutro de convite do serviço de conta.
- Sem origem https, nem `og:url` nem `og:image`, como antes. O corpo da página, a página de reserva e `postPreviewData` não mudam.
- `docs/protocol.md`, seção 16, "What the page shows and never shows", descreve o conjunto de tags e a imagem de reserva.

## Como verificar

A partir da raiz:

- `node apps/cli/test/post-page.test.js`: 31 testes, 1444 asserções. Publicação só de texto e só com AVIF dão `og:image` em `/og/convite.png` com `image/png`, 1200 e 630; AVIF seguida de JPEG continua em `/foto/2` com tipo e tamanho; origem http ou hostil não dá `og:image` nem `og:url`; nome e texto hostis continuam escapados nas tags novas; sempre um só `og:image`, e as imagens do corpo continuam em `/foto`.
- `node apps/cli/test/seeder-post-http.test.js`: 4 testes, 312 asserções, sobre um semeador de verdade.
- `node packages/core/test/seeder-post-public.test.js`: 4 testes, 69 asserções.
- `npx standard apps/cli/lib/post-page.js apps/cli/test/post-page.test.js apps/cli/test/seeder-post-http.test.js`
- Com o renderizador antigo, `post-page.test.js` falha em 6 testes e `seeder-post-http.test.js` em 1.

No servidor de testes (staging), com uma publicação compartilhada só de texto e outra com foto, a fazer depois do deploy:

```sh
curl -s -A 'WhatsApp/2.23.20.0 A' https://<staging>/p/<D>/<seq> | grep -E '<meta (name|property)="(description|og:|twitter:)'
curl -sI -A 'WhatsApp/2.23.20.0 A' https://<staging>/og/convite.png
curl -s https://<staging>/robots.txt
```

- [ ] A primeira mostra `og:url`, um só `og:image` e, na publicação só de texto, `og:image` em `/og/convite.png` com `image/png`, `1200` e `630`.
- [ ] A segunda responde 200 com `Content-Type: image/png`.
- [ ] A terceira lista `Allow: /og/` antes de `Disallow: /`.
- [ ] Colar o link numa conversa do WhatsApp mostra o cartão grande com a imagem.

## Fora desta mudança

- Não rodou: o `curl` contra o staging, a prévia num mensageiro de verdade e a suíte inteira (`npm test`), que roda na CI do PR.
- O cartão `/og/convite.png` vem do app (`apps/app/public/og`), servido pelo handle do app no `deploy/seeder/Caddyfile`. Esta mudança também libera `/og/` no `robots.txt`, para que o mensageiro possa buscar o cartão.
