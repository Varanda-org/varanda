# feat/post-media-frames

Fotos e vídeos de uma publicação aparecem em um de três formatos (Retrato 4:5, Quadrado 1:1, Paisagem 16:9), escolhido pela primeira foto. Mídia distante do formato aparece inteira sobre uma cópia desfocada e escurecida. Nenhum formato de registro muda: a regra só lê largura e altura já guardadas.

## O que mudou aqui

- `apps/app/src/media/frame.js` (novo): a regra. Com r = largura / altura, r < 0,9 dá Retrato, r > 1,34 dá Paisagem e o resto (4:3 incluído, e tamanhos inválidos) dá Quadrado. Uma mídia preenche o formato (`cover`) quando min(r/R, R/r) >= 0,8; abaixo disso aparece inteira (`contain`).
- `apps/app/src/carousel.js`: `frameRatio` devolve 4/5, 1 ou 16/9 a partir da primeira mídia, no lugar do intervalo de 0,8 a 1,91.
- `apps/app/src/ui/MediaBackdrop.js` (novo) e `MediaView.js`: com `backdrop`, a foto em `contain` fica sobre uma cópia dela mesma desfocada (`blurRadius` 24) e escurecida, escondida dos leitores de tela e sem `pointerEvents`.
- `apps/app/src/ui/MediaGrid.js`: foto única, carrossel do feed, pôster de vídeo e pôster do `VideoTile` ficam no formato; `ratioOf` (0,5 a 2) saiu. O visualizador de tela cheia e o mosaico de duas a quatro fotos das citações não mudam.
- `apps/app/src/ui/MediaCarousel.js`: prop opcional `frame`; cada página escolhe `cover` ou `contain` e liga o fundo desfocado. Sem `frame`, vale `fit`.
- `apps/cli/lib/post-page.js`: na página pública `/p/` com uma mídia só, a foto ou a capa do vídeo usa as classes fixas `f45`, `f11` ou `f169`; em `contain`, uma cópia decorativa (`alt=""`, `aria-hidden="true"`) fica atrás. Largura e altura vêm de um registro não confiável: só são comparadas como inteiros de 1 a 16384 e nunca entram no HTML nem no CSS. Com duas a quatro fotos a grade quadrada continua.

## Testes rodados

Localmente, cada arquivo sozinho com `node <arquivo>`, mais `npm run lint` e `npm run demo`. A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

- `npm run lint`: passou.
- `npm run demo`: terminou com `DEMO OK`.
- Testes novos ou alterados: `mediaFrame` (6 testes, 169 asserções), `mediaBackdrop` (3, 19), `carousel` (16, 322), `feedRender` (18, 278), `apps/cli/test/post-page.test.js` (36, 2012). Todos passaram.
- Testes que leem os módulos alterados, todos passaram: `anuncioView`, `arrowLabel`, `chatMedia`, `conversaScreen`, `embedCoverView`, `escapeLayer`, `linkPreview`, `mediaAvatar`, `mediaFade`, `mediaFetch`, `mediaHash`, `mediaKeptLoad`, `muralGrid`, `musicEmbedCard`, `nodeHandle`, `platformGate`, `postActions`, `postClamp`, `postLayout`, `postLinkOpen`, `uiKit`, `videoPlayback`, `vitrineLarge` (em `apps/app/test`), `apps/cli/test/seeder-post-http.test.js`, `apps/cli/test/changelog.test.js` e `packages/core/test/seeder-post-public.test.js`.
- O novo teste de `feedRender` ("media sits in the post frame") falha no `MediaGrid.js` anterior, que ainda tem `ratioOf` e não passa `frame={ratio}`; o teste reescrito de `carousel` falha no `frameRatio` anterior (3:2 dava 1,5).

## Conferências humanas (não feitas)

Conferir no emulador Android, no simulador iOS e na web:

- [ ] Publicações antigas em 4:3, 3:4, captura 9:16, panorama e uma publicação sem tamanhos guardados.
- [ ] Uma foto antiga 4:3 num quadrado aparece inteira sobre a cópia desfocada (limite de `cover` em 0,8).
- [ ] Carrossel com formatos misturados mantém uma só altura ao deslizar.
- [ ] Foto em `contain` mostra a cópia desfocada e escurecida, sem borda dura, em cada plataforma (primeiro uso de `blurRadius`).
- [ ] Android: rolagem do feed fluida com várias publicações com fundo desfocado.
- [ ] Com o TalkBack, a exploração por toque ainda chega ao botão do pôster de vídeo.
- [ ] Um toque ainda abre a foto inteira.
- [ ] Pôster de vídeo e player em linha mantêm a mesma altura ao começar a tocar.
- [ ] Citação com uma foto e com várias.
- [ ] Detalhe de anúncio da Feira (`apps/app/src/screens/Anuncio.js` reutiliza `MediaGrid` e herda os formatos).
- [ ] Página pública `/p/` com uma foto 4:3, uma 3:4 e um vídeo, em claro e escuro.
